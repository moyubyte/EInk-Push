// 设置层单元测试：地址规整、落盘容错、原子写入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeDevice, loadSettings, saveSettings, deviceWithPort } from '../src/settings.js';

async function tmpFile(name = 'config.json') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zectrix-set-'));
  return { dir, file: path.join(dir, name) };
}

test('设备地址规整：补默认端口、剥协议头与路径、容忍空白', () => {
  assert.equal(normalizeDevice('192.168.1.100'), '192.168.1.100');
  assert.equal(normalizeDevice('  192.168.1.100:32342  '), '192.168.1.100:32342');
  assert.equal(normalizeDevice('zectrix-note4.local'), 'zectrix-note4.local');
  assert.equal(normalizeDevice('http://192.168.1.100:8080/'), '192.168.1.100:8080');
  assert.equal(normalizeDevice('http://192.168.1.100/api?x=1'), '192.168.1.100');
  // 结尾多一个冒号（手输/自动填充常见）按默认端口处理，不当作错误
  assert.equal(normalizeDevice('192.168.1.100:'), '192.168.1.100');
  assert.equal(deviceWithPort('192.168.1.100'), '192.168.1.100:32342');
  assert.equal(deviceWithPort('192.168.1.100:9999'), '192.168.1.100:9999');
  assert.equal(deviceWithPort(null), null);
});

test('设备地址校验：非法输入必须抛错而不是静默放过', () => {
  const bad = [
    '', '   ', null, undefined, 42, {},
    '192.168.1.100:0', '192.168.1.100:65536', '192.168.1.100:99999',
    '192.168.1.100:abc', '192.168.1.100:-1',
    '[::1]:32342', 'fe80::1', 'a b', 'http://', '-host', 'host-',
    `${'a'.repeat(254)}`,
  ];
  for (const value of bad) {
    assert.throws(() => normalizeDevice(value), undefined, `应拒绝 ${JSON.stringify(value)}`);
  }
});

test('设置文件不存在时返回未配置，而不是抛错', async () => {
  const { file } = await tmpFile();
  const settings = await loadSettings(file);
  assert.deepEqual(settings, { device: null, font: null, passwordHash: null });
});

test('设置文件损坏时退回未配置（下次保存即可修复）', async () => {
  const { file } = await tmpFile();
  await fs.writeFile(file, '{ this is not json');
  assert.deepEqual(await loadSettings(file), { device: null, font: null, passwordHash: null });
  await fs.writeFile(file, JSON.stringify({ device: 'not a valid host!!' }));
  assert.deepEqual(await loadSettings(file), { device: null, font: null, passwordHash: null });
});

test('保存后可原样读回，且不留下临时文件', async () => {
  const { dir, file } = await tmpFile();
  await saveSettings(file, { device: '192.168.1.50:32342' });
  assert.deepEqual(await loadSettings(file), { device: '192.168.1.50:32342', font: null, passwordHash: null });
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(raw.updatedAt, '应记录更新时间');
  const files = await fs.readdir(dir);
  assert.deepEqual(files, ['config.json'], `不应残留临时文件，实际 ${files.join(',')}`);
});

test('字体选择随设置一起落盘', async () => {
  const { file } = await tmpFile();
  await saveSettings(file, { device: 'a.local', font: 'wenkai' });
  assert.deepEqual(await loadSettings(file), { device: 'a.local', font: 'wenkai', passwordHash: null });
});

test('密码哈希随设置一起落盘，非法哈希按未设置处理', async () => {
  const { file } = await tmpFile();
  const passwordHash = 'a'.repeat(64);
  await saveSettings(file, { device: 'a.local', passwordHash });
  assert.deepEqual(await loadSettings(file), { device: 'a.local', font: null, passwordHash });
  await saveSettings(file, { device: 'a.local', passwordHash: 'not-a-hash' });
  assert.equal((await loadSettings(file)).passwordHash, null);
});

test('保存会覆盖旧值，目录不存在时自动创建', async () => {
  const { dir } = await tmpFile();
  const file = path.join(dir, 'nested', 'deep', 'config.json');
  await saveSettings(file, { device: 'a.local' });
  await saveSettings(file, { device: 'b.local' });
  assert.deepEqual(await loadSettings(file), { device: 'b.local', font: null, passwordHash: null });
});
