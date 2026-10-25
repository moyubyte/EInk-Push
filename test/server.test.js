// Web 层测试：参数校验、事件去重、录音落盘与下载、关闭时释放设备。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { createServer } from '../src/server.js';
import { OpusCodec } from '../src/audio.js';
import { T } from '../src/packet.js';
import { FORMAT } from '../src/image.js';

const png = () =>
  sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .png()
    .toBuffer();

async function boot(options = {}) {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zectrix-rec-'));
  const app = createServer({
    device: `127.0.0.1:${port}`,
    recordingsDir: dir,
    settingsFile: path.join(dir, 'config.json'),
    auth: false, // 鉴权由 auth.test.js 单独覆盖，其余用例专注协议与接口
    ...options,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { device, port, app, server, base, dir };
}

async function teardown(ctx) {
  await ctx.app.locals.shutdown().catch(() => {});
  await new Promise((resolve) => ctx.server.close(resolve));
  ctx.device.stop();
  await fs.rm(ctx.dir, { recursive: true, force: true });
}

async function waitFor(fn, timeout = 4000, step = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

test('非法 format 直接 400，且不会为此建立设备连接', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.base}/api/show?format=gray42`, { method: 'POST', body: await png() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /format/);
    assert.equal(ctx.device._lastClientPort, undefined, '非法参数不应触发握手');
  } finally {
    await teardown(ctx);
  }
});

test('推送位深：不指定走设备最优（GRAY16），显式指定按原值下发', { timeout: 20000 }, async () => {
  const ctx = await boot();
  const begins = [];
  ctx.device._onPacket = (p) => { if (p.kind === T.IMAGE_BEGIN) begins.push(p.body[0]); };
  try {
    // 不指定位深 → 设备支持的最高画质，而不是默认 mono
    await fetch(`${ctx.base}/api/show`, { method: 'POST', body: await png() });
    assert.deepEqual(begins, [FORMAT.GRAY16], '缺省 format 应推 GRAY16');
    await fetch(`${ctx.base}/api/show?format=gray16`, { method: 'POST', body: await png() });
    await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: await png() });
    assert.deepEqual(begins.slice(1), [FORMAT.GRAY16, FORMAT.MONO], '显式位深按原值下发');
  } finally {
    await teardown(ctx);
  }
});

test('非法 volume 返回 400，合法值按原值下发', { timeout: 20000 }, async () => {
  const ctx = await boot();
  const volumes = [];
  ctx.device._onPacket = (p) => { if (p.kind === 8) volumes.push(p.body[0]); };
  try {
    for (const v of ['abc', '-1', '101', '']) {
      const res = await fetch(`${ctx.base}/api/play?volume=${v}`, { method: 'POST', body: Buffer.alloc(1920) });
      assert.equal(res.status, 400, `volume=${v} 应被拒绝`);
    }
    const pcm = Buffer.from(new Int16Array(960).fill(1500).buffer);
    const ok = await fetch(`${ctx.base}/api/play?volume=73`, { method: 'POST', body: pcm });
    assert.equal(ok.status, 200);
    assert.equal(volumes[0], 73, '音量应原样传给设备');
  } finally {
    await teardown(ctx);
  }
});

test('一次按键只入库一条事件', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: await png() });
    ctx.device.sendKey(3, 1);
    const events = await waitFor(async () => {
      const data = await (await fetch(`${ctx.base}/api/history`)).json();
      return data.events.filter((e) => e.type === 'key').length ? data.events : null;
    });
    assert.ok(events, '应收到按键事件');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = await (await fetch(`${ctx.base}/api/history`)).json();
    assert.equal(again.events.filter((e) => e.type === 'key').length, 1);
  } finally {
    await teardown(ctx);
  }
});

test('录音落盘为 WAV 并可下载', { timeout: 20000 }, async () => {
  const ctx = await boot();
  const codec = new OpusCodec();
  try {
    await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: await png() });
    const frames = codec.encode(new Int16Array(960).fill(1200));
    await ctx.device.sendRecording(42, frames, 960, 0);

    const event = await waitFor(async () => {
      const data = await (await fetch(`${ctx.base}/api/history`)).json();
      return data.events.find((e) => e.type === 'recording' && e.id === 42) ?? null;
    });
    assert.ok(event, '应有录音事件');
    assert.equal(event.samples, 960);
    assert.equal(event.durationMs, 60);
    assert.equal(event.lostFrames, 0);
    assert.equal(event.url, '/api/recordings/42.wav');

    const res = await fetch(ctx.base + event.url);
    assert.equal(res.status, 200);
    const wav = Buffer.from(await res.arrayBuffer());
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 16000); // 采样率
    assert.equal(wav.length, 44 + 960 * 2);

    const missing = await fetch(`${ctx.base}/api/recordings/9999.wav`);
    assert.equal(missing.status, 404);
    const bad = await fetch(`${ctx.base}/api/recordings/..%2Fsecret.wav`);
    assert.equal(bad.status, 400);
  } finally {
    await teardown(ctx);
  }
});

test('关闭服务时向设备发送 CLOSE，管理权即时释放', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: await png() });
    assert.equal(ctx.device.closed, false);
    await ctx.app.locals.shutdown();
    assert.equal(ctx.device.closed, true);
  } finally {
    await teardown(ctx);
  }
});

test('非法 PNG 与超限图片返回 400（不能变成 500）', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const bad = await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: Buffer.from('definitely not a png') });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /PNG/);

    const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#333' } })
      .png()
      .toBuffer();
    const res = await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: huge });
    assert.equal(res.status, 400);
  } finally {
    await teardown(ctx);
  }
});

test('请求体超过上限返回 413 JSON，未知接口返回 JSON 404', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const big = await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: Buffer.alloc(17 * 1024 * 1024) });
    assert.equal(big.status, 413);
    assert.equal((await big.json()).ok, false);

    const missing = await fetch(`${ctx.base}/api/nope`);
    assert.equal(missing.status, 404);
    const body = await missing.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /未知接口/);
  } finally {
    await teardown(ctx);
  }
});

test('长时间播放可以用 /api/stop 中止，且返回 Stopped', { timeout: 25000 }, async () => {
  const ctx = await boot();
  try {
    await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: await png() });
    const pcm = Buffer.from(new Int16Array(32000).fill(3000).buffer); // 2 秒
    const playing = fetch(`${ctx.base}/api/play?volume=60`, { method: 'POST', body: pcm }).then(async (r) => ({
      status: r.status,
      body: await r.json(),
    }));
    await waitFor(() => ctx.device.streams.size > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stop = await fetch(`${ctx.base}/api/stop`, { method: 'POST' });
    assert.equal(stop.status, 200);
    const stopBody = await stop.json();
    assert.ok(stopBody.target, '应报告被停止的流号');

    const result = await playing;
    assert.equal(result.status, 200);
    assert.equal(result.body.end, 'Stopped');

    // 没有播放/录音时再停一次是幂等的
    const idle = await (await fetch(`${ctx.base}/api/stop`, { method: 'POST' })).json();
    assert.equal(idle.target, null);
  } finally {
    await teardown(ctx);
  }
});

test('录音文件按保留上限淘汰最旧的一份', { timeout: 20000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zectrix-keep-'));
  const app = createServer({ device: `127.0.0.1:${port}`, recordingsDir: dir, recordingsKeep: 1, auth: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const codec = new OpusCodec();
  const ctx = { device, app, server, dir };
  try {
    await fetch(`${base}/api/show?format=mono`, { method: 'POST', body: await png() });
    const frames = codec.encode(new Int16Array(960).fill(900));
    await device.sendRecording(61, frames, 960, 0);
    await waitFor(async () => {
      const data = await (await fetch(`${base}/api/history`)).json();
      return data.events.some((e) => e.type === 'recording' && e.id === 61);
    });
    await device.sendRecording(62, frames, 960, 0);
    await waitFor(async () => {
      const data = await (await fetch(`${base}/api/history`)).json();
      return data.events.some((e) => e.type === 'recording' && e.id === 62);
    });
    const files = await fs.readdir(dir);
    assert.deepEqual(files, ['62.wav'], `应只保留最新一份，实际 ${files.join(',')}`);
  } finally {
    await teardown(ctx);
  }
});

// ---- 设备地址在页面里配置 ----

test('未配置设备时：页面可用、推送返回 409 而不是 500', { timeout: 20000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zectrix-cfg-'));
  const app = createServer({ device: null, recordingsDir: dir, settingsFile: path.join(dir, 'config.json'), auth: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.device, null);
    assert.equal(cfg.source, 'none');
    assert.equal(cfg.defaultPort, 32342);

    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.connected, false);
    assert.equal(status.deviceSource, 'none');

    const res = await fetch(`${base}/api/show?format=mono`, { method: 'POST', body: await png() });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /尚未配置设备地址/);

    const conn = await fetch(`${base}/api/connect`, { method: 'POST' });
    assert.equal(conn.status, 409);
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    device.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('页面保存的设备地址会落盘，重启后仍然生效', { timeout: 20000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zectrix-cfg-'));
  const settingsFile = path.join(dir, 'config.json');
  const app = createServer({ device: null, recordingsDir: dir, settingsFile, auth: false });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: ' 192.168.1.77:32342 ' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.device, '192.168.1.77:32342');
    assert.equal(body.persisted, true);

    const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.equal(saved.device, '192.168.1.77:32342');

    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.source, 'file');
    assert.equal(cfg.address, '192.168.1.77:32342');
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('非法设备地址一律 400，且不落盘、不改动当前配置', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const before = await (await fetch(`${ctx.base}/api/config`)).json();
    const bad = ['', '   ', '192.168.1.100:0', '192.168.1.100:70000', '192.168.1.100:abc',
      '[::1]:32342', 'a b', 'http://'];
    for (const device of bad) {
      const res = await fetch(`${ctx.base}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device }),
      });
      assert.equal(res.status, 400, `地址 ${JSON.stringify(device)} 应被拒绝`);
    }
    const nonJson = await fetch(`${ctx.base}/api/config`, { method: 'POST', body: 'not-json' });
    assert.equal(nonJson.status, 400);

    const after = await (await fetch(`${ctx.base}/api/config`)).json();
    assert.equal(after.device, before.device, '非法输入不应改动生效地址');
    await assert.rejects(() => fs.readFile(path.join(ctx.dir, 'config.json'), 'utf8'));
  } finally {
    await teardown(ctx);
  }
});

test('改地址会先给旧设备发 CLOSE，再连新地址', { timeout: 25000 }, async () => {
  const ctx = await boot();
  const next = new MockDevice({ dropChunkOnce: false });
  const nextPort = await next.start();
  try {
    // 先连上原设备
    await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: await png() });
    assert.equal(ctx.device.closed, false);

    const res = await fetch(`${ctx.base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: `127.0.0.1:${nextPort}` }),
    });
    assert.equal(res.status, 200);
    assert.equal(ctx.device.closed, true, '旧设备应收到 CLOSE 释放管理权');

    const conn = await fetch(`${ctx.base}/api/connect`, { method: 'POST' });
    const body = await conn.json();
    assert.equal(body.ok, true);
    assert.ok(body.summary?.id, '应返回新设备的 ID');

    const pushed = await fetch(`${ctx.base}/api/show?format=mono`, { method: 'POST', body: await png() });
    assert.equal(pushed.status, 200, '应能向新设备推图');
  } finally {
    await teardown(ctx);
    next.stop();
  }
});
