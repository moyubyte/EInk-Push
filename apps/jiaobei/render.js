// 「掷杯筊」的 400×300 设备版面。
//
// 杯筊用 SVG 画：两块半月形的筊并排，靠「平面朝上 / 凸面朝上」的剪影区分结果。
// SVG 按 3× 像素尺寸声明宽高再合成到超采样画布上，降采样后边缘仍然是平滑灰阶，
// 不会像位图放大那样糊成一团。

import { loadImage } from '@napi-rs/canvas';
import {
  WIDTH, HEIGHT, createDeviceCanvas, font, fitText, line, exportPng,
} from '../shared/canvas.js';
import { FACES } from './outcomes.js';

const BLACK = '#000000';
const GRAY = '#555555';
const LIGHT = '#9a9a9a';

// 图案逻辑尺寸：320×80 的视框铺满 400 宽，按 1.25 倍落到卡片上。
// 视框从 y=0 起包含了±7° 旋转后出界的筊角，否则图案顶端会被裁平。
const ART_VIEW = { x: 0, y: 0, width: 320, height: 80 };
const ART_DRAW = { x: 0, y: 72, width: 400, height: 100 };

function centered(ctx, text, y, size, { color = BLACK, weight = 'normal', maxWidth = 368 } = {}) {
  const spec = font(size, weight);
  ctx.fillStyle = color;
  ctx.font = spec;
  ctx.textAlign = 'center';
  ctx.fillText(fitText(ctx, text, spec, maxWidth), WIDTH / 2, y);
  ctx.textAlign = 'left';
}

/**
 * 单块杯筊的剪影（月牙形，一黑一白）。
 * convex = 凸面朝上：黑色月牙拱背朝天，两端筊角点地，左上白色高光弧带出球面；
 * flat   = 平面朝上：白色月牙凹面朝天，两端筊角翘起，干净的月牙开口。
 * 一黑一白、一拱一凹，都是月牙，单色屏上一眼可辨。
 */
function blockSvg(face, ghost) {
  const ink = ghost ? '#b8b8bd' : BLACK;
  const dash = ghost ? ' stroke-dasharray="6 4"' : '';

  if (face === FACES.CONVEX) {
    return [
      `<path d="M8 66 C8 36 30 10 60 10 C90 10 112 36 112 66 C100 50 84 42 60 42 C36 42 20 50 8 66 Z"`
        + ` fill="${ghost ? '#ffffff' : BLACK}" stroke="${ink}" stroke-width="3.6" stroke-linejoin="round"${dash}/>`,
      `<path d="M30 22 C36 14 47 11 58 11" fill="none"`
        + ` stroke="${ghost ? '#d2d2d7' : '#ffffff'}" stroke-width="2.6" stroke-linecap="round"/>`,
    ].join('');
  }
  return [
    `<path d="M8 12 C10 44 30 72 60 72 C90 72 110 44 112 12 C100 28 84 38 60 38 C36 38 20 28 8 12 Z"`
      + ` fill="#ffffff" stroke="${ink}" stroke-width="3.6" stroke-linejoin="round"${dash}/>`,
  ].join('');
}

/**
 * 生成杯筊图案的 SVG 字符串。
 * @param {{faces: string[]}|null} outcome 结果；null 表示还没掷（画灰色虚线的静置态）
 * @param {{scale?: number, width?: number, height?: number}} [options]
 */
export function buildJiaobeiSvg(outcome, options = {}) {
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 3;
  const width = Number(options.width) > 0 ? Number(options.width) : ART_DRAW.width;
  const height = Number(options.height) > 0 ? Number(options.height) : ART_DRAW.height;
  const ghost = !outcome;
  const faces = outcome?.faces ?? [FACES.FLAT, FACES.FLAT];
  const view = `viewBox="${ART_VIEW.x} ${ART_VIEW.y} ${ART_VIEW.width} ${ART_VIEW.height}"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" ${view}>`,
    `<g transform="translate(20 0) rotate(-7 60 40)">${blockSvg(faces[0], ghost)}</g>`,
    `<g transform="translate(180 0) rotate(7 60 40)">${blockSvg(faces[1], ghost)}</g>`,
    '</svg>',
  ].join('');
}

/**
 * 渲染一张杯筊卡片。
 * @param {{name: string, faceNote: string, verdict: string, faces: string[]}|null} outcome
 * @param {{throws?: number, binarize?: boolean}} [options]
 * @returns {Promise<Buffer>} PNG
 */
export async function renderJiaobei(outcome, options = {}) {
  const throws = Number.isFinite(options.throws) ? options.throws : 0;
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });

  // 顶栏
  ctx.fillStyle = BLACK;
  ctx.font = font(16, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText('掷杯筊', 16, 10);

  ctx.fillStyle = GRAY;
  ctx.font = font(12);
  ctx.textAlign = 'right';
  ctx.fillText(throws > 0 ? `第 ${throws} 次请问` : '尚未掷杯', 384, 13);
  ctx.textAlign = 'left';
  line(ctx, 16, 32, 384, 32, BLACK, 1.5);

  ctx.fillStyle = GRAY;
  ctx.font = font(12);
  ctx.fillText('心中默念所求，再看杯筊', 16, 36);

  // SVG 走 data URL 交给 loadImage：直接传 SVG 字符串会被当成文件/远程地址
  const svg = buildJiaobeiSvg(outcome, {
    scale,
    width: ART_DRAW.width,
    height: ART_DRAW.height,
  });
  const art = await loadImage(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
  ctx.drawImage(art, ART_DRAW.x, ART_DRAW.y, ART_DRAW.width, ART_DRAW.height);

  centered(ctx, outcome?.name ?? '静待一问', 184, 32, { weight: 'bold' });
  centered(
    ctx,
    outcome ? `${outcome.faceNote} · ${outcome.verdict}` : '按下确认键，掷出第一杯',
    216,
    13,
    { color: GRAY },
  );

  line(ctx, 16, 232, 384, 232, LIGHT, 1);
  centered(ctx, outcome ? '按确认键，再掷一次' : '按确认键，掷第一次', 242, 12, { color: GRAY });

  return exportPng(canvas, scale, { binarize: options.binarize === true });
}

export { WIDTH, HEIGHT };
