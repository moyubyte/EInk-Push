// 「人生指南」测试：数据完整性、筛选、版面渲染，以及网页/设备按键两条链路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { createServer } from '../src/server.js';
import { KEY, ACTION } from '../src/packet.js';
import {
  ENTRIES, CHAPTERS, META, evidenceBase, evidenceStats, filterEntries, pickIndex, dailyOffset,
} from '../apps/life-guide/entries.js';
import { renderEntry, tagLine } from '../apps/life-guide/render.js';

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

test('数据：767 条建议、34 个章节，字段完整且来源许可正确', () => {
  assert.equal(ENTRIES.length, 767);
  assert.equal(CHAPTERS.length, 34);
  assert.equal(META.license, 'CC BY 4.0');
  assert.ok(META.source.includes('HowToLiveBetter'));

  assert.equal(new Set(ENTRIES.map((entry) => entry.key)).size, ENTRIES.length, '条目键不应重复');
  for (const entry of ENTRIES) {
    assert.ok(entry.title && entry.plain, `缺标题或正文: ${entry.key}`);
    assert.ok(entry.cost, `缺成本: ${entry.key}`);
    assert.match(evidenceBase(entry), /^[A-C]$/, `证据等级异常: ${entry.key}`);
    assert.ok(entry.tags && entry.tags['收益'], `缺成本标签: ${entry.key}`);
  }
  const stats = evidenceStats();
  assert.equal(stats.reduce((total, item) => total + item.count, 0), ENTRIES.length);
});

test('筛选：章节、证据等级与组合筛选都只返回匹配条目', () => {
  const firstChapter = CHAPTERS[0];
  const byChapter = filterEntries({ chapter: firstChapter.no });
  assert.equal(byChapter.length, firstChapter.count);
  assert.ok(byChapter.every((entry) => entry.chapterNo === firstChapter.no));

  const byEvidence = filterEntries({ evidence: 'A' });
  assert.equal(byEvidence.length, evidenceStats().find((item) => item.level === 'A').count);
  assert.ok(byEvidence.every((entry) => evidenceBase(entry) === 'A'));

  const both = filterEntries({ chapter: firstChapter.no, evidence: 'A' });
  assert.ok(both.length > 0 && both.length < byChapter.length);
  assert.ok(both.every((entry) => entry.chapterNo === firstChapter.no && evidenceBase(entry) === 'A'));
});

test('取条：随机不会停在原地，当天偏移可复现', () => {
  const pool = filterEntries({ chapter: '01' });
  const picked = pickIndex(pool, 0, () => 0);
  assert.ok(picked >= 0 && picked < pool.length);
  assert.notEqual(pool[picked].key, pool[0].key);
  assert.equal(pickIndex([pool[0]], 0, () => 0.9), 0);

  const day = new Date('2026-10-24T10:00:00+08:00');
  assert.equal(dailyOffset(day), dailyOffset(new Date('2026-10-24T23:00:00+08:00')));
  assert.equal(dailyOffset(day) + 1, dailyOffset(new Date('2026-10-25T10:00:00+08:00')));
});

test('渲染：极长标题与最长正文都能排进 400×300', async () => {
  const longestTitle = ENTRIES.reduce((long, entry) => ([...entry.title].length > [...long.title].length ? entry : long));
  const longestPlain = ENTRIES.reduce((long, entry) => ([...entry.plain].length > [...long.plain].length ? entry : long));
  for (const entry of [ENTRIES[0], longestTitle, longestPlain]) {
    const png = renderEntry(entry, { position: 1, total: ENTRIES.length });
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);
    const stats = await sharp(png).stats();
    assert.ok(stats.channels[0].mean < 250, `图像应有内容，mean=${stats.channels[0].mean}`);
    assert.ok(png.length > 2000, `PNG 体积异常: ${png.length}`);
  }
  assert.match(tagLine(ENTRIES[0]), /钱 0 .*证据 A/);
});

test('Web 接口：翻条、筛选、推送与设备确认键（离线 MockDevice）', { timeout: 40000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-guide-'));
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
  const state = () => fetch(`${base}/apps/life-guide/api/state`).then((r) => r.json());

  try {
    const list = await (await fetch(`${base}/api/apps`)).json();
    assert.ok(list.apps.some((item) => item.id === 'life-guide'), '应用列表应包含 life-guide');

    const first = await state();
    assert.equal(first.ok, true);
    assert.ok(first.entry?.title, '应有初始条目');
    assert.equal(first.total, ENTRIES.length);
    assert.equal(first.active, false, '没有网页接管时不应响应设备按键');

    const preview = await fetch(`${base}/apps/life-guide/api/preview.png`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await preview.arrayBuffer());
    const meta = await sharp(png).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);

    // 只翻条不推设备：条目必须前进，设备不应收到图片
    const local = await fetch(`${base}/apps/life-guide/api/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: false }),
    }).then((r) => r.json());
    assert.equal(local.ok, true);
    assert.notEqual(local.entry.key, first.entry.key, '翻条不能停在原地');
    assert.equal(local.pushed, false);
    assert.equal(local.turns, 1);
    assert.equal(device.images.size, 0, '未开启推送时设备不应收到图片');

    // 翻条并推送：设备应收到分片
    const pushed = await fetch(`${base}/apps/life-guide/api/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: true }),
    }).then((r) => r.json());
    assert.equal(pushed.ok, true);
    assert.equal(pushed.pushed, true, JSON.stringify(pushed));
    assert.ok(await waitFor(() => device.images.size >= 1), '设备应收到图片');

    // 章节 + 证据筛选：总量变小，当前条目落在筛选结果里
    const filtered = await fetch(`${base}/apps/life-guide/api/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter: '01', evidence: 'A' }),
    }).then((r) => r.json());
    assert.equal(filtered.ok, true);
    assert.equal(filtered.total, filterEntries({ chapter: '01', evidence: 'A' }).length);
    assert.equal(filtered.entry.chapterNo, '01');
    assert.equal(evidenceBase(filtered.entry), 'A');
    assert.deepEqual(filtered.filters, { chapter: '01', evidence: 'A' });

    // 筛选后的翻条必须带回同样的筛选条件，页面下拉框才不会跳回「全部」
    const afterFilterNext = await fetch(`${base}/apps/life-guide/api/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: false }),
    }).then((r) => r.json());
    assert.deepEqual(afterFilterNext.filters, { chapter: '01', evidence: 'A' });
    assert.equal(afterFilterNext.total, filtered.total);
    assert.equal(afterFilterNext.entry.chapterNo, '01');

    // 没有接管时，确认键不应抢别的应用的按键
    const beforeArm = await state();
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    await sleep(400);
    assert.equal((await state()).turns, beforeArm.turns, '未接管时确认键不应翻条');

    // 网页接管后，设备确认键翻下一条并推送
    const armed = await fetch(`${base}/apps/life-guide/api/arm`, {
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
      return current.turns >= beforeKey.turns + 1 ? current : null;
    });
    assert.ok(afterKey, '确认键应翻下一条');
    assert.notEqual(afterKey.entry.key, beforeKey.entry.key, '按键翻条也不能停在原地');
    assert.ok(await waitFor(() => device.images.size >= 2), '确认键翻条后设备应再收到一张图');

    // 只推当前这条
    const again = await fetch(`${base}/apps/life-guide/api/push`, { method: 'POST' }).then((r) => r.json());
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.entry.key, afterKey.entry.key);
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    device.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
