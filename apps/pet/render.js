// 宠物卡片与徽章的绘制。所有坐标都按 400×300 设备画布设计，
// 徽章单独画在一张小画布上，再由 overlay.js 贴到别的应用图上。
//
// 形象来自 image/ 目录下的柯基单色 PNG（256×256 白底）；
// 具体用哪一张由 sprites.js 按饥饿/精力/心情/互动状态决定。

import { createCanvas } from '@napi-rs/canvas';
import {
  createDeviceCanvas, exportPng, font, fitText, roundRect, line, WIDTH, HEIGHT,
} from '../shared/canvas.js';
import { levelOf, levelProgress, moodLine, recentAction, stageOf } from './growth.js';
import { loadSprite, spriteFor, spriteLabel } from './sprites.js';

const MARGIN = 22;
export const BADGE_WIDTH = 88;
export const BADGE_HEIGHT = 40;

// 不同成长阶段用不同画幅，幼崽小、成年最大、长老略收一点
const STAGE_ART = { baby: 118, teen: 132, adult: 150, elder: 142 };

function drawBar(ctx, x, y, width, value, { height = 7, radius = 3.5 } = {}) {
  roundRect(ctx, x, y, width, height, radius, { fill: '#ffffff', stroke: '#000000', lineWidth: 1 });
  const ratio = Math.min(1, Math.max(0, value / 100));
  const inner = Math.max(0, width * ratio);
  if (inner > 1) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, inner, height);
    ctx.clip();
    ctx.fillStyle = '#000000';
    ctx.fillRect(x, y, width, height);
    ctx.restore();
  }
}

/** 幼崽脚边的小毛线球：圆球里绕几圈线，再拖出一截线头 */
function drawYarnBall(ctx, cx, cy, radius = 9) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 球面绕线
  ctx.save();
  ctx.clip();
  ctx.lineWidth = 1;
  for (const offset of [-5, 0, 5]) {
    ctx.beginPath();
    ctx.moveTo(cx - radius - 1, cy + offset - 3);
    ctx.quadraticCurveTo(cx, cy + offset + 5, cx + radius + 1, cy + offset - 3);
    ctx.stroke();
  }
  ctx.restore();

  // 线头
  ctx.beginPath();
  ctx.moveTo(cx + radius - 2, cy + radius - 6);
  ctx.quadraticCurveTo(cx + radius + 5, cy + radius, cx + radius + 2, cy + radius + 5);
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

/** 少年脚边的小骨头：中间一根骨头棒，两头各两个圆 */
function drawBone(ctx, cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.16);
  roundRect(ctx, -10, -3.6, 20, 7.2, 3, { fill: '#ffffff', stroke: '#000000', lineWidth: 1.2 });
  for (const [dx, dy] of [[-10, -3.4], [-10, 3.4], [10, -3.4], [10, 3.4]]) {
    ctx.beginPath();
    ctx.arc(dx, dy, 3.1, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  ctx.restore();
}

/** 长老的软垫：一块浅灰椭圆垫子，加两道淡淡的褶皱 */
function drawCushion(ctx, cx, cy, rx) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, 11, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ededed';
  ctx.fill();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = '#a8a8a8';
  ctx.lineWidth = 1;
  for (const dx of [-26, 26]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx, cy - 4);
    ctx.lineTo(cx + dx, cy + 4);
    ctx.stroke();
  }
}

/** 小图案公共样式：黑色细线 + 白底，画在 (x, y) 左上角的 24×24 盒子里 */
const ART_STROKE = { stroke: '#000000', lineWidth: 1.4 };

function artCircle(ctx, cx, cy, r, fill = '#ffffff') {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = ART_STROKE.stroke;
  ctx.lineWidth = ART_STROKE.lineWidth;
  ctx.stroke();
}

function artRoundedStrip(ctx, x, y, w, h, angle) {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(angle);
  roundRect(ctx, -w / 2, -h / 2, w, h, h / 2, { fill: '#ffffff', ...ART_STROKE });
  ctx.restore();
}

/**
 * 互动动作的小图案（24×24，线条风，墨水屏可辨）：
 * 喂食：jerky 肉干 / bowl 狗粮盆 / fish 小鱼干 / apple 苹果 / bone 磨牙骨 / cookie 饼干；
 * 玩耍：yarn 毛线球 / frisbee 飞盘 / butterfly 蝴蝶 / tennis 网球 / rope 绳结 / bubble 泡泡。
 */
export function drawActionArt(ctx, key, x, y) {
  ctx.save();
  ctx.translate(x, y);

  switch (key) {
    case 'jerky': // 两根肉干条
      artRoundedStrip(ctx, 3, 4, 6, 15, 0.22);
      artRoundedStrip(ctx, 13, 5, 6, 15, -0.18);
      break;
    case 'bowl': // 狗粮盆：上面的粮堆 + 梯形盆身
      ctx.beginPath();
      ctx.arc(12, 11, 6.5, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = ART_STROKE.stroke;
      ctx.lineWidth = ART_STROKE.lineWidth;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(12, 11, 9.5, 2.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4, 12);
      ctx.lineTo(6, 20);
      ctx.quadraticCurveTo(12, 23, 18, 20);
      ctx.lineTo(20, 12);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
      break;
    case 'fish': // 小鱼干：身体 + 三角尾 + 眼睛
      ctx.beginPath();
      ctx.ellipse(9.5, 12, 7, 4.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = ART_STROKE.stroke;
      ctx.lineWidth = ART_STROKE.lineWidth;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(15.5, 12);
      ctx.lineTo(21.5, 7.5);
      ctx.lineTo(21.5, 16.5);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
      artCircle(ctx, 6.8, 11, 1, '#000000');
      break;
    case 'apple': // 苹果 + 果柄 + 叶子
      artCircle(ctx, 12, 14, 7.5);
      ctx.beginPath();
      ctx.moveTo(12, 7);
      ctx.quadraticCurveTo(12.5, 4.5, 14, 3.5);
      ctx.strokeStyle = ART_STROKE.stroke;
      ctx.lineWidth = ART_STROKE.lineWidth;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(16.5, 5.5, 3, 1.6, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
      break;
    case 'bone': // 磨牙骨：中间骨棒 + 两头各两个圆
      ctx.save();
      ctx.translate(12, 12);
      ctx.rotate(-0.35);
      roundRect(ctx, -7.5, -2.6, 15, 5.2, 2.4, { fill: '#ffffff', ...ART_STROKE });
      for (const [dx, dy] of [[-7.5, -2.4], [-7.5, 2.4], [7.5, -2.4], [7.5, 2.4]]) {
        artCircle(ctx, dx, dy, 2.3);
      }
      ctx.restore();
      break;
    case 'cookie': // 饼干：圆饼 + 四粒点缀
      artCircle(ctx, 12, 12, 8.5);
      ctx.fillStyle = '#000000';
      for (const [dx, dy] of [[8.5, 9.5], [15, 10], [9.5, 15], [14.5, 14.5]]) {
        ctx.beginPath();
        ctx.arc(dx, dy, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'yarn': // 毛线球：球体绕线 + 线头
      artCircle(ctx, 12, 11.5, 7.5);
      ctx.save();
      ctx.beginPath();
      ctx.arc(12, 11.5, 7.5, 0, Math.PI * 2);
      ctx.clip();
      ctx.lineWidth = 1;
      for (const offset of [-4, 0, 4]) {
        ctx.beginPath();
        ctx.moveTo(3.5, 8.5 + offset);
        ctx.quadraticCurveTo(12, 13 + offset, 20.5, 8.5 + offset);
        ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(18, 17);
      ctx.quadraticCurveTo(21, 19, 20, 22);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      break;
    case 'frisbee': // 飞盘：外沿椭圆 + 内圈
      ctx.beginPath();
      ctx.ellipse(12, 12, 10, 4.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = ART_STROKE.stroke;
      ctx.lineWidth = ART_STROKE.lineWidth;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(12, 12, 5, 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'butterfly': // 蝴蝶：竖身 + 四片圆翅 + 触角
      ctx.beginPath();
      ctx.moveTo(12, 7);
      ctx.lineTo(12, 19);
      ctx.strokeStyle = ART_STROKE.stroke;
      ctx.lineWidth = ART_STROKE.lineWidth;
      ctx.stroke();
      for (const [dx, dy] of [[7.5, 9.5], [16.5, 9.5], [8.5, 15.5], [15.5, 15.5]]) {
        artCircle(ctx, dx, dy, 3.4);
      }
      ctx.lineWidth = 1;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(12, 6.5);
        ctx.quadraticCurveTo(12 + dir * 2.5, 3.5, 12 + dir * 4, 3);
        ctx.stroke();
      }
      break;
    case 'tennis': // 网球：球体 + 两条缝线
      artCircle(ctx, 12, 12, 8.5);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(4.5, 12, 7, -Math.PI / 3, Math.PI / 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(19.5, 12, 7, Math.PI - Math.PI / 3, Math.PI + Math.PI / 3);
      ctx.stroke();
      break;
    case 'rope': // 绳结：一根绳斜着穿过绳圈
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(4, 20);
      ctx.lineTo(20, 4);
      ctx.stroke();
      // 白底绳圈盖在绳线上，像绳头从圈里穿过去
      artCircle(ctx, 12, 12, 5);
      break;
    case 'bubble': // 泡泡：三颗大小不一的泡泡 + 高光弧
      artCircle(ctx, 8.5, 9, 5);
      artCircle(ctx, 17, 13.5, 3.6);
      artCircle(ctx, 9.5, 18.5, 2.6);
      ctx.lineWidth = 1;
      for (const [cx, cy, r] of [[8.5, 9, 5], [17, 13.5, 3.6]]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r - 1.6, Math.PI * 1.1, Math.PI * 1.5);
        ctx.stroke();
      }
      break;
    default: // 未知 key 退化为爪印
      artCircle(ctx, 12, 13, 4.2);
      for (const [dx, dy] of [[6.5, 7.5], [10.5, 5.5], [14.5, 6.5], [17, 10]]) {
        artCircle(ctx, dx, dy, 1.8);
      }
  }

  ctx.restore();
}

/**
 * 宠物状态卡：左半边是它，右半边是数据。
 * @param {object} pet normalizeState 后的状态
 * @param {number} now
 * @param {{notice?: string}} [options] notice 非空时，底部动态行换成醒目的提示条
 *   （设备按键打到冷却中的操作时用：「刚喂食过，8 分钟后再来哦」）
 * @returns {Promise<Buffer>} 400×300 PNG
 */
export async function renderPetCard(pet, now = Date.now(), { notice } = {}) {
  const { canvas, ctx, scale } = createDeviceCanvas();
  const stage = stageOf(pet.bornAt, now);
  const spriteKey = spriteFor(pet, now);
  const sprite = await loadSprite(spriteKey);

  // 页眉
  const ageText = `第 ${stage.ageDays + 1} 天`;
  ctx.font = font(12);
  ctx.fillStyle = '#5a5a5a';
  ctx.fillText(ageText, WIDTH - MARGIN - ctx.measureText(ageText).width, 18);

  // 左：柯基与当前状态的短标签。不同阶段换一点构图：
  // 幼崽站地面、少年多一根骨头、成年加竖向分隔线、长老坐在软垫上。
  const artCenter = 104;
  const artSize = STAGE_ART[stage.key] ?? STAGE_ART.adult;
  const elder = stage.key === 'elder';
  const artBottom = elder ? 224 : 232;
  const artTop = artBottom - artSize;

  if (elder) {
    drawCushion(ctx, artCenter, artBottom + 6, artSize / 2 + 10);
  } else {
    ctx.beginPath();
    ctx.ellipse(artCenter, artBottom + 4, artSize * 0.34, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e4e4e4';
    ctx.fill();
  }

  ctx.drawImage(sprite, artCenter - artSize / 2, artTop, artSize, artSize);

  if (stage.key === 'baby') drawYarnBall(ctx, artCenter + artSize / 2 + 10, artBottom - 6);
  if (stage.key === 'teen') drawBone(ctx, artCenter + artSize / 2 + 12, artBottom - 6);
  if (stage.key === 'adult' || elder) line(ctx, 196, 40, 196, elder ? 240 : 232, '#000000', 1);

  const stateLabel = spriteLabel(spriteKey);
  ctx.font = font(10);
  const pillWidth = Math.max(46, Math.ceil(ctx.measureText(stateLabel).width) + 20);
  roundRect(ctx, artCenter - pillWidth / 2, 52, pillWidth, 16, 8, {
    fill: '#ffffff', stroke: '#000000', lineWidth: 1,
  });
  ctx.fillStyle = '#000000';
  ctx.font = font(10);
  ctx.textAlign = 'center';
  ctx.fillText(stateLabel, artCenter, 55);
  ctx.textAlign = 'left';

  // 右：名字与等级
  const x = 214;
  const right = WIDTH - MARGIN;
  ctx.fillStyle = '#000000';
  ctx.font = font(26);
  ctx.fillText(fitText(ctx, pet.name, font(26), right - x), x, 44);

  const level = levelOf(pet.exp);
  ctx.font = font(12);
  ctx.fillStyle = '#3c3c3c';
  ctx.fillText(`${stage.name} · Lv.${level}`, x, 80);

  // 等级经验条
  drawBar(ctx, x, 100, right - x, levelProgress(pet.exp).percent, { height: 4, radius: 2 });

  // 三项数值
  const stats = [
    ['饱食', pet.hunger],
    ['心情', pet.mood],
    ['精力', pet.energy],
  ];
  let y = 124;
  for (const [label, value] of stats) {
    ctx.font = font(11);
    ctx.fillStyle = '#000000';
    ctx.fillText(label, x, y);
    drawBar(ctx, x + 32, y + 1, 92, value, { height: 6, radius: 3 });
    const text = `${Math.round(value)}`;
    ctx.font = font(10);
    ctx.fillStyle = '#5a5a5a';
    ctx.fillText(text, right - ctx.measureText(text).width, y);
    y += 25;
  }

  // 连续陪伴
  ctx.font = font(11);
  ctx.fillStyle = '#5a5a5a';
  ctx.fillText(`连续陪伴 ${pet.streak || 0} 天`, x, 202);

  // 分隔线与底部一行：默认显示「它正在做什么」；
  // 2 分钟内有过互动时，行首画出对应动作图案、后面换成这次互动的台词；
  // 有 notice（按键打到冷却中）时换成黑底白字提示条，按了键必须看得见反应
  line(ctx, MARGIN, 246, WIDTH - MARGIN, 246, '#000000', 1);
  if (notice) {
    const text = fitText(ctx, notice, font(12, 'bold'), WIDTH - MARGIN * 2 - 24);
    const pillW = Math.ceil(ctx.measureText(text).width) + 24;
    const pillX = (WIDTH - pillW) / 2;
    roundRect(ctx, pillX, 251, pillW, 21, 10, { fill: '#000000', stroke: '#000000', lineWidth: 1 });
    ctx.font = font(12, 'bold');
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(text, WIDTH / 2, 256);
    ctx.textAlign = 'left';
  } else {
    const recent = recentAction(pet, now);
    let textX = MARGIN;
    if (recent?.art) {
      drawActionArt(ctx, recent.art, MARGIN, 250);
      textX = MARGIN + 30;
    }
    const text = recent ? recent.message : moodLine(pet, now);
    ctx.font = font(12);
    ctx.fillStyle = '#000000';
    const activity = fitText(ctx, text, font(12), WIDTH - MARGIN - textX);
    ctx.fillText(activity, textX, 257);
  }

  ctx.font = font(11);
  ctx.fillStyle = '#3c3c3c';
  const hint = '确认=摸摸 · 上=喂食 · 下=玩耍';
  ctx.fillText(hint, WIDTH - MARGIN - ctx.measureText(hint).width, 274);

  return exportPng(canvas, scale);
}

/**
 * 叠加到其他应用图片上的小徽章：柯基表情 + 等级 + 心情条。
 * 透明背景，交给 overlay.js 合成，不改变原图尺寸。
 */
export async function renderPetBadge(pet, now = Date.now()) {
  const scale = 3;
  const canvas = createCanvas(BADGE_WIDTH * scale, BADGE_HEIGHT * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.textBaseline = 'top';
  ctx.clearRect(0, 0, BADGE_WIDTH, BADGE_HEIGHT);

  roundRect(ctx, 1, 1, BADGE_WIDTH - 2, BADGE_HEIGHT - 2, 9, {
    fill: '#ffffff', stroke: '#000000', lineWidth: 1.2,
  });

  const sprite = await loadSprite(spriteFor(pet, now));
  ctx.drawImage(sprite, 5, 5, 30, 30);

  ctx.fillStyle = '#000000';
  ctx.font = font(11);
  ctx.fillText(`Lv.${levelOf(pet.exp)}`, 39, 7);

  // 心情条：让徽章也能表达状态，而不是一个静态图标
  drawBar(ctx, 39, 23, 41, pet.mood, { height: 4, radius: 2 });

  return canvas.toBuffer('image/png');
}

export { HEIGHT, WIDTH };
