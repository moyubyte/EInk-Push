// 今天应用测试：历法/节气计算、穿搭推算、月历网格、历史条目、渲染尺寸、Web 接口与推送链路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { createServer } from '../src/server.js';
import {
  dayPillar, nayinOf, computeClothing, solarTerms, termPair, windLevel, aqiLevel,
  weekdayOf, parseDate, addDays, formatDate, todayInZone, WEATHER,
  monthGrid, parseHistoryEntry, selectHistory,
} from '../apps/today/sources.js';
import { renderBrief, renderFailure } from '../apps/today/render.js';
import { validateConfig, DEFAULT_CONFIG } from '../apps/today/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 8000, step = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(step);
  }
}

/** 固定数据：不联网也能验证渲染与推送 */
function fixtureBrief(dateText, tomorrow) {
  const date = parseDate(dateText);
  return {
    date,
    tomorrow,
    location: { label: '杭州', lat: 30.27, lon: 120.16, timezone: 'Asia/Shanghai' },
    weather: {
      date: dateText, forecast: tomorrow, code: 61, condition: '小雨', current: 13, feels: 11,
      humidity: 69, high: 16, low: 10, rainProbability: 80, windSpeed: 12, windDirection: 90,
      isDay: true, sunrise: '06:36', sunset: '17:42', aqi: 98, aqiLevel: '良', pm25: 12, pm10: 20,
      hourlyTemperatures: Array.from({ length: 24 }, (_, index) => 10 + Math.round(4 * Math.sin(index / 3))),
    },
    air: { aqi: 98, level: '良', pm25: 12, pm10: 20 },
    almanac: {
      lunar: '九月十三', pillar: '己巳', valueGod: '明堂', nayin: '大林木', buildDay: '危',
      yi: ['祭祀', '求嗣', '冠笄', '进人口', '会亲友', '安门'], ji: ['祈福', '斋醮', '纳采'],
      source: 'fixture',
    },
    holiday: { label: '周四', off: false, name: null },
    history: [
      { year: '1945', yearValue: 1945, type: 'event', title: '《联合国宪章》生效', desc: '', festival: null },
      { year: '1991', yearValue: 1991, type: 'event', title: '中国棋院在北京成立', desc: '', festival: null },
    ],
    clothing: computeClothing('己巳'),
  };
}

test('日柱干支与纳音：与万年历核对过的六个日期保持一致', () => {
  const cases = [
    ['2023-12-31', '癸亥'],
    ['2024-02-10', '甲辰'],
    ['2025-05-05', '甲戌'],
    ['2026-01-01', '乙亥'],
    ['2026-03-08', '辛巳'],
    ['2026-10-22', '己巳'],
  ];
  for (const [date, expected] of cases) {
    assert.equal(dayPillar(parseDate(date)), expected, `${date} 日柱应为 ${expected}`);
  }
  assert.equal(nayinOf('己巳'), '大林木');
  assert.equal(nayinOf('甲子'), '海中金');
  assert.equal(nayinOf('壬戌'), '大海水');
  assert.equal(nayinOf('错字'), null);
});

test('节气：2026 年 24 个节气日期正确（含跨年取相邻年表）', () => {
  const terms = solarTerms(2026);
  assert.equal(terms.length, 24);
  const byName = Object.fromEntries(terms.map((term) => [term.name, term.date]));
  assert.equal(byName['立春'], '2026-02-04');
  assert.equal(byName['春分'], '2026-03-20');
  assert.equal(byName['夏至'], '2026-06-21');
  assert.equal(byName['秋分'], '2026-09-23');
  assert.equal(byName['寒露'], '2026-10-08');
  assert.equal(byName['霜降'], '2026-10-23');
  assert.equal(byName['冬至'], '2026-12-22');

  assert.deepEqual(termPair('2026-10-22'), { prev: '寒露', next: '霜降' });
  assert.deepEqual(termPair('2026-10-08'), { prev: '寒露', next: '霜降' });
  // 年初：上一个节气要落到上一年
  assert.deepEqual(termPair('2026-01-01'), { prev: '冬至', next: '小寒' });
});

test('五行穿衣：由日柱纳音按生克推出五组颜色', () => {
  const clothing = computeClothing('己巳');
  assert.equal(clothing.element, '木');
  assert.deepEqual(clothing.colors['贵'], ['黑色', '浅蓝色', '深蓝色']); // 生我者水
  assert.deepEqual(clothing.colors['合'], ['绿色', '青色']); // 同我者木
  assert.deepEqual(clothing.colors['财'], ['黄色', '咖啡色']); // 我克者土
  assert.deepEqual(clothing.colors['耗'], ['红色', '粉色', '橙色', '紫色']); // 我生者火
  assert.deepEqual(clothing.colors['忌'], ['白色', '银色']); // 克我者金

  const metal = computeClothing('甲子'); // 海中金
  assert.equal(metal.element, '金');
  assert.deepEqual(metal.colors['合'], ['白色', '银色']);
});

test('辅助换算：风力、空气质量、星期、日期加减', () => {
  assert.equal(windLevel(0), 0);
  assert.equal(windLevel(12), 3);
  assert.equal(windLevel(40), 6); // 蒲福风级：38–49 km/h 为 6 级
  assert.equal(aqiLevel(35), '优');
  assert.equal(aqiLevel(98), '良');
  assert.equal(aqiLevel(260), '重度');
  assert.equal(weekdayOf(parseDate('2026-10-22')), '四');
  assert.equal(formatDate(addDays(parseDate('2026-12-31'), 1)), '2027-01-01');
  assert.equal(formatDate(addDays(parseDate('2026-03-01'), -1)), '2026-02-28');
  assert.ok(todayInZone('Asia/Shanghai').year >= 2024);
  assert.equal(WEATHER[61], '小雨');
});

test('月历网格与历史条目：周一开头、补满整周、历史优先事件并按年份排序', () => {
  const grid = monthGrid(parseDate('2026-10-22'));
  assert.equal(grid.days, 31);
  assert.equal(grid.offset, 3, '2026-10-01 是周四，周一开头应空三格');
  assert.equal(grid.cells.length, 35);
  assert.equal(grid.cells[3], 1);
  assert.equal(grid.cells[33], 31);
  assert.equal(grid.cells[34], null);

  const entries = [
    { year: '51', yearValue: 51, type: 'birth', title: '古人出生' },
    { year: '1860', yearValue: 1860, type: 'event', title: '甲事件' },
    { year: '1923', yearValue: 1923, type: 'event', title: '乙事件' },
    { year: '1945', yearValue: 1945, type: 'event', title: '丙事件' },
    { year: '2008', yearValue: 2008, type: 'death', title: '今人逝世' },
  ];
  assert.deepEqual(selectHistory(entries, 2).map((item) => item.year), ['1923', '1945']);
  // 没有「事件」时用出生/逝世补齐
  assert.deepEqual(selectHistory(entries.slice(0, 1), 2).map((item) => item.title), ['古人出生']);

  const parsed = parseHistoryEntry({
    year: '1860',
    type: 'event',
    title: '清政府与英国<a href="x">北京</a>签订条约',
    desc: '<a href="x">北京</a>',
  });
  assert.equal(parsed.title, '清政府与英国北京签订条约');
  assert.equal(parsed.yearValue, 1860);
});

test('渲染：输出 400×300 的单色 PNG，且不是空白图', async () => {
  const png = renderBrief({ ...fixtureBrief('2026-10-22', false), terms: { prev: '寒露', next: '霜降' } });
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
  const stats = await sharp(png).stats();
  // 二值化后只应有黑白两色，且黑色像素占一定比例（有内容）
  assert.ok(stats.channels[0].mean < 250, `图像应包含黑色内容，mean=${stats.channels[0].mean}`);
  assert.ok(png.length > 3000, `PNG 体积异常: ${png.length}`);
});

test('渲染：缺少数据时降级为占位文本而不是抛错', async () => {
  const png = renderBrief({
    date: parseDate('2026-10-22'),
    tomorrow: true,
    location: { label: '测试地点' },
    weather: { code: 0, condition: '', current: 0, low: 0, high: 0, hourlyTemperatures: [], isDay: false },
    almanac: { yi: [], ji: [] },
    holiday: {},
    clothing: { colors: {} },
    terms: {},
  });
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 400);
  assert.ok(png.length > 2000);

  const failure = renderFailure('天气接口超时');
  assert.equal((await sharp(failure).metadata()).width, 400);
});

test('配置校验：非法 cron / 经纬度 / 地点名一律拒绝', () => {
  const base = { ...DEFAULT_CONFIG };
  assert.deepEqual(validateConfig({}, base), base);
  assert.throws(() => validateConfig({ cron: '* * *' }, base), /cron/);
  assert.throws(() => validateConfig({ location: { label: '', lat: 0, lon: 0 } }, base), /地点/);
  assert.throws(() => validateConfig({ location: { label: 'x', lat: 100, lon: 0 } }, base), /纬度/);
  assert.throws(() => validateConfig({ location: { label: 'x', lat: 0, lon: 999 } }, base), /经度/);
  assert.throws(() => validateConfig({ format: 'gray42' }, base), /format/);
  const next = validateConfig({ location: { label: ' 北京 ', lat: 39.9, lon: 116.4, timezone: 'Asia/Shanghai' } }, base);
  assert.equal(next.location.label, '北京');
  assert.equal(next.location.lat, 39.9);
});

test('Web 接口：应用列表、配置读写、预览、推送（离线固定数据）', { timeout: 40000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-brief-'));
  const app = createServer({
    device: `127.0.0.1:${port}`,
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'config.json'),
    auth: false,
    briefBuilder: async ({ date, tomorrow }) => fixtureBrief(date, tomorrow),
    // 定位也注入掉，避免离线测试去打公网 IP 定位接口
    locationDetector: async () => null,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/apps`)).json();
    const ids = list.apps.map((item) => item.id);
    assert.ok(ids.includes('today'), `应用列表缺少 today: ${ids}`);
    assert.ok(ids.includes('vocabulary'), `应用列表缺少 vocabulary: ${ids}`);

    const cfg = await (await fetch(`${base}/apps/today/api/config`)).json();
    assert.equal(cfg.ok, true);
    assert.equal(cfg.config.location.label, '杭州');

    const badCron = await fetch(`${base}/apps/today/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron: 'nope' }),
    });
    assert.equal(badCron.status, 400);

    const saved = await fetch(`${base}/apps/today/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, location: { label: '北京', lat: 39.9, lon: 116.4, timezone: 'Asia/Shanghai' } }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.config.location.label, '北京');
    assert.equal(savedBody.config.enabled, false);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'today', 'config.json'), 'utf8'));
    assert.equal(onDisk.location.label, '北京');

    const preview = await fetch(`${base}/apps/today/api/preview.png`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    const pngBuffer = Buffer.from(await preview.arrayBuffer());
    const meta = await sharp(pngBuffer).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);

    const badDate = await fetch(`${base}/apps/today/api/preview.png?date=2026-13-99`);
    assert.equal(badDate.status, 400);

    const pushed = await fetch(`${base}/apps/today/api/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-22' }),
    });
    const pushBody = await pushed.json();
    assert.equal(pushed.status, 200, JSON.stringify(pushBody));
    assert.equal(pushBody.ok, true);
    assert.ok(pushBody.bytes > 0);

    const gotImage = await waitFor(() => device.images.size > 0);
    assert.ok(gotImage, '设备应收到图片分片');
    // 守住「离线」这个前提：数据必须来自注入的 briefBuilder。
    // 曾经 briefBuilder 没被透传进应用 ctx，导致这条用例悄悄走了真实网络还依然是绿的。
    assert.equal(pushBody.date, '2026-10-22', `推送日期应来自固定数据，实际 ${pushBody.date}`);
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    device.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
