// 「人生指南」的 400×300 单色版面。
//
// 一张卡片只讲一条建议：顶栏是应用名+章节+序号做定位，标题给结论，正文是原文的「说人话」，
// 底部一行是成本/收益标签与证据等级，最后标注内容来源与许可。
// 标题在原文里经常很长（p95 有 53 字），所以最多排三行；正文行数随标题让位。

import {
  WIDTH, HEIGHT, createDeviceCanvas, font, textWidth, fitText, wrapText, line, exportPng,
} from '../shared/canvas.js';
import { evidenceBase } from './entries.js';

const BLACK = '#000000';
const GRAY = '#555555';
const LIGHT = '#9a9a9a';

const APP_NAME = '人生指南';
const TOP_FONT = font(11);
const APP_FONT = font(11, 'bold');

function tagLine(entry) {
  const tags = entry?.tags ?? {};
  const parts = [];
  if (tags['钱']) parts.push(`钱 ${tags['钱']}`);
  if (tags['时间']) parts.push(`时间 ${tags['时间']}`);
  if (tags['毅力']) parts.push(`毅力 ${tags['毅力']}`);
  if (tags['收益']) parts.push(`收益 ${tags['收益']}`);
  parts.push(`证据 ${evidenceBase(entry)}`);
  return parts.join(' · ');
}

/**
 * 渲染一条建议。
 * @param {object} entry entries.json 里的一条
 * @param {{position?: number, total?: number, binarize?: boolean}} [options]
 * @returns {Buffer} PNG
 */
export function renderEntry(entry, options = {}) {
  const position = Number.isFinite(options.position) ? options.position : 1;
  const total = Number.isFinite(options.total) ? options.total : 1;
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });

  // 顶栏：应用名（黑）+ 章节定位（灰）+ 当前序号（右）
  // 与掷杯筊/背单词的身份栏惯例一致：设备上翻到这张卡时，先认出是哪个应用。
  // 章节名最长 18 字，和应用名放不下时优先截章节名——应用名是定位骨架，不可省略。
  ctx.textAlign = 'left';
  ctx.font = APP_FONT;
  ctx.fillStyle = BLACK;
  ctx.fillText(APP_NAME, 16, 9);
  const appWidth = textWidth(ctx, APP_NAME, APP_FONT);
  ctx.font = TOP_FONT;
  ctx.fillStyle = GRAY;
  const chapterLabel = ` · 第 ${Number(entry?.chapterNo) || '?'} 章 · ${entry?.chapter ?? ''}`;
  // 右侧序号约占 40px，左栏总宽 384-16-40
  ctx.fillText(fitText(ctx, chapterLabel, TOP_FONT, 384 - 16 - 40 - (16 + appWidth)), 16 + appWidth, 9);
  ctx.textAlign = 'right';
  ctx.fillText(`${position}/${total}`, 384, 9);
  ctx.textAlign = 'left';
  line(ctx, 16, 27, 384, 27, BLACK, 1.5);

  // 标题：最多三行，放不下时末行省略
  const titleFont = font(15, 'bold');
  const titleLines = wrapText(ctx, entry?.title ?? '', titleFont, 368, 3);
  ctx.fillStyle = BLACK;
  // wrapText 只做度量会把 ctx.font 还原，绘制前必须重新设回标题字体，
  // 否则标题会沿用上面 11px 的顶栏字体，整张卡的层次全部塌掉
  ctx.font = titleFont;
  titleLines.forEach((text, index) => {
    ctx.fillText(text, 16, 34 + index * 19);
  });

  // 正文：标题占三行时缩到四行，避免压到底部标签
  const bodyFont = font(13);
  const bodyTop = 34 + titleLines.length * 19 + 8;
  const bodyMax = titleLines.length >= 2 ? 4 : 5;
  const bodyLines = wrapText(ctx, entry?.plain ?? '', bodyFont, 368, bodyMax);
  ctx.fillStyle = BLACK;
  ctx.font = bodyFont;
  bodyLines.forEach((text, index) => {
    ctx.fillText(text, 16, bodyTop + index * 19);
  });

  line(ctx, 16, 190, 384, 190, LIGHT, 1);

  // 成本标签 + 证据等级
  ctx.fillStyle = GRAY;
  ctx.font = font(11);
  ctx.fillText(fitText(ctx, tagLine(entry), font(11), 368), 16, 198);

  // 署名：CC BY 4.0 要求派生内容标注来源
  ctx.fillStyle = GRAY;
  ctx.font = font(11);
  ctx.fillText('来源：HowToLiveBetter · CC BY 4.0', 16, 214);

  // 底部提示
  ctx.fillStyle = GRAY;
  ctx.font = font(12);
  ctx.textAlign = 'center';
  ctx.fillText('按确认键，看下一条', WIDTH / 2, 262);
  ctx.textAlign = 'left';

  return exportPng(canvas, scale, { binarize: options.binarize === true });
}

export { WIDTH, HEIGHT, tagLine };
