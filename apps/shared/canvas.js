// 应用共享的渲染底座：设备画布、中文字体解析、文本度量与折行。
//
// 墨水屏是 400×300 单色/灰阶面板，所有应用都按这个尺寸作画。
// 中文字体是跨平台部署最容易踩的坑：NAS 上通常没有装 CJK 字体，
// 这时 canvas 会画出一排方块。所以这里按「用户覆盖 → 本机字体目录 → 系统候选」顺序解析，
// 解析不到就明确报一个可读的错误，而不是静默输出乱码图。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WIDTH = 400;
export const HEIGHT = 300;
export const FAMILY = 'ZX-CJK';

/**
 * 可选字体：`noto` 用系统 CJK 字体，其余是随仓库分发的字体文件（apps/shared/fonts）。
 * 霞鹜文楷分发文件本身就是 Bold；京华老宋体只有常规字重，所以强制按粗体合成，
 * 否则在 1bpp 墨屏上细笔画会被阈值切碎。
 */
export const FONT_OPTIONS = [
  { key: 'noto', name: '思源黑体', note: '默认 · 小字最清晰', file: null, family: FAMILY, weight: null },
  {
    key: 'wenkai',
    name: '霞鹜文楷',
    note: '楷体 · 自带粗体，笔画舒展',
    file: 'LXGWWenKai-Bold.ttf',
    family: 'ZX-WENKAI',
    weight: null,
  },
  {
    key: 'jinhua',
    name: '京华老宋体',
    note: '复古铅印宋体 · 仅常规字重，按粗体合成',
    file: 'KingHwaOldSong.ttf',
    family: 'ZX-JINHUA',
    weight: 'bold',
  },
];

const BUNDLED_DIR = path.join(__dirname, 'fonts');
const BUNDLED_FILES = new Set(FONT_OPTIONS.map((item) => item.file).filter(Boolean));
const registered = new Map(); // key -> family | null
let activeKey = 'noto';

/** 注册随仓库分发的字体（进程内一次）；缺文件只记为不可用，不影响默认字体 */
function registerBundled() {
  if (registered.size) return;
  for (const option of FONT_OPTIONS) {
    if (!option.file) {
      registered.set(option.key, null);
      continue;
    }
    const file = path.join(BUNDLED_DIR, option.file);
    try {
      registered.set(
        option.key,
        fs.existsSync(file) && GlobalFonts.registerFromPath(file, option.family) ? option.family : null,
      );
    } catch {
      registered.set(option.key, null);
    }
  }
}

/** 字体选项（含是否可用），供页面渲染选择器 */
export function getFontOptions() {
  registerBundled();
  return FONT_OPTIONS.map(({ key, name, note }) => ({
    key: key,
    name,
    note,
    available: key === 'noto' || Boolean(registered.get(key)),
  }));
}

export function getFontChoice() {
  return activeKey;
}

/**
 * 切换设备图字体；缺字体文件时回退默认，未知 key 直接报错。
 * @returns {'noto'|'wenkai'|'jinhua'} 实际生效的字体
 */
export function setFontChoice(key) {
  registerBundled();
  const option = FONT_OPTIONS.find((item) => item.key === key);
  if (!option) throw new Error(`未知字体: ${key}`);
  if (key !== 'noto' && !registered.get(key)) {
    console.warn(`[canvas] 字体 ${key} 不可用（缺少 ${option.file}），本次使用默认字体`);
    activeKey = 'noto';
    return activeKey;
  }
  activeKey = key;
  return activeKey;
}

/** 系统候选字体：覆盖 Windows / macOS / 常见 Linux 发行版与 NAS 套件
 *  顺序即优先级：Noto Sans SC / 思源黑体笔画均匀、字形方正，11～13px 二值化后
 *  比微软雅黑更少粘连，所以排在最前；雅黑/苹方作为后续兜底。 */
const SYSTEM_FONTS = [
  // 首选：Noto Sans SC（Windows 自带可变字体；Linux 发行版常见的 Noto Sans CJK）
  'C:/Windows/Fonts/NotoSansSC-VF.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  // Windows
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/Deng.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  // macOS
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
  // Linux / NAS（群晖、树莓派、大多数容器的基础镜像常见字体）
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/volume1/@appstore/fonts/NotoSansCJK-Regular.ttc',
];

let resolved = null;

/** CJK 字体文件名特征：NAS 上的字体路径千奇百怪，按名字筛比写死路径可靠 */
const CJK_FONT_RE = /(NotoSansCJK|NotoSerifCJK|SourceHan|wqy|DroidSansFallback|msyh|simhei|simsun|PingFang|STHeiti|Hiragino|uming|ukai)/i;
const FONT_EXT_RE = /\.(ttf|otf|ttc)$/i;

/** 递归收集字体文件（优先 CJK 命名的），供没装在标准路径上的系统使用 */
function scanFonts(dir, maxDepth = 4) {
  const found = [];
  const walk = (current, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (FONT_EXT_RE.test(entry.name)) found.push(full);
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => Number(CJK_FONT_RE.test(b)) - Number(CJK_FONT_RE.test(a)));
}

/**
 * 解析并注册中文字体（进程内只做一次）。
 * @param {{fontsDir?: string}} [options] fontsDir 里放任意 .ttf/.otf/.ttc 即优先使用
 * @returns {{family: string, source: string|null, ready: boolean}}
 */
export function ensureFont(options = {}) {
  registerBundled();
  if (resolved && (!options.fontsDir || resolved.source?.startsWith(options.fontsDir))) return resolved;

  const candidates = [];
  const add = (file) => { if (file) candidates.push(file); };
  add(process.env.ZX_FONT);
  const dirs = [options.fontsDir, BUNDLED_DIR].filter(Boolean);
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir).sort()) {
        // 可选字体单独注册，不能顶替默认字体
        if (FONT_EXT_RE.test(name) && !BUNDLED_FILES.has(name)) add(path.join(dir, name));
      }
    } catch { /* 目录不存在就跳过 */ }
  }

  // 常见字体根目录：标准路径没写全时也能在 NAS 上找到 CJK 字体。
  // 只收文件名带 CJK 特征的，避免把某个纯拉丁字体注册成 FAMILY（那样中文依旧空白）。
  for (const root of [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    '/usr/share/fonts/truetype',
    path.join(os.homedir(), '.fonts'),
    path.join(os.homedir(), '.local', 'share', 'fonts'),
    '/volume1/@appstore/font',
    '/vol1/@appstore/font',
  ]) {
    if (!fs.existsSync(root)) continue;
    for (const file of scanFonts(root)) {
      if (CJK_FONT_RE.test(path.basename(file))) candidates.push(file);
    }
  }

  candidates.push(...SYSTEM_FONTS);

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const ok = GlobalFonts.registerFromPath(file, FAMILY);
      if (ok) {
        resolved = { family: FAMILY, source: file, ready: true };
        return resolved;
      }
    } catch { /* 字体损坏就换下一个 */ }
  }
  // 找不到 CJK 字体时 canvas 只会画空白，日志里必须说清楚（往 data/fonts 放一个 ttf 即可）
  console.warn('[canvas] 未找到中文字体，文字可能无法显示；请把任意中文 .ttf 放到 data/fonts 或设置 ZX_FONT');
  resolved = { family: 'sans-serif', source: null, ready: false };
  return resolved;
}

/** 当前字体的 CSS font 串（跟随页面选择的设备字体） */
export function font(size, weight = 'normal') {
  const { family } = ensureFont();
  const option = FONT_OPTIONS.find((item) => item.key === activeKey) ?? FONT_OPTIONS[0];
  const chosen = option.key === 'noto' ? family : registered.get(option.key) || family;
  const finalWeight = option.weight ?? weight;
  return `${finalWeight} ${size}px "${chosen}"`;
}

/**
 * 新建一块设备画布：白底，坐标系为左上原点、400×300 逻辑像素。
 *
 * 默认按 3 倍超采样渲染：11px 的中文在墨屏上直接画会糊，先在大画布画好再平滑降采样，
 * 保留灰阶抗锯齿边缘。设备支持 16 阶灰时（GRAY16），这些中间灰会被真实显示，
 * 笔画看起来比硬阈值二值化平滑得多。
 * @param {{background?: string, scale?: number}} [options]
 */
export function createDeviceCanvas(options = {}) {
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 3;
  const canvas = createCanvas(WIDTH * scale, HEIGHT * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = options.background || '#ffffff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.textBaseline = 'top';
  return { canvas, ctx, scale };
}

export function textWidth(ctx, text, fontSpec) {
  const prev = ctx.font;
  ctx.font = fontSpec;
  const width = ctx.measureText(String(text)).width;
  ctx.font = prev;
  return width;
}

/** 单行截断，超宽加省略号 */
export function fitText(ctx, text, fontSpec, maxWidth) {
  const value = String(text ?? '');
  if (textWidth(ctx, value, fontSpec) <= maxWidth) return value;
  const chars = [...value];
  while (chars.length > 1) {
    chars.pop();
    const candidate = chars.join('') + '…';
    if (textWidth(ctx, candidate, fontSpec) <= maxWidth) return candidate;
  }
  return '…';
}

/** 按像素宽度折行，最多 maxLines 行，溢出时末行加省略号 */
export function wrapText(ctx, text, fontSpec, maxWidth, maxLines = 3) {
  const value = String(text ?? '');
  const lines = [];
  let line = '';
  for (const char of value) {
    if (char === '\n') {
      lines.push(line);
      line = '';
      if (lines.length >= maxLines) break;
      continue;
    }
    const next = line + char;
    if (textWidth(ctx, next, fontSpec) > maxWidth && line) {
      lines.push(line);
      line = char;
      if (lines.length >= maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    // 还有没放下的内容 → 末行截断
    const consumed = lines.join('').length;
    if (consumed < [...value.replace(/\n/g, '')].length) {
      lines[maxLines - 1] = fitText(ctx, lines[maxLines - 1] + '…', fontSpec, maxWidth);
    }
  }
  return lines;
}

/** 圆角矩形（只描边，白底填充） */
export function roundRect(ctx, x, y, w, h, radius = 4, { fill = '#ffffff', stroke = '#000000', lineWidth = 1 } = {}) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

export function line(ctx, x1, y1, x2, y2, color = '#000000', width = 1) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/**
 * 硬阈值二值化：墨屏 1bpp 下，抗锯齿产生的灰边经过 FS 抖色会变成一片麻点，
 * 直接按 128 阈值切干净。
 */
export function binarize(ctx, width = WIDTH, height = HEIGHT, threshold = 128) {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    // 亮度按 Rec.709 近似，墨屏只看灰度
    const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const value = luminance < threshold ? 0 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

/** 默认锐化强度：3×3 十字 USM。实测 0.7 是激进但可控的档位——
 * 平均梯度能量 +20.6%（0.35 档为 +11.9%），强边缘上的中间灰像素从 81.7% 降到 57.6%，
 * 过冲像素（被 clamp 的白边/黑边）仅 16.7%；再往上（1.0）边际收益快速衰减、
 * 过冲继续涨，白边风险失去控制。应用可按场景传 sharpenAmount 覆盖。 */
export const DEFAULT_SHARPEN = 0.7;

/**
 * 轻度 USM 锐化（unsharp mask）：out = in + amount·(in − 十字邻域均值)。
 *
 * 为什么需要：超采样降采样得到的抗锯齿边是 1～2 像素宽的灰阶过渡，
 * 在 400×300 的墨屏上直接量化会显得“肉”。USM 只放大局部对比——
 * 均匀区域 blur≈in，天然不动；笔画核被推向更深的灰阶、贴边背景被推向纯白，
 * 量化后笔画更干脆（0.7 档实测平均梯度能量 +20.6%，强边缘中间灰 -24pp，
 * 小字最明显；均匀区域与 0.35 档同样不受影响）。
 *
 * alpha 原样保留、透明像素直接跳过：今天应用的月亮图标用 destination-out
 * 挖出了透明咬口（RGB=0、alpha=0），若强制不透明会把新月变成一坨黑，
 * 推送管线本就会把这些像素按白底合成。最外一圈不处理，避免边缘伪影；
 * amount ≤ 0 时直接跳过。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {number} [amount]
 */
export function sharpen(ctx, width = WIDTH, height = HEIGHT, amount = DEFAULT_SHARPEN) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const src = Uint8ClampedArray.from(data); // 读取用快照，避免扩散已改写像素
  const stride = width * 4;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * stride + x * 4;
      if (src[i + 3] === 0) continue; // 透明像素（挖空/未画区）不动
      for (let c = 0; c < 3; c++) {
        const v = src[i + c];
        const blur = (src[i + c - 4] + src[i + c + 4] + src[i + c - stride] + src[i + c + stride]) / 4;
        data[i + c] = v + amount * (v - blur);
      }
      // alpha 保持原值，不强制不透明
    }
  }
  ctx.putImageData(image, 0, 0);
}

export function toPng(canvas) {
  return canvas.toBuffer('image/png');
}

/**
 * 出口：把超采样画布降到 400×300。
 *
 * 默认保留下采样产生的灰阶抗锯齿，输出连续色调 PNG，并做一次轻度 USM 锐化
 * （sharpen: false 关闭）；真正的位深量化（MONO / GRAY4 / GRAY16 + 误差扩散）
 * 交给 src/image.js 按设备色板完成。只有显式传 binarize: true 才会在这里硬阈值
 * 切成黑白——旧 1bpp 场景才需要，那条路径不锐化。
 *
 * @param {import('@napi-rs/canvas').Canvas} canvas createDeviceCanvas 返回的画布
 * @param {number} scale 与画布匹配的缩放倍数
 * @param {{binarize?: boolean, sample?: boolean, threshold?: number,
 *          sharpen?: boolean, sharpenAmount?: number}} [options]
 */
export function exportPng(canvas, scale = 3, options = {}) {
  const doBinarize = options.binarize === true;
  const sample = options.sample === true;
  const threshold = options.threshold ?? 180;
  const sharpenAmount = options.sharpen === false
    ? 0
    : Number.isFinite(options.sharpenAmount) ? options.sharpenAmount : DEFAULT_SHARPEN;

  if (scale === 1) {
    const ctx = canvas.getContext('2d');
    if (doBinarize) binarize(ctx, WIDTH, HEIGHT, threshold);
    else sharpen(ctx, WIDTH, HEIGHT, sharpenAmount);
    return canvas.toBuffer('image/png');
  }

  if (doBinarize && sample) {
    // 先在超采样尺寸上切干净，再按最近邻取样，细笔画不会被插值抹淡
    const big = canvas.getContext('2d');
    binarize(big, WIDTH * scale, HEIGHT * scale, threshold);
  }

  const target = createCanvas(WIDTH, HEIGHT);
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = !(doBinarize && sample);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, WIDTH, HEIGHT);

  if (doBinarize && !sample) binarize(ctx, WIDTH, HEIGHT, threshold);
  else if (!doBinarize) sharpen(ctx, WIDTH, HEIGHT, sharpenAmount);
  return target.toBuffer('image/png');
}
