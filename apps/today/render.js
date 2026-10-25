// 今天的渲染：400×300 灰阶版面。
//
// 版面分两栏：
//   左栏 (12..192)：天气卡 (38..208) + 穿搭卡 (216..292)
//   右栏 (204..388)：月历卡 (38..192) + 历史上的今天 (200..292)

import {
  WIDTH, HEIGHT, createDeviceCanvas, font, fitText, wrapText,
  roundRect, line, exportPng,
} from '../shared/canvas.js';
import {
  RAIN_CODES, SNOW_CODES, windLevel, dateText, monthGrid, solarTerms, WEEKDAYS,
} from './sources.js';

const BLACK = '#000000';
const WHITE = '#ffffff';
const INK = '#1c1c1c';
const MUTED = '#666666';
const FAINT = '#8a8a8a';
const HAIR = '#c4c4c4';
const CARD_LINE = '#b9b9b9';
const ICON = '#232323';

const F_TITLE = 17;
const F_CARD = 12;
const F_BODY = 12;
const F_SMALL = 10;
const F_TINY = 9;
const F_TEMP = 30;

const LEFT = { x: 12, w: 180 };
const RIGHT = { x: 204, w: 184 };

/** 天气类别：决定自绘图标画法 */
function iconKind(code, isDay) {
  if (code === 0 || code === 1) return isDay ? 'sun' : 'moon';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (SNOW_CODES.has(code)) return 'snow';
  if (code >= 95) return 'thunder';
  if (RAIN_CODES.has(code)) return 'rain';
  return 'cloud';
}

function drawCloud(ctx, cx, cy, scale = 1) {
  ctx.strokeStyle = ICON;
  ctx.fillStyle = WHITE;
  ctx.lineWidth = 2 * scale;
  const r = 9 * scale;
  ctx.beginPath();
  ctx.arc(cx - r, cy, r, Math.PI * 0.5, Math.PI * 1.5);
  ctx.arc(cx, cy - r * 0.7, r * 1.15, Math.PI * 1.05, Math.PI * 1.95);
  ctx.arc(cx + r * 1.05, cy, r * 0.95, Math.PI * 1.5, Math.PI * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawWeatherIcon(ctx, cx, cy, code, isDay) {
  const kind = iconKind(code, isDay);
  ctx.save();
  ctx.strokeStyle = ICON;
  ctx.fillStyle = ICON;
  ctx.lineWidth = 2;

  if (kind === 'sun' || kind === 'moon' || kind === 'partly') {
    const sunX = kind === 'partly' ? cx - 8 : cx;
    const sunY = kind === 'partly' ? cy - 8 : cy;
    const r = 12;
    if (kind === 'moon') {
      // 月牙：实心圆挖掉偏移圆
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx + 9, cy - 6, r + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(sunX + Math.cos(angle) * (r + 4), sunY + Math.sin(angle) * (r + 4));
        ctx.lineTo(sunX + Math.cos(angle) * (r + 10), sunY + Math.sin(angle) * (r + 10));
        ctx.stroke();
      }
    }
    if (kind === 'partly') {
      ctx.fillStyle = WHITE;
      drawCloud(ctx, cx + 8, cy + 12, 0.85);
    }
    ctx.restore();
    return;
  }

  if (kind === 'cloud') {
    drawCloud(ctx, cx, cy + 2, 1.25);
    ctx.restore();
    return;
  }

  if (kind === 'fog') {
    drawCloud(ctx, cx, cy - 6, 1.1);
    ctx.strokeStyle = ICON;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(cx - 22, cy + 14 + i * 6);
      ctx.lineTo(cx + 20, cy + 14 + i * 6);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // rain / snow / thunder 共用云 + 下方符号
  drawCloud(ctx, cx, cy - 6, 1.2);
  if (kind === 'rain') {
    ctx.strokeStyle = ICON;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 12, cy + 14);
      ctx.lineTo(cx + i * 12 - 4, cy + 24);
      ctx.stroke();
    }
  } else if (kind === 'snow') {
    for (let i = -1; i <= 1; i++) {
      const x = cx + i * 12;
      const y = cy + 19;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y + 4);
      ctx.moveTo(x + 4, y - 4);
      ctx.lineTo(x - 4, y + 4);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(cx, cy + 12);
    ctx.lineTo(cx - 6, cy + 22);
    ctx.lineTo(cx + 1, cy + 22);
    ctx.lineTo(cx - 3, cy + 32);
    ctx.lineTo(cx + 8, cy + 19);
    ctx.lineTo(cx + 1, cy + 19);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/** 温度柱状区：24 根竖条 + 时间刻度 */
function drawTemperatureChart(ctx, weather) {
  const plotLeft = 22;
  const plotRight = 182;
  const plotTop = 162;
  const plotBottom = 190;
  const tinyFont = font(F_TINY);

  ctx.fillStyle = INK;
  ctx.font = font(F_SMALL);
  ctx.textAlign = 'left';
  ctx.fillText('24h 温度', plotLeft, 151);

  ctx.fillStyle = FAINT;
  ctx.font = tinyFont;
  ctx.textAlign = 'right';
  ctx.fillText(
    `日出 ${weather.sunrise ?? '--:--'} · 日落 ${weather.sunset ?? '--:--'}`,
    plotRight,
    152,
  );

  const values = weather.hourlyTemperatures ?? [];
  if (values.length > 1) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    for (const ratio of [1, 0, 0.5]) {
      const y = plotTop + (1 - ratio) * (plotBottom - plotTop);
      line(ctx, plotLeft, y, plotRight, y, HAIR, 1);
    }
    const step = (plotRight - plotLeft) / values.length;
    const barWidth = Math.max(2, step - 1.2);
    values.forEach((value, index) => {
      const ratio = (value - min) / span;
      const barHeight = Math.max(2, ratio * (plotBottom - plotTop));
      ctx.fillStyle = INK;
      ctx.fillRect(plotLeft + index * step + 0.4, plotBottom - barHeight, barWidth, barHeight);
    });
  } else {
    line(ctx, plotLeft, plotBottom, plotRight, plotBottom, HAIR, 1);
    ctx.fillStyle = FAINT;
    ctx.font = tinyFont;
    ctx.textAlign = 'center';
    ctx.fillText('逐时温度暂不可用', (plotLeft + plotRight) / 2, plotBottom - 14);
  }

  ctx.fillStyle = MUTED;
  ctx.font = tinyFont;
  ctx.textAlign = 'center';
  for (const [ratio, label] of [[0, '00'], [0.25, '06'], [0.5, '12'], [0.75, '18'], [1, '24']]) {
    ctx.fillText(label, plotLeft + ratio * (plotRight - plotLeft), 191);
  }
  ctx.textAlign = 'left';
}

function drawWeatherCard(ctx, brief) {
  const { weather } = brief;
  roundRect(ctx, LEFT.x, 38, LEFT.w, 170, 8, { stroke: CARD_LINE, lineWidth: 1 });
  ctx.fillStyle = INK;
  ctx.font = font(F_CARD);
  ctx.textAlign = 'left';
  ctx.fillText(brief.tomorrow ? '明日天气' : '今日天气', 22, 45);

  ctx.fillStyle = MUTED;
  ctx.font = font(F_SMALL);
  ctx.textAlign = 'right';
  ctx.fillText(`AQI ${weather.aqi ?? 0} · ${weather.aqiLevel ?? '—'}`, 182, 47);
  ctx.textAlign = 'left';

  drawWeatherIcon(ctx, 150, 80, weather.code, weather.isDay);

  ctx.fillStyle = INK;
  ctx.font = font(F_TEMP);
  ctx.fillText(`${Math.round(weather.current)}℃`, 22, 64);

  ctx.font = font(F_BODY);
  const condition = String(weather.condition ?? '');
  ctx.fillText(fitText(
    ctx,
    `${Math.round(weather.low)}~${Math.round(weather.high)}℃  ${condition}`,
    font(F_BODY),
    108,
  ), 22, 98);

  ctx.fillStyle = MUTED;
  ctx.font = font(F_SMALL);
  if (weather.forecast) {
    ctx.fillText('次日预报', 22, 120);
    ctx.fillText(`降水 ${weather.rainProbability ?? 0}%`, 108, 120);
    ctx.fillText(`温度 ${Math.round(weather.low)}~${Math.round(weather.high)}℃`, 22, 133);
    ctx.fillText(`日出 ${weather.sunrise ?? '--:--'}`, 108, 133);
  } else {
    ctx.fillText(`湿度 ${weather.humidity ?? 0}%`, 22, 120);
    ctx.fillText(`降水 ${weather.rainProbability ?? 0}%`, 108, 120);
    ctx.fillText(`风力 ${windLevel(weather.windSpeed)}级`, 22, 133);
    ctx.fillText(`体感 ${Math.round(weather.feels ?? weather.current)}℃`, 108, 133);
  }

  drawTemperatureChart(ctx, weather);
}

function drawClothingCard(ctx, brief) {
  const clothing = brief.clothing ?? {};
  roundRect(ctx, LEFT.x, 216, LEFT.w, 76, 8, { stroke: CARD_LINE, lineWidth: 1 });

  ctx.fillStyle = INK;
  ctx.font = font(F_CARD);
  ctx.textAlign = 'left';
  ctx.fillText(brief.tomorrow ? '明日穿搭' : '穿搭建议', 22, 223);

  ctx.fillStyle = MUTED;
  ctx.font = font(F_SMALL);
  ctx.textAlign = 'right';
  ctx.fillText(clothing.element ? `五行 ${clothing.element}` : '', 182, 225);
  ctx.textAlign = 'left';

  const advice = clothing.advice ?? '天气数据暂不可用';
  ctx.fillStyle = INK;
  ctx.font = font(11);
  wrapText(ctx, advice, font(11), 160, 2).forEach((text, index) => {
    ctx.fillText(text, 22, 241 + index * 13);
  });

  const good = clothing.colors?.['合'] ?? [];
  const bad = clothing.colors?.['忌'] ?? [];
  if (good.length || bad.length) {
    const parts = [];
    if (good.length) parts.push(`宜 ${good.join('/')}`);
    if (bad.length) parts.push(`忌 ${bad.join('/')}`);
    ctx.fillStyle = MUTED;
    ctx.font = font(F_SMALL);
    ctx.fillText(fitText(ctx, parts.join('  ·  '), font(F_SMALL), 160), 22, 272);
  }
}

function drawCalendarCard(ctx, brief) {
  const { date, almanac, holiday } = brief;
  const grid = monthGrid(date);
  roundRect(ctx, RIGHT.x, 38, RIGHT.w, 170, 8, { stroke: CARD_LINE, lineWidth: 1 });

  ctx.fillStyle = INK;
  ctx.font = font(13);
  ctx.textAlign = 'left';
  ctx.fillText(`${date.year}年${date.month}月`, 214, 45);

  ctx.fillStyle = FAINT;
  ctx.font = font(F_SMALL);
  ctx.textAlign = 'right';
  const note = almanac?.lunar ? `农历${almanac.lunar}` : (holiday?.label ?? '');
  ctx.fillText(fitText(ctx, note, font(F_SMALL), 96), 378, 48);
  ctx.textAlign = 'left';

  const innerLeft = 214;
  const innerRight = 378;
  const colWidth = (innerRight - innerLeft) / 7;
  const centerX = (index) => innerLeft + colWidth * (index + 0.5);

  ctx.font = font(F_SMALL);
  ctx.textAlign = 'center';
  WEEKDAYS.forEach((label, index) => {
    ctx.fillStyle = index >= 5 ? FAINT : MUTED;
    ctx.fillText(label, centerX(index), 68);
  });
  line(ctx, innerLeft, 81, innerRight, 81, HAIR, 1);

  // 节气日画一个小圆点做标记，没有节气的月份不出现
  const ym = `${date.year}-${String(date.month).padStart(2, '0')}`;
  const termDays = new Set(
    solarTerms(date.year)
      .filter((term) => term.date.slice(0, 7) === ym)
      .map((term) => Number(term.date.slice(8))),
  );

  const rowHeight = 19.5;
  const startY = 86;
  grid.cells.forEach((day, index) => {
    if (!day) return;
    const row = Math.floor(index / 7);
    const col = index % 7;
    const x = centerX(col);
    const y = startY + row * rowHeight;
    const weekend = col >= 5;
    const isToday = day === date.day;

    if (isToday) {
      roundRect(ctx, x - 9, y - 1, 18, 14, 3, { fill: BLACK, stroke: null });
      ctx.fillStyle = WHITE;
    } else {
      ctx.fillStyle = weekend ? FAINT : INK;
    }
    ctx.font = font(F_SMALL);
    ctx.textAlign = 'center';
    ctx.fillText(String(day), x, y + 3);

    if (termDays.has(day) && !isToday) {
      ctx.beginPath();
      ctx.fillStyle = FAINT;
      ctx.arc(x, y + 15, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.textAlign = 'left';
}

function drawHistoryCard(ctx, brief) {
  roundRect(ctx, RIGHT.x, 216, RIGHT.w, 76, 8, { stroke: CARD_LINE, lineWidth: 1 });

  ctx.fillStyle = INK;
  ctx.font = font(F_CARD);
  ctx.textAlign = 'left';
  ctx.fillText('历史上的今天', 214, 223);

  ctx.fillStyle = FAINT;
  ctx.font = font(F_TINY);
  ctx.textAlign = 'right';
  ctx.fillText('百度百科', 378, 225);
  ctx.textAlign = 'left';
  line(ctx, 214, 236, 378, 236, HAIR, 1);

  const history = Array.isArray(brief.history) ? brief.history.slice(0, 2) : [];
  const centerX = RIGHT.x + RIGHT.w / 2;
  if (!history.length) {
    ctx.fillStyle = MUTED;
    ctx.font = font(11);
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据，联网后自动补全', centerX, 246);
    ctx.fillStyle = FAINT;
    ctx.font = font(F_TINY);
    ctx.fillText('可以点「重新生成」再试一次', centerX, 262);
    ctx.textAlign = 'left';
    return;
  }

  history.forEach((item, index) => {
    const blockY = 242 + index * 26;
    ctx.fillStyle = MUTED;
    ctx.font = font(F_SMALL);
    ctx.fillText(fitText(ctx, String(item.year ?? ''), font(F_SMALL), 26), 214, blockY + 1);

    ctx.fillStyle = INK;
    ctx.font = font(11);
    wrapText(ctx, item.title ?? '', font(11), 136, 2).forEach((text, lineIndex) => {
      ctx.fillText(text, 242, blockY + lineIndex * 12);
    });
  });
  ctx.textAlign = 'left';
}

/**
 * 渲染一张「今天」卡片。
 * @param {object} brief buildBrief() 的返回值，另加 terms: {prev,next}
 * @param {{binarize?: boolean}} [options] 默认输出灰阶抗锯齿，交给推送管线按设备色板量化
 * @returns {Buffer} PNG
 */
export function renderBrief(brief, options = {}) {
  const { canvas, ctx, scale } = createDeviceCanvas({ background: WHITE });
  const { binarize: doBinarize = false } = options;

  // 顶部：地点 + 完整日期
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.font = font(18);
  const label = brief.location?.label ?? '未知地点';
  ctx.fillText(fitText(ctx, label, font(18), 150), 12, 4);

  ctx.fillStyle = MUTED;
  ctx.font = font(F_SMALL);
  ctx.textAlign = 'right';
  ctx.fillText(fitText(ctx, dateText(brief.date, brief.tomorrow), font(F_SMALL), 214), 388, 9);
  ctx.textAlign = 'left';

  line(ctx, 12, 30, 388, 30, BLACK, 1.5);

  drawWeatherCard(ctx, brief);
  drawClothingCard(ctx, brief);
  drawCalendarCard(ctx, brief);
  drawHistoryCard(ctx, brief);

  return exportPng(canvas, scale, { ...options, binarize: doBinarize });
}

/** 数据全挂时也给一张能看的「出错了」图，而不是推一张白屏 */
export function renderFailure(message, options = {}) {
  const { canvas, ctx, scale } = createDeviceCanvas({ background: WHITE });
  ctx.fillStyle = BLACK;
  ctx.textAlign = 'left';
  ctx.font = font(F_TITLE);
  ctx.fillText('今天生成失败', 16, 14);
  line(ctx, 16, 40, 384, 40, BLACK, 1);
  ctx.font = font(F_BODY);
  wrapText(ctx, String(message).slice(0, 200), font(F_BODY), 360, 8)
    .forEach((text, index) => ctx.fillText(text, 16, 56 + index * 18));
  ctx.font = font(F_TINY);
  ctx.fillText(new Date().toLocaleString('zh-CN'), 16, 274);
  return exportPng(canvas, scale, { ...options, binarize: options.binarize === true });
}

export { WIDTH, HEIGHT };
