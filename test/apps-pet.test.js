import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  ACTIONS, applyTick, createState, FEED_VARIANTS, levelOf, levelProgress, moodLine,
  normalizeState, performAction, PLAY_VARIANTS, recentAction, stageOf,
} from '../apps/pet/growth.js';
import { BADGE_HEIGHT, BADGE_WIDTH, drawActionArt, renderPetBadge, renderPetCard } from '../apps/pet/render.js';
import { SPRITE_KEYS, loadSprite, spriteBuffer, spriteFor, spriteLabel } from '../apps/pet/sprites.js';
import { cornerInkScores, cornerSlots, decoratePng, findBadgeSlot, pickCorner } from '../apps/pet/overlay.js';
import petApp from '../apps/pet/index.js';

const HOUR = 3600 * 1000;

test('成长引擎：饥饿、心情、精力按小时衰减，经验随时间累积', () => {
  const start = Date.UTC(2026, 9, 20, 0, 0, 0);
  const state = createState(start);
  const next = applyTick(state, start + 6 * HOUR);

  assert.equal(next.hunger, 62); // 80 - 3*6
  assert.equal(next.energy, 70.4); // 80 - 1.6*6
  assert.equal(next.exp, 12); // 2/h
  assert.equal(next.mood, 72.8); // 80 - 1.2*6
  assert.equal(state.hunger, 80, '不应修改入参');
});

test('成长引擎：饿肚子时仍会成长，但只有一半速度', () => {
  const start = Date.UTC(2026, 9, 20, 0, 0, 0);
  const hungry = { ...createState(start), hunger: 10 };
  const next = applyTick(hungry, start + 2 * HOUR);
  assert.equal(next.exp, 2);
  assert.equal(next.hunger, 4);
  const longOffline = applyTick(hungry, start + 100 * 24 * HOUR);
  assert.equal(longOffline.hunger, 0, '离线补算有上限，数值不会变成负数');
  assert.ok(longOffline.exp > 0);
});

test('等级与阶段：经验升级、出生天数决定阶段', () => {
  assert.equal(levelOf(0), 1);
  assert.equal(levelOf(6), 2);
  assert.equal(levelOf(24), 3);
  assert.equal(levelProgress(6).need > 0, true);
  assert.equal(levelProgress(100000).level, 99);

  const born = Date.UTC(2026, 9, 1);
  assert.equal(stageOf(new Date(born).toISOString(), born + 12 * HOUR).key, 'baby');
  assert.equal(stageOf(new Date(born).toISOString(), born + 2 * 24 * HOUR).key, 'baby');
  assert.equal(stageOf(new Date(born).toISOString(), born + 4 * 24 * HOUR).key, 'teen');
  assert.equal(stageOf(new Date(born).toISOString(), born + 9 * 24 * HOUR).key, 'adult');
  assert.equal(stageOf(new Date(born).toISOString(), born + 40 * 24 * HOUR).key, 'elder');
});

test('互动：数值变化与冷却，体力不足不能玩耍', () => {
  const now = Date.UTC(2026, 9, 20, 8, 0, 0);
  const state = createState(now);
  const fed = performAction(state, 'feed', now);
  assert.equal(fed.ok, true);
  assert.equal(fed.state.hunger, 100);
  assert.equal(fed.state.streak, 1);
  assert.equal(fed.state.cooldowns.feed, now + ACTIONS.feed.cooldownMs);

  const again = performAction(fed.state, 'feed', now + 1000);
  assert.equal(again.ok, false);
  assert.match(again.error, /^刚喂食过，/);
  assert.match(again.error, /再来哦$/);

  const ready = performAction(fed.state, 'feed', now + ACTIONS.feed.cooldownMs + 1);
  assert.equal(ready.ok, true, '冷却结束后可以再次喂食');

  const tired = performAction({ ...state, energy: 5 }, 'play', now);
  assert.equal(tired.ok, false);
  assert.match(tired.error, /累/);

  const petted = performAction(state, 'pet', now);
  assert.equal(petted.ok, true);
  assert.equal(petted.state.log.at(-1).text.includes('尾巴'), true);
});

test('抚摸动作循环：6 种台词轮着来，第 7 次回到第一种', () => {
  const now = Date.UTC(2026, 9, 20, 8, 0, 0);
  let state = createState(now);
  const messages = [];
  for (let i = 0; i < 7; i += 1) {
    const result = performAction(state, 'pet', now + i * (ACTIONS.pet.cooldownMs + 1000));
    assert.equal(result.ok, true, `第 ${i + 1} 次抚摸应在冷却结束后成功`);
    messages.push(result.message);
    state = result.state;
  }
  assert.equal(new Set(messages.slice(0, 6)).size, 6, '前 6 次台词应各不相同');
  assert.equal(messages[6], messages[0], '第 7 次应循环回第一种');
  assert.equal(state.petCount, 7, '抚摸次数应被记录用于循环');
});

test('状态归一化：petCount 缺失时安全补 0', () => {
  assert.equal(normalizeState({}).petCount, 0);
  assert.equal(normalizeState({ petCount: -3 }).petCount, 0);
  assert.equal(normalizeState({ petCount: 4 }).petCount, 4);
  assert.equal(normalizeState({}).feedCount, 0);
  assert.equal(normalizeState({}).playCount, 0);
});

test('喂食与玩耍：各 6 种花样循环，记录动作图案与台词', () => {
  const now = Date.UTC(2026, 9, 20, 8, 0, 0);

  let state = createState(now);
  const feedMessages = [];
  for (let i = 0; i < 7; i += 1) {
    const result = performAction(state, 'feed', now + i * (ACTIONS.feed.cooldownMs + 1000));
    assert.equal(result.ok, true);
    feedMessages.push(result.message);
    state = result.state;
  }
  assert.equal(new Set(feedMessages.slice(0, 6)).size, 6, '前 6 次喂食台词应各不相同');
  assert.equal(feedMessages[6], feedMessages[0], '第 7 次应循环回第一种');
  assert.equal(state.feedCount, 7);
  assert.ok(state.lastArt, '喂食应记录动作图案 key');
  assert.ok(state.lastLabel);

  let playState = createState(now);
  const playArts = [];
  for (let i = 0; i < 7; i += 1) {
    const result = performAction(playState, 'play', now + i * (ACTIONS.play.cooldownMs + 1000));
    assert.equal(result.ok, true);
    playArts.push(result.state.lastArt);
    playState = result.state;
  }
  assert.equal(new Set(playArts.slice(0, 6)).size, 6, '前 6 次玩耍图案应各不相同');
  assert.equal(playArts[6], playArts[0], '第 7 次应循环回第一种');
});

test('动作图案：12 种图案都能绘制；互动后卡片带图案与台词，2 分钟后回到常态', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(64, 64);
  const c = canvas.getContext('2d');
  const artKeys = [...FEED_VARIANTS, ...PLAY_VARIANTS].map((item) => item.art);
  assert.equal(new Set(artKeys).size, 12, '喂食 + 玩耍应有 12 种图案');
  for (const key of artKeys) drawActionArt(c, key, 12, 12);

  const now = new Date(2026, 9, 20, 12, 0, 0).getTime();
  const base = { ...createState(now), lastCareDay: '2026-10-20' };
  const calm = await renderPetCard(base, now);
  const action = {
    at: new Date(now - 30 * 1000).toISOString(),
    action: 'feed',
    art: 'bowl',
    label: '添狗粮',
    message: '你给小爪添了满满一碗狗粮，它埋头吃得咔哧作响。',
  };
  const fed = await renderPetCard({ ...base, lastAction: action }, now);
  assert.notEqual(fed.equals(calm), true, '互动后的卡片应带图案与台词');

  const recent = recentAction({ ...base, lastAction: action }, now);
  assert.equal(recent.art, 'bowl');
  assert.equal(recentAction(base, now), null, '没有互动时返回 null');
  const stale = await renderPetCard(
    { ...base, lastAction: { ...action, at: new Date(now - 3 * 60 * 1000).toISOString() } },
    now,
  );
  assert.equal(stale.equals(calm), true, '超过 2 分钟后回到常态文案');
});

test('动态文案会随饥饿、困倦变化', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  const base = createState(now);
  assert.match(moodLine({ ...base, hunger: 5 }, now), /肚子/);
  assert.match(moodLine({ ...base, energy: 5 }, now), /困/);
  assert.match(moodLine({ ...base, mood: 5 }, now), /低落/);
});

test('柯基表情：随状态切换，12 张素材齐全且可解码', async () => {
  const now = new Date(2026, 9, 20, 12, 0, 0).getTime();
  const base = { ...createState(now), lastCareDay: '2026-10-20', exp: 20 };
  assert.equal(spriteFor({ ...base, hunger: 10 }, now), 'alert');
  assert.equal(spriteFor({ ...base, energy: 10 }, now), 'sleepy');
  assert.equal(spriteFor({ ...base, mood: 10 }, now), 'overdue');
  assert.equal(spriteFor({ ...base, mood: 30 }, now), 'late');
  assert.equal(spriteFor({ ...base, mood: 90 }, now), 'done');
  assert.equal(spriteFor(base, now), 'ontime');
  assert.equal(spriteFor({ ...base, lastCareDay: null, exp: 0 }, now), 'empty');
  assert.equal(spriteFor({ ...base, lastCareDay: '2026-10-18' }, now), 'idle');

  // 互动后两分钟内先给反应，之后回到常态表情
  const petted = { ...base, lastAction: { at: new Date(now - 30000).toISOString(), action: 'pet' } };
  assert.equal(spriteFor(petted, now), 'wag');
  const played = { ...base, lastAction: { at: new Date(now - 30000).toISOString(), action: 'play' } };
  assert.equal(spriteFor(played, now), 'ball');
  assert.equal(spriteFor(petted, now + 3 * 60 * 1000), 'ontime');

  // 深夜换成趴着睡；精力见底仍用站着打盹的那张
  const night = new Date(2026, 9, 20, 23, 30, 0).getTime();
  assert.equal(spriteFor(base, night), 'nap');
  assert.equal(spriteFor({ ...base, energy: 10 }, now), 'sleepy');

  assert.equal(spriteLabel('alert'), '饿了');
  assert.equal(spriteLabel('ball'), '玩疯了');
  for (const key of SPRITE_KEYS) {
    assert.equal((await loadSprite(key)).width, 256, `缺少 ${key} 素材`);
    assert.ok((await spriteBuffer(key)).length > 0);
  }
});

test('状态归一化：坏数据与缺失字段都能安全退回默认', () => {
  assert.equal(normalizeState(null).name, '小爪');
  const merged = normalizeState({ name: '豆豆', hunger: 999, exp: -5, log: 'bad', bornAt: 'nope' });
  assert.equal(merged.name, '豆豆');
  assert.equal(merged.hunger, 100);
  assert.equal(merged.exp, 0);
  assert.ok(Array.isArray(merged.log));
  assert.ok(!Number.isNaN(new Date(merged.bornAt).getTime()));
});

test('徽章：四个候选角位置正确，挑选墨水最少的一角', () => {
  const slots = cornerSlots(400, 300);
  assert.deepEqual(slots.tr, { x: 400 - BADGE_WIDTH - 8, y: 8 });
  assert.deepEqual(slots.bl, { x: 8, y: 300 - BADGE_HEIGHT - 8 });
  assert.equal(pickCorner({ tr: 1, br: 0, bl: 0.5, tl: 0.2 }), 'br');
  assert.equal(pickCorner({ tr: 0.4, br: 0.4, bl: 0.4, tl: 0.4 }), 'tr', '并列时稳定选第一个');
});

test('徽章：角落识别只看深色像素', async () => {
  const base = await sharp({
    create: { width: 400, height: 300, channels: 3, background: '#ffffff' },
  }).greyscale().raw().toBuffer();
  const slots = cornerSlots(400, 300);
  for (let y = 0; y < BADGE_HEIGHT; y += 1) {
    for (let x = 0; x < BADGE_WIDTH; x += 1) {
      base[(slots.tr.y + y) * 400 + slots.tr.x + x] = 0;
    }
  }
  const scores = cornerInkScores(base, 400, 300, 1);
  assert.equal(scores.tr, 1);
  assert.equal(scores.br, 0);
  assert.equal(pickCorner(scores), 'br');
});

test('合成：保持 400×300，只在最空的角加内容；非设备尺寸原样返回', async () => {
  const white = await sharp({
    create: { width: 400, height: 300, channels: 3, background: '#ffffff' },
  }).png().toBuffer();
  const decorated = await decoratePng(white, createState());
  const meta = await sharp(decorated).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
  assert.notEqual(decorated.length, white.length);

  const small = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#ffffff' },
  }).png().toBuffer();
  assert.equal(await decoratePng(small, createState()), small);
});

test('选位：空白图贴第一角；角与边都压字时改放全图留白，不盖住内容', async () => {
  const white = Buffer.alloc(400 * 300, 255);
  assert.deepEqual(findBadgeSlot(white, 400, 300, 1), cornerSlots(400, 300).tr);

  // 四条边各铺一圈黑色内容：四角与四边中点都被占满，只剩中间留白
  const bordered = Buffer.alloc(400 * 300, 255);
  for (let y = 0; y < 300; y += 1) {
    for (let x = 0; x < 400; x += 1) {
      if (x < 60 || x >= 340 || y < 60 || y >= 240) bordered[y * 400 + x] = 0;
    }
  }
  const slot = findBadgeSlot(bordered, 400, 300, 1);
  assert.ok(slot.x >= 60 && slot.x + BADGE_WIDTH <= 340, '应落在左右黑边之间');
  assert.ok(slot.y >= 60 && slot.y + BADGE_HEIGHT <= 240, '应落在上下黑边之间');
});

test('卡片与徽章：尺寸固定、PNG 可解码，不同表情画出来不一样', async () => {
  const now = new Date(2026, 9, 20, 12, 0, 0).getTime();
  const card = await sharp(await renderPetCard(createState(now), now)).metadata();
  assert.equal(card.width, 400);
  assert.equal(card.height, 300);
  const badge = await sharp(await renderPetBadge(createState(now), now)).metadata();
  assert.equal(badge.width, BADGE_WIDTH * 3);
  assert.equal(badge.height, BADGE_HEIGHT * 3);

  const hungry = await renderPetCard({ ...createState(now), hunger: 5 }, now);
  const sleepy = await renderPetCard({ ...createState(now), energy: 5 }, now);
  assert.equal(hungry.equals(sleepy), false, '不同状态应使用不同柯基表情');

  const baby = await renderPetCard({ ...createState(now), bornAt: new Date(now).toISOString() }, now);
  const elder = await renderPetCard({ ...createState(now), bornAt: new Date(now - 40 * 24 * HOUR).toISOString() }, now);
  assert.equal(baby.equals(elder), false, '不同阶段应有不同构图');
});

test('应用：宠物自己的推送走 showRaw，互动成功后状态落盘', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkpush-pet-'));
  const calls = [];
  const client = {
    show: async (png, format) => { calls.push({ method: 'show', png, format }); },
    showRaw: async (png, format) => { calls.push({ method: 'showRaw', png, format }); },
  };
  const instance = petApp.create({
    dataDir: dir,
    fontsDir: dir,
    getClient: async () => client,
    on: () => () => {},
    log: () => {},
  });

  try {
    await instance.start();
    const result = await instance.doAction('feed', { pushToDevice: true });
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'showRaw', '宠物卡不能被叠加自己的徽章');

    const saved = JSON.parse(await fs.readFile(path.join(dir, 'pet', 'state.json'), 'utf8'));
    assert.equal(saved.hunger > 80, true);
    assert.ok(saved.log.length > 1);

    const second = await instance.doAction('feed', { pushToDevice: false });
    assert.equal(second.ok, false, '冷却未结束时应拒绝');

    // 其他应用的图片会被装饰，且挂上开关后可以关闭
    const white = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#ffffff' },
    }).png().toBuffer();
    const decorated = await instance.decorate(white);
    assert.notEqual(decorated.length, white.length);

    await instance.stop();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('设备按键：确认=抚摸循环、上=喂食、下=玩耍；冷却时推带提示条的宠物卡', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkpush-pet-key-'));
  const calls = [];
  const handlers = [];
  const client = {
    show: async (png) => { calls.push({ method: 'show', png }); },
    showRaw: async (png) => { calls.push({ method: 'showRaw', png }); },
  };
  const instance = petApp.create({
    dataDir: dir,
    fontsDir: dir,
    getClient: async () => client,
    on: (name, handler) => {
      if (name === 'event' || name === 'key') handlers.push(handler);
      return () => {};
    },
    log: () => {},
  });

  // 轮询等待按键触发的动作落进推送链（run 链在应用内部，外部只能等结果出现）
  async function waitFor(check, label) {
    for (let i = 0; i < 100; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`等待超时：${label}`);
  }

  try {
    await instance.start();
    assert.equal(handlers.length >= 1, true, '应订阅设备事件');

    // 推卡上屏后进入租约期：按键归宠物，且阻断应用切换
    await instance.pushCard();
    assert.equal(instance.blocksAppSwitch?.(), true, '卡片在屏上时应阻断上/下键切换应用');

    // 确认键 = 摸摸（第 1 种：摸头）
    const moodBefore = instance.status().mood;
    for (const handler of handlers) handler({ type: 'key', key: 'confirm', action: 'short' });
    await waitFor(() => calls.length >= 2, '确认键触发摸摸');
    assert.equal(instance.status().mood > moodBefore, true, '摸摸后心情应上升');
    const petCard = calls.at(-1).png;

    // 上键 = 喂食
    for (const handler of handlers) handler({ type: 'key', key: 'up', action: 'short' });
    await waitFor(() => calls.length >= 3, '上键触发喂食');
    let pet = await instance.refresh();
    assert.equal(pet.hunger > 80, true, '喂食后饱食应上升');

    // 立刻再按上键：喂食在冷却中，推送的卡片应带「刚喂食过…再来哦」提示条
    for (const handler of handlers) handler({ type: 'key', key: 'up', action: 'short' });
    await waitFor(() => calls.length >= 4, '冷却按键触发提示');
    const noticeCard = calls.at(-1).png;
    assert.equal(calls.at(-1).method, 'showRaw');
    assert.equal(noticeCard.equals(petCard), false, '提示条卡片应与正常卡片不同');
    const meta = await sharp(noticeCard).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300, '提示仍融在 400×300 宠物卡里，不是纯文案卡');

    // 下键 = 玩耍（喂食冷却不影响玩耍）
    for (const handler of handlers) handler({ type: 'key', key: 'down', action: 'short' });
    await waitFor(() => calls.length >= 5, '下键触发玩耍');
    pet = await instance.refresh();
    assert.equal(pet.energy < 80, true, '玩耍后精力应下降');

    // 其他应用推图 → 立刻交还按键
    instance.onScreenTaken?.();
    assert.equal(instance.blocksAppSwitch?.(), false, '屏幕易主后应交还上/下键');

    await instance.stop();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
