// 把宠物徽章合成到其他应用推送的图片上。
//
// 不影响宿主应用的做法：不改尺寸、不缩放原图，只在真正空白的地方放徽章。
// 选位顺序是四角 → 四边中点；如果这些位置都压着正文（像晨报这种满版卡片），
// 就全图找一块深色像素接近 0 的留白口袋，而不是硬贴在角上盖住文字。
// 实在找不到全空位置时，才退回四角/边中点里最干净的一个。

import sharp from 'sharp';
import { renderPetBadge, BADGE_WIDTH, BADGE_HEIGHT } from './render.js';

const INSET = 8;
const CLEAN_MAX = 0.003; // 深色像素占比 ≤0.3%，视为可以放徽章的留白
const SCAN_STEP = 4; // 全图扫描步长：4px 足够找到留白，又不至于太慢

export const CORNERS = ['tr', 'br', 'bl', 'tl'];

/** 四个候选角的位置（左上原点） */
export function cornerSlots(width, height, badgeWidth = BADGE_WIDTH, badgeHeight = BADGE_HEIGHT) {
  return {
    tr: { x: width - badgeWidth - INSET, y: INSET },
    br: { x: width - badgeWidth - INSET, y: height - badgeHeight - INSET },
    bl: { x: INSET, y: height - badgeHeight - INSET },
    tl: { x: INSET, y: INSET },
  };
}

/** 纯函数：给四个角的墨水占比，返回最干净的一个（并列时按 CORNERS 顺序） */
export function pickCorner(scores) {
  let best = CORNERS[0];
  for (const key of CORNERS) {
    if ((scores[key] ?? Infinity) < (scores[best] ?? Infinity)) best = key;
  }
  return best;
}

/** 统计每个候选角里「深色像素」的比例；0 表示完全空白 */
export function cornerInkScores(raw, width, height, channels = 1, badgeWidth = BADGE_WIDTH, badgeHeight = BADGE_HEIGHT) {
  const slots = cornerSlots(width, height, badgeWidth, badgeHeight);
  const scores = {};
  for (const key of CORNERS) {
    const { x, y } = slots[key];
    let dark = 0;
    const total = badgeWidth * badgeHeight;
    for (let row = 0; row < badgeHeight; row += 1) {
      for (let col = 0; col < badgeWidth; col += 1) {
        const px = x + col;
        const py = y + row;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const index = (py * width + px) * channels;
        if (raw[index] < 128) dark += 1;
      }
    }
    scores[key] = dark / total;
  }
  return scores;
}

/** 深色像素积分图：任意矩形内的深色像素数可以 O(1) 查询，全图扫描也不慢 */
function darkIntegral(raw, width, height, channels) {
  const stride = width + 1;
  const sum = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      if (raw[(y * width + x) * channels] < 128) row += 1;
      sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + row;
    }
  }
  return { sum, stride };
}

function inkRatio(integral, x, y, width, height, area) {
  const { sum, stride } = integral;
  const dark = sum[(y + height) * stride + (x + width)]
    - sum[y * stride + (x + width)]
    - sum[(y + height) * stride + x]
    + sum[y * stride + x];
  return dark / area;
}

/**
 * 选一个不会压住应用内容的徽章位置。
 * @returns {{x: number, y: number}} 徽章左上角
 */
export function findBadgeSlot(raw, width, height, channels = 1,
  badgeWidth = BADGE_WIDTH, badgeHeight = BADGE_HEIGHT) {
  const integral = darkIntegral(raw, width, height, channels);
  const area = badgeWidth * badgeHeight;
  const corners = cornerSlots(width, height, badgeWidth, badgeHeight);
  const midX = Math.round((width - badgeWidth) / 2);
  const midY = Math.round((height - badgeHeight) / 2);
  const anchors = [
    ...CORNERS.map((key) => corners[key]),
    { x: midX, y: INSET },
    { x: midX, y: height - badgeHeight - INSET },
    { x: INSET, y: midY },
    { x: width - badgeWidth - INSET, y: midY },
  ];

  let fallback = anchors[0];
  let fallbackScore = Infinity;
  for (const slot of anchors) {
    const score = inkRatio(integral, slot.x, slot.y, badgeWidth, badgeHeight, area);
    if (score <= CLEAN_MAX) return slot;
    if (score < fallbackScore) {
      fallbackScore = score;
      fallback = slot;
    }
  }

  // 角与边都压着内容：全图搜留白口袋，优先离角近的位置，让徽章看起来仍像贴在边角
  const maxX = width - badgeWidth - INSET;
  const maxY = height - badgeHeight - INSET;
  let best = null;
  for (let y = INSET; y <= maxY; y += SCAN_STEP) {
    for (let x = INSET; x <= maxX; x += SCAN_STEP) {
      if (inkRatio(integral, x, y, badgeWidth, badgeHeight, area) > CLEAN_MAX) continue;
      const distance = Math.min(
        ...CORNERS.map((key) => Math.abs(x - corners[key].x) + Math.abs(y - corners[key].y)),
      );
      if (!best || distance < best.distance) best = { x, y, distance };
    }
  }
  return best ? { x: best.x, y: best.y } : fallback;
}

/**
 * 给一张 400×300 的 PNG 贴上宠物徽章。
 * 尺寸不符（不是设备画布）时原样返回，避免误伤自定义尺寸图片。
 * @returns {Promise<Buffer>}
 */
export async function decoratePng(png, pet, { badge = null } = {}) {
  if (!Buffer.isBuffer(png) || png.length < 8) return png;
  // 非 PNG（例如调用方传错格式）交给推送链路去报错，这里不抢答
  if (png[0] !== 0x89 || png.toString('ascii', 1, 4) !== 'PNG') return png;
  const meta = await sharp(png).metadata();
  if (meta.width !== 400 || meta.height !== 300) return png;

  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const slot = findBadgeSlot(data, info.width, info.height, info.channels);

  const overlay = await sharp(badge ?? await renderPetBadge(pet))
    .resize(BADGE_WIDTH, BADGE_HEIGHT)
    .png()
    .toBuffer();
  return sharp(png)
    .composite([{ input: overlay, left: slot.x, top: slot.y }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
