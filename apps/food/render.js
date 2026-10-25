// 「今天吃什么」的 400×300 单色版面。
// 墨屏没有彩色，所以用「分类字 + 大字号菜名 + 一句短评」建立层次，
// 底部固定提示按键，避免用户不知道屏幕可以继续换。

import {
  WIDTH, HEIGHT, createDeviceCanvas, font, fitText, wrapText,
  roundRect, line, exportPng,
} from '../shared/canvas.js';
import { DISHES } from './dishes.js';

const BLACK = '#000000';
const GRAY = '#555555';
const LIGHT = '#9a9a9a';

function centered(ctx, text, y, size, { color = BLACK, weight = 'normal', maxWidth = 360 } = {}) {
  ctx.fillStyle = color;
  ctx.font = font(size, weight);
  ctx.textAlign = 'center';
  ctx.fillText(fitText(ctx, text, font(size, weight), maxWidth), WIDTH / 2, y);
  ctx.textAlign = 'left';
}

/**
 * 渲染一道菜。
 * @param {{name: string, category: string, note?: string}} dish
 * @param {{rolls?: number, total?: number, binarize?: boolean}} [options]
 * @returns {Buffer} PNG
 */
export function renderDish(dish, options = {}) {
  const rolls = Number.isFinite(options.rolls) ? options.rolls : 0;
  const total = Number.isFinite(options.total) ? options.total : DISHES.length;
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });

  // 顶栏
  ctx.fillStyle = BLACK;
  ctx.font = font(16, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText('今天吃什么', 16, 10);

  ctx.fillStyle = GRAY;
  ctx.font = font(12);
  ctx.textAlign = 'right';
  ctx.fillText(rolls > 0 ? `第 ${rolls} 次纠结` : '第一次纠结', 384, 13);
  ctx.textAlign = 'left';
  line(ctx, 16, 32, 384, 32, BLACK, 1.5);

  // 分类徽记：一个描边圆角方块，里面放分类首字
  const boxX = WIDTH / 2 - 26;
  const boxY = 44;
  roundRect(ctx, boxX, boxY, 52, 52, 14, { fill: '#ffffff', stroke: BLACK, lineWidth: 1.5 });
  centered(ctx, [...(dish?.category ?? '食')][0] ?? '食', boxY + 14, 24, { weight: 'bold' });

  centered(ctx, `${dish?.category ?? '未知'} · 共 ${total} 道候选`, 104, 12, { color: GRAY });

  const nameFont = font(28, 'bold');
  const nameLines = wrapText(ctx, dish?.name ?? '还没想好', nameFont, 340, 2);
  const nameTop = nameLines.length > 1 ? 118 : 128;
  nameLines.forEach((text, index) => {
    centered(ctx, text, nameTop + index * 36, 28, { weight: 'bold', maxWidth: 340 });
  });

  const noteFont = font(13);
  const noteLines = wrapText(ctx, dish?.note ?? '再按一次，换一道新的', noteFont, 320, 2);
  const noteTop = noteLines.length > 1 ? 196 : 200;
  noteLines.forEach((text, index) => {
    centered(ctx, text, noteTop + index * 18, 13, { color: GRAY, maxWidth: 320 });
  });

  // 底部提示：只留一行，余下的交给留白
  line(ctx, 16, 240, 384, 240, LIGHT, 1);
  centered(ctx, '按一下确认键，再换一道', 264, 13, { color: GRAY, maxWidth: 360 });

  return exportPng(canvas, scale, { binarize: options.binarize === true });
}

export { WIDTH, HEIGHT };
