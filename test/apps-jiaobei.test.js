// 「掷杯筊」测试：三象映射与概率、SVG 图案随结果变化、400×300 卡片渲染，
// 以及「网页掷杯 / 设备确认键掷杯」两条链路（MockDevice 离线）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { createServer } from '../src/server.js';
import { KEY, ACTION } from '../src/packet.js';
import { FACES, OUTCOMES, throwJiaobei } from '../apps/jiaobei/outcomes.js';
import { buildJiaobeiSvg, renderJiaobei } from '../apps/jiaobei/render.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 8000, step = 80) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(step);
  }
}

test('杯象：两块的朝向组合出圣筊 / 笑筊 / 阴筊', () => {
  // 随机源 0.1 → 平面朝上，0.9 → 凸面朝上
  assert.equal(throwJiaobei(() => 0.1).name, '笑筊');
  assert.equal(throwJiaobei(() => 0.9).name, '阴筊');
  const seq = [0.1, 0.9];
  let i = 0;
  assert.equal(throwJiaobei(() => seq[i++]).name, '圣筊');

  assert.deepEqual(OUTCOMES.sheng.faces, [FACES.CONVEX, FACES.FLAT]);
  assert.deepEqual(OUTCOMES.xiao.faces, [FACES.FLAT, FACES.FLAT]);
  assert.deepEqual(OUTCOMES.yin.faces, [FACES.CONVEX, FACES.CONVEX]);
});

test('概率：圣筊约 1/2，笑筊与阴筊各约 1/4', () => {
  // 固定 LCG，结果可复现，不会因为随机波动偶发失败
  let seed = 20261024;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const counts = { sheng: 0, xiao: 0, yin: 0 };
  const total = 20000;
  for (let i = 0; i < total; i++) counts[throwJiaobei(rand).key] += 1;

  const ratio = (key) => counts[key] / total;
  assert.ok(Math.abs(ratio('sheng') - 0.5) < 0.03, `圣筊比例 ${ratio('sheng')}`);
  assert.ok(Math.abs(ratio('xiao') - 0.25) < 0.03, `笑筊比例 ${ratio('xiao')}`);
  assert.ok(Math.abs(ratio('yin') - 0.25) < 0.03, `阴筊比例 ${ratio('yin')}`);
});

test('SVG：圣筊一凸一平，笑筊双平，阴筊双凸，未掷时画虚线静置态', () => {
  const sheng = buildJiaobeiSvg(OUTCOMES.sheng);
  const xiao = buildJiaobeiSvg(OUTCOMES.xiao);
  const yin = buildJiaobeiSvg(OUTCOMES.yin);
  const ghost = buildJiaobeiSvg(null);

  assert.equal(new Set([sheng, xiao, yin, ghost]).size, 4, '四种状态图案应各不相同');
  // 月牙形：凸面朝上是拱背的黑色月牙（筊角点地），平面朝上是凹面朝天的白色月牙（筊角翘起）
  assert.ok(sheng.includes('M8 66 C8 36 30 10 60 10'));
  assert.ok(sheng.includes('M8 12 C10 44 30 72 60 72'));
  assert.equal(sheng.split('M8 66 C8 36 30 10 60 10').length - 1, 1);
  assert.equal(sheng.split('M8 12 C10 44 30 72 60 72').length - 1, 1);
  assert.equal(xiao.split('M8 12 C10 44 30 72 60 72').length - 1, 2);
  assert.equal(yin.split('M8 66 C8 36 30 10 60 10').length - 1, 2);
  // 一黑一白：凸面实心黑拱背，平面是干净的白色凹面月牙，单色屏上一眼区分
  assert.ok(yin.includes('fill="#000000" stroke="#000000"'));
  assert.ok(!sheng.includes('<ellipse'), '平面朝上的月牙开口是干净的，不应再画阴影');
  assert.ok(ghost.includes('stroke-dasharray'));
  assert.ok(sheng.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  // 视框从 y=0 起含住±7° 旋转出界的筊角，图案顶端不再被裁平
  assert.ok(sheng.includes('viewBox="0 0 320 80"'));
  // 外轮廓加粗到 3.6，墨水屏上要一眼认得出
  assert.ok(sheng.includes('stroke-width="3.6"'));
});

test('渲染：输出 400×300 灰阶 PNG，三种结果与未掷态都有内容', async () => {
  for (const outcome of [OUTCOMES.sheng, OUTCOMES.xiao, OUTCOMES.yin, null]) {
    const png = await renderJiaobei(outcome, { throws: outcome ? 3 : 0 });
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);
    const stats = await sharp(png).stats();
    assert.ok(stats.channels[0].mean < 250, `图像应有内容，mean=${stats.channels[0].mean}`);
    assert.ok(png.length > 2000, `PNG 体积异常: ${png.length}`);
  }
});

test('Web 接口：掷杯、推送与设备确认键（离线 MockDevice）', { timeout: 40000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-jiaobei-'));
  const app = createServer({
    device: `127.0.0.1:${port}`,
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'config.json'),
    auth: false,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = () => fetch(`${base}/apps/jiaobei/api/state`).then((r) => r.json());

  try {
    const list = await (await fetch(`${base}/api/apps`)).json();
    assert.ok(list.apps.some((item) => item.id === 'jiaobei'), '应用列表应包含 jiaobei');

    const first = await state();
    assert.equal(first.ok, true);
    assert.equal(first.outcome, null, '打开时还没掷过');
    assert.equal(first.throws, 0);
    assert.equal(first.active, false, '没有网页接管时不应响应设备按键');

    const preview = await fetch(`${base}/apps/jiaobei/api/preview.png`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await preview.arrayBuffer());
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);

    // 只掷不推设备：结果必须出来，设备不应收到图片
    const local = await fetch(`${base}/apps/jiaobei/api/throw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: false }),
    }).then((r) => r.json());
    assert.equal(local.ok, true);
    assert.ok(local.outcome?.name, '应掷出一个结果');
    assert.equal(local.pushed, false);
    assert.equal(local.throws, 1);
    assert.equal(device.images.size, 0, '未开启推送时设备不应收到图片');

    // 掷杯并推送：设备应收到分片
    const pushed = await fetch(`${base}/apps/jiaobei/api/throw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: true }),
    }).then((r) => r.json());
    assert.equal(pushed.ok, true);
    assert.equal(pushed.pushed, true, JSON.stringify(pushed));
    assert.equal(pushed.throws, 2);
    assert.ok(await waitFor(() => device.images.size >= 1), '设备应收到图片');

    // 没有接管时，确认键不应抢别的应用的按键
    const beforeArm = await state();
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    await sleep(400);
    assert.equal((await state()).throws, beforeArm.throws, '未接管时确认键不应掷杯');

    // 网页接管后，设备确认键掷杯并推送
    const armed = await fetch(`${base}/apps/jiaobei/api/arm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    }).then((r) => r.json());
    assert.equal(armed.ok, true);
    assert.equal(armed.active, true);

    const beforeKey = await state();
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    const afterKey = await waitFor(async () => {
      const current = await state();
      return current.throws >= beforeKey.throws + 1 ? current : null;
    });
    assert.ok(afterKey, '确认键应触发掷杯');
    assert.ok(afterKey.outcome?.name);
    assert.ok(await waitFor(() => device.images.size >= 2), '确认键掷杯后设备应再收到一张图');

    // 只推当前杯象
    const again = await fetch(`${base}/apps/jiaobei/api/push`, { method: 'POST' }).then((r) => r.json());
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.outcome.name, afterKey.outcome.name);
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    device.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
