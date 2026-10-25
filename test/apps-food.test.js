// 「今天吃什么」测试：候选菜单完整性、不重复抽选、设备版面渲染，
// 以及「网页换菜 / 设备确认键换菜」两条链路（MockDevice 离线）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { createServer } from '../src/server.js';
import { KEY, ACTION } from '../src/packet.js';
import { DISHES, CATEGORIES, pickNext, categoryStats } from '../apps/food/dishes.js';
import { renderDish } from '../apps/food/render.js';

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

test('菜单：40+ 道候选、名称不重复、分类与短评完整', () => {
  assert.ok(DISHES.length >= 40, `候选太少: ${DISHES.length}`);
  assert.equal(new Set(DISHES.map((dish) => dish.name)).size, DISHES.length, '菜名不应重复');
  for (const dish of DISHES) {
    assert.ok(dish.name && dish.name.length <= 10, `菜名过长: ${dish.name}`);
    assert.ok(dish.category && CATEGORIES.includes(dish.category), `分类不合法: ${dish.name}`);
    assert.ok(dish.note && dish.note.length <= 24, `短评过长: ${dish.name}`);
  }
  const stats = categoryStats();
  assert.ok(stats.length >= 8, '分类数量应足够丰富');
  assert.equal(stats.reduce((total, item) => total + item.count, 0), DISHES.length);
});

test('抽选：不会连续抽到同一道，单一候选与空菜单也有确定行为', () => {
  // 固定随机源 0：排除当前菜后取池子第一道
  assert.equal(pickNext(DISHES, DISHES[0].name, () => 0).name, DISHES[1].name);
  assert.equal(pickNext(DISHES, null, () => 0).name, DISHES[0].name);
  // 随机源返回 1 时也不能越界
  assert.equal(pickNext(DISHES, null, () => 1).name, DISHES[DISHES.length - 1].name);
  const single = [DISHES[0]];
  assert.equal(pickNext(single, DISHES[0].name, () => 0), DISHES[0]);
  assert.throws(() => pickNext([], null), /候选菜单为空/);
});

test('渲染：输出 400×300 单色 PNG，长菜名也能放下', async () => {
  const long = DISHES.find((dish) => dish.name.length >= 6);
  for (const dish of [DISHES[0], long]) {
    const png = renderDish(dish, { rolls: 3, total: DISHES.length });
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);
    const stats = await sharp(png).stats();
    assert.ok(stats.channels[0].mean < 250, `图像应有内容，mean=${stats.channels[0].mean}`);
    assert.ok(png.length > 2000, `PNG 体积异常: ${png.length}`);
  }
});

test('Web 接口：换菜、推送与设备确认键（离线 MockDevice）', { timeout: 40000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-food-'));
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
  const state = () => fetch(`${base}/apps/what-to-eat/api/state`).then((r) => r.json());

  try {
    const list = await (await fetch(`${base}/api/apps`)).json();
    assert.ok(list.apps.some((item) => item.id === 'what-to-eat'), '应用列表应包含 what-to-eat');

    const first = await state();
    assert.equal(first.ok, true);
    assert.ok(first.dish?.name, '应有一道初始菜');
    assert.equal(first.rolls, 0);
    assert.equal(first.active, false, '没有网页接管时不应响应设备按键');

    const preview = await fetch(`${base}/apps/what-to-eat/api/preview.png`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await preview.arrayBuffer());
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);

    // 只换菜不推设备：菜必须变，设备不应收到图片
    const local = await fetch(`${base}/apps/what-to-eat/api/roll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: false }),
    }).then((r) => r.json());
    assert.equal(local.ok, true);
    assert.notEqual(local.dish.name, first.dish.name, '换菜不能和上一道重复');
    assert.equal(local.pushed, false);
    assert.equal(local.rolls, 1);
    assert.equal(device.images.size, 0, '未开启推送时设备不应收到图片');

    // 换菜并推送：设备应收到分片
    const pushed = await fetch(`${base}/apps/what-to-eat/api/roll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: true }),
    }).then((r) => r.json());
    assert.equal(pushed.ok, true);
    assert.notEqual(pushed.dish.name, local.dish.name);
    assert.equal(pushed.pushed, true, JSON.stringify(pushed));
    assert.ok(await waitFor(() => device.images.size >= 1), '设备应收到图片');

    // 没有接管时，确认键不应抢别的应用的按键
    const beforeArm = await state();
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    await sleep(400);
    assert.equal((await state()).rolls, beforeArm.rolls, '未接管时确认键不应换菜');

    // 网页接管后，设备确认键换菜并推送
    const armed = await fetch(`${base}/apps/what-to-eat/api/arm`, {
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
      return current.rolls >= beforeKey.rolls + 1 ? current : null;
    });
    assert.ok(afterKey, '确认键应触发换菜');
    assert.notEqual(afterKey.dish.name, beforeKey.dish.name, '按键换菜也不能重复');
    assert.ok(await waitFor(() => device.images.size >= 2), '确认键换菜后设备应再收到一张图');

    // 只推当前这道
    const again = await fetch(`${base}/apps/what-to-eat/api/push`, { method: 'POST' }).then((r) => r.json());
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.dish.name, afterKey.dish.name);
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    device.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
