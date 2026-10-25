// 背单词卡片渲染：400×300 单色。
// 四个阶段各有独立版式，原则是「答案绝不出现在 prompt/word 阶段」——
// 字符识别没把握时不提前泄漏正确拼写。

import {
  WIDTH, HEIGHT, createDeviceCanvas, font, fitText, wrapText, line, exportPng,
} from '../shared/canvas.js';
import { PHASE } from './session.js';
import { diffLetters } from './quiz.js';

const BLACK = '#000000';
const GRAY = '#555555';
const LIGHT = '#9a9a9a';

function header(ctx, view) {
  ctx.fillStyle = BLACK;
  ctx.font = font(12);
  ctx.textAlign = 'left';
  const left = [view.textbookName, view.unitName].filter(Boolean).join(' · ') || '背单词';
  ctx.fillText(fitText(ctx, left, font(12), 260), 14, 10);
  ctx.textAlign = 'right';
  ctx.fillText(`${view.index}/${view.total}`, 386, 10);
  ctx.textAlign = 'left';
  line(ctx, 14, 30, 386, 30, BLACK, 1);
}

function centered(ctx, text, y, size, { color = BLACK, weight = 'normal', maxWidth = 360 } = {}) {
  ctx.fillStyle = color;
  ctx.font = font(size, weight);
  ctx.textAlign = 'center';
  ctx.fillText(fitText(ctx, text, font(size, weight), maxWidth), WIDTH / 2, y);
  ctx.textAlign = 'left';
}

function footer(ctx, hint, extra) {
  line(ctx, 14, 246, 386, 246, LIGHT, 1);
  ctx.fillStyle = GRAY;
  ctx.font = font(13);
  ctx.textAlign = 'center';
  ctx.fillText(fitText(ctx, hint ?? '', font(13), 360), WIDTH / 2, 258);
  if (extra) {
    ctx.font = font(12);
    ctx.fillText(fitText(ctx, extra, font(12), 360), WIDTH / 2, 276);
  }
  ctx.textAlign = 'left';
}

/** 释义排两行，优先用最大字号；放不下就降一档。
 *  提示页是回忆时唯一的线索，被截断等于把线索扔掉（6000 词里有 800+ 个释义在 26px 下放不进两行）。 */
export function meaningLines(ctx, text, { sizes = [26, 22, 20], maxWidth = 340, maxLines = 2 } = {}) {
  const value = String(text ?? '');
  const total = [...value].length;
  for (const size of sizes) {
    const lines = wrapText(ctx, value, font(size), maxWidth, maxLines);
    const covered = lines.reduce((count, item) => count + [...item].length, 0);
    if (covered >= total) return { lines, size };
  }
  const size = sizes[sizes.length - 1];
  return { lines: wrapText(ctx, value, font(size), maxWidth, maxLines), size };
}

function drawPrompt(ctx, view) {
  const item = view.item ?? {};
  header(ctx, view);
  centered(ctx, view.mode === 'spelling' ? '看中文，拼出这个单词' : '看中文，回想这个单词', 52, 12, { color: GRAY });

  const { lines, size } = meaningLines(ctx, item.meaning);
  const startY = lines.length > 1 ? 100 : 112;
  lines.forEach((text, index) => centered(ctx, text, startY + index * (size + 12), size, { weight: 'bold' }));

  // 拼写模式才提示「怎么念」；翻卡模式的按键说明在底部一行里，不重复写
  if (view.mode === 'spelling') centered(ctx, '先报字母，再读整词', 196, 12, { color: GRAY });
  footer(ctx, view.hint);
}

function drawSpelling(ctx, view) {
  header(ctx, view);
  const result = view.result ?? {};
  centered(ctx, '拼写结果', 46, 13, { color: GRAY });

  const verdict = result.correct ? '✓ 正确' : result.near ? '差一个字母' : '✗ 不对';
  centered(ctx, verdict, 76, 20, { weight: 'bold' });

  // 你的答案：逐字母标出对错
  const letters = diffLetters(result.expected ?? '', result.got ?? '');
  const shown = letters.map((item) => (item.ok ? item.char : item.extra ? item.char : '·')).join(' ').toUpperCase();
  ctx.fillStyle = GRAY;
  ctx.font = font(12);
  ctx.textAlign = 'left';
  ctx.fillText('你读的', 30, 112);
  ctx.fillStyle = BLACK;
  ctx.font = font(22);
  ctx.fillText(fitText(ctx, shown || '（没听清）', font(22), 330), 30, 132);

  ctx.fillStyle = GRAY;
  ctx.font = font(12);
  ctx.fillText('正确拼写', 30, 172);
  ctx.fillStyle = BLACK;
  ctx.font = font(22);
  // 只有答对或重读机会用完后才显示正确拼写，避免泄漏
  const revealWord = result.correct || view.retried;
  ctx.fillText(fitText(ctx, revealWord ? String(result.expected ?? '').toUpperCase() : '· · ·', font(22), 330), 30, 192);

  footer(ctx, view.hint);
}

function drawWord(ctx, view) {
  const item = view.item ?? {};
  header(ctx, view);
  // 这一屏是「读出来」的提示，释义同样要给全（18px 两行最多 36 个宽度单位，覆盖全部 6000 词）
  const { lines, size } = meaningLines(ctx, item.meaning, { sizes: [18, 16] });
  const startY = lines.length > 1 ? 48 : 58;
  lines.forEach((text, index) => centered(ctx, text, startY + index * 26, size, { weight: 'bold' }));
  centered(ctx, '读出整个单词', 100, 13, { color: GRAY });
  centered(ctx, '长按语音键朗读', 122, 12, { color: GRAY });
  // 音标也不显示：它常常直接暴露拼写
  footer(ctx, view.hint);
}

function drawAnswer(ctx, view) {
  const item = view.item ?? {};
  header(ctx, view);
  centered(ctx, String(item.word ?? ''), 58, 32, { weight: 'bold' });
  if (item.phonetic) centered(ctx, String(item.phonetic), 104, 14, { color: GRAY });

  const lines = wrapText(ctx, String(item.meaning ?? ''), font(17), 340, 2);
  lines.forEach((text, index) => centered(ctx, text, 138 + index * 24, 17));

  if (view.result && !view.result.correct) {
    centered(ctx, `拼写：${String(view.result.expected ?? '').toUpperCase()}`, 186, 12, { color: GRAY });
  }
  footer(ctx, view.hint, `下次：${view.nextReview ?? '首次学习'}`);
}

function drawDone(ctx, view) {
  header(ctx, view);
  centered(ctx, '本轮完成', 52, 20, { weight: 'bold' });
  const { correct, wrong, skipped, answered } = view.counts ?? {};
  centered(ctx, `正确 ${correct ?? 0}`, 96, 18);
  centered(ctx, `错误 ${wrong ?? 0}`, 124, 18);
  if (skipped) centered(ctx, `跳过 ${skipped}`, 152, 18);
  const seconds = Math.max(0, Math.round((view.elapsedMs ?? 0) / 1000));
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  centered(ctx, `共 ${answered ?? 0} 词 · 用时 ${time}`, 186, 13, { color: GRAY });
  footer(ctx, '回到网页可开始新一轮');
}

/**
 * 渲染当前阶段。
 * @param {object} view StudySession.view() 的结果（可附加 nextReview）
 * @param {{binarize?: boolean}} [options]
 * @returns {Buffer} PNG
 */
export function renderCard(view, options = {}) {
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });
  switch (view.phase) {
    case PHASE.SPELLING:
      drawSpelling(ctx, view);
      break;
    case PHASE.WORD:
      drawWord(ctx, view);
      break;
    case PHASE.ANSWER:
      drawAnswer(ctx, view);
      break;
    case PHASE.DONE:
      drawDone(ctx, view);
      break;
    default:
      drawPrompt(ctx, view);
  }
  return exportPng(canvas, scale, { ...options, binarize: options.binarize === true });
}

/** 出错了也给一张能看的图 */
export function renderMessage(title, message) {
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });
  ctx.fillStyle = BLACK;
  ctx.font = font(17);
  ctx.textAlign = 'left';
  ctx.fillText(fitText(ctx, title, font(17), 360), 16, 14);
  line(ctx, 16, 40, 384, 40, BLACK, 1);
  ctx.font = font(13);
  wrapText(ctx, message, font(13), 360, 8).forEach((text, index) => ctx.fillText(text, 16, 58 + index * 20));
  return exportPng(canvas, scale);
}
