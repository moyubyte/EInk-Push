// 柯基素材与表情映射。
//
// 12 张 256×256 的单色 PNG 放在 image/ 下，白底、无透明通道，正好适合墨水屏。
// 前 9 张由用户提供，后 3 张（wag / nap / ball）按同一线稿风格补画。
// 这里只做三件事：按宠物状态挑表情、给表情配一句短标签、按需加载图片并缓存。
// 图片读取与解码都是异步的，所以 render.js 的出图函数也是异步的。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import { dayKey, REACTION_MS } from './growth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPRITE_DIR = path.join(__dirname, 'image');

export const SPRITE_KEYS = [
  'idle', 'sleepy', 'alert', 'talk', 'done', 'ontime', 'late', 'overdue', 'empty',
  'wag', 'nap', 'ball',
];

const LABELS = {
  idle: '陪着你',
  sleepy: '困了',
  alert: '饿了',
  talk: '开心',
  done: '超开心',
  ontime: '今天照顾过',
  late: '有点低落',
  overdue: '被冷落了',
  empty: '等你回来',
  wag: '尾巴摇起来了',
  nap: '睡着了',
  ball: '玩疯了',
};

/** 互动后的表情停留时间：刚喂完/摸完先给一个反应，再回到常态（定义在 growth.js） */
export { REACTION_MS };

/**
 * 按状态挑表情，顺序即优先级：
 * 刚互动 > 饿了 > 精力低 > 深夜睡着 > 被冷落 > 低落 > 超开心 > 今日已照顾 > 新来的 > 常态。
 */
export function spriteFor(pet = {}, now = Date.now()) {
  const lastActionAt = pet.lastAction?.at ? new Date(pet.lastAction.at).getTime() : 0;
  const sinceAction = now - lastActionAt;
  if (lastActionAt && sinceAction >= 0 && sinceAction < REACTION_MS) {
    return pet.lastAction.action === 'play' ? 'ball' : 'wag';
  }

  const hour = new Date(now).getHours();
  if (pet.hunger < 20) return 'alert';
  if (pet.energy < 20) return 'sleepy';
  // 深夜直接睡过去，趴着睡的样子比站着打盹更像这个点
  if (hour >= 23 || hour < 6) return 'nap';
  if (pet.mood < 20) return 'overdue';
  if (pet.mood < 40) return 'late';
  if (pet.mood >= 86) return 'done';
  if (pet.lastCareDay === dayKey(now)) return 'ontime';
  if (!pet.lastCareDay && (Number(pet.exp) || 0) < 6) return 'empty';
  return 'idle';
}

export function spriteLabel(key) {
  return LABELS[key] ?? LABELS.idle;
}

export function spritePath(key) {
  return path.join(SPRITE_DIR, `corgi_${SPRITE_KEYS.includes(key) ? key : 'idle'}.png`);
}

const bufferCache = new Map();
const imageCache = new Map();

/** 直接读原图字节，网页头像接口用 */
export async function spriteBuffer(key) {
  const safe = SPRITE_KEYS.includes(key) ? key : 'idle';
  if (!bufferCache.has(safe)) {
    bufferCache.set(safe, fs.readFile(spritePath(safe)));
  }
  return bufferCache.get(safe);
}

/** 解码后的图片，供 canvas drawImage 使用；同一张只解码一次 */
export async function loadSprite(key) {
  const safe = SPRITE_KEYS.includes(key) ? key : 'idle';
  if (!imageCache.has(safe)) {
    imageCache.set(safe, spriteBuffer(safe).then((buffer) => loadImage(buffer)));
  }
  return imageCache.get(safe);
}

/** 页面/接口共用：当前表情的 key 与中文标签 */
export function spriteInfo(pet, now = Date.now()) {
  const key = spriteFor(pet, now);
  return { key, label: spriteLabel(key) };
}
