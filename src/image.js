// 图像管线：PNG → 400×300 线性亮度 → 设备色板量化 + 按位深选择的抖色 → MSB 位打包 → zlib。
// 逐行对齐 Rust SDK src/image.rs：
//   - PNG 按 sRGB 解码，转线性光后按 0.2126R + 0.7152G + 0.0722B 取亮度
//   - 等比缩放进 400×300（Lanczos3），白底居中，透明度在线性域合成
//   - 量化与误差扩散都在线性亮度域进行；色板取连接时从设备读到的真实值，不写死
//   - 1bpp 打包为 1-level（0=白 1=黑）；2/4bpp 直接为灰号；高位像素在左
// 依赖 sharp（libvips，提供 linux/amd64 与 linux/arm64 预编译二进制，NAS 无需编译）。
//
// 与 Rust 的有意差异：误差扩散只在 MONO（1bpp）开启。设备侧只按灰阶号直查色板
// 显示、不再抖色（Rust 注释 "Floyd–Steinberg error diffusion is performed on the
// remote host only"），扩散图案会以双色斑点原样出现在屏幕上——GRAY16 的量化误差
// 只有半个色阶、扩散收益趋近于零；GRAY4 虽误差较大，但人眼空间平均在小尺寸墨屏上
// 抵不过斑点感：细线变虚线、灰字发脏、图表边缘带噪点（放大实测确认）。
// 详见 packDithered 的注释；传 diffuse: true 可逐调用覆盖。

import sharp from 'sharp';
import zlib from 'node:zlib';
import { ZectrixError } from './packet.js';

export const WIDTH = 400;
export const HEIGHT = 300;
export const RAW_BYTES_PER_BPP = 15000; // 400*300/8

/** ImageFormat：bpp 值即协议 IMAGE_BEGIN 首字节（1=黑白 2=四灰 4=十六灰） */
export const FORMAT = { MONO: 1, GRAY4: 2, GRAY16: 4 };

/**
 * 按设备色板选推送位深：支持 16 阶灰就推 GRAY16，否则退回 GRAY4 / MONO。
 * 应用渲染时保留的灰阶抗锯齿只有走灰阶格式才能在屏幕上看到。
 * @param {{palette?: {gray4?: number[], gray16?: number[]}}} client
 */
export function formatFor(client) {
  const palette = client?.palette;
  if (palette?.gray16?.length) return FORMAT.GRAY16;
  if (palette?.gray4?.length) return FORMAT.GRAY4;
  return FORMAT.MONO;
}

/**
 * 把请求的位深夹取到设备能力以内：设备只有 4 阶灰时，请求 GRAY16 退回 GRAY4，
 * 没有色板时退回 MONO。调用方（今天应用的配置格式、/api/show 的 format 参数）
 * 不应因为“要了设备没有的位深”而整张图推送失败。
 * @param {{palette?: {gray4?: number[], gray16?: number[]}}} client
 * @param {number} preferred 期望位深（FORMAT.*）
 * @returns {number} 实际可用的最高位深
 */
export function resolveFormat(client, preferred) {
  const best = formatFor(client);
  if (![FORMAT.MONO, FORMAT.GRAY4, FORMAT.GRAY16].includes(preferred)) return best;
  return Math.min(preferred, best);
}

const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const x = i / 255;
  LINEAR[i] = (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)) * 255;
}

/**
 * 与 Rust image::prepare 等价的完整管线。
 * @param {Buffer} png 原始连续色调 PNG（≤8 MiB，≤4096×4096）
 * @param {number} format FORMAT.MONO / GRAY4 / GRAY16
 * @param {{gray4:number[], gray16:number[]}} palette 连接时读取的设备色板
 * @returns {Promise<Buffer>} 可直接放入 IMAGE_BEGIN 长度字段的 zlib 流
 */
export async function prepareImage(png, format, palette) {
  if (png.length > 8 * 1024 * 1024) throw new ZectrixError('InvalidImage', 'PNG 超过 8 MiB');
  if (![FORMAT.MONO, FORMAT.GRAY4, FORMAT.GRAY16].includes(format)) {
    throw new ZectrixError('InvalidImage', `不支持的位深 ${format}`);
  }
  if (format !== FORMAT.MONO && !palette) {
    throw new ZectrixError('InvalidImage', '尚未读取设备色板，请先完成连接握手');
  }
  const colors =
    format === FORMAT.MONO
      ? [0, 255]
      : format === FORMAT.GRAY4
        ? palette.gray4
        : palette.gray16;
  if (!colors || colors.length === 0) throw new ZectrixError('InvalidImage', '缺少设备色板');

  // sharp 的解码错误（非 PNG、像素超限、截断文件）统一转成 InvalidImage，
  // 否则 Web 层会把它当成未知异常返回 500
  let data, info;
  try {
    ({ data, info } = await sharp(png, { limitInputPixels: 4096 * 4096 })
      .resize(WIDTH, HEIGHT, { fit: 'inside', kernel: 'lanczos3' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch (err) {
    throw new ZectrixError('InvalidImage', `无法解码 PNG：${err.message || err}`);
  }

  const x0 = Math.floor((WIDTH - info.width) / 2);
  const y0 = Math.floor((HEIGHT - info.height) / 2);
  // 线性亮度，白底合成（与 Rust 一致：luminance * alpha + 255 * (1 - alpha)）
  const pixels = new Float64Array(WIDTH * HEIGHT).fill(255);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const si = (y * info.width + x) * 4;
      const lum =
        0.2126 * LINEAR[data[si]] + 0.7152 * LINEAR[data[si + 1]] + 0.0722 * LINEAR[data[si + 2]];
      const alpha = data[si + 3] / 255;
      pixels[(y0 + y) * WIDTH + x0 + x] = lum * alpha + 255 * (1 - alpha);
    }
  }
  const raw = packDithered(pixels, format, colors);
  const z = zlib.deflateSync(raw, { level: 6 });
  if (z.length > 0xffff) throw new ZectrixError('InvalidImage', '压缩图像超过设备容量');
  return z;
}

/** Floyd–Steinberg 误差扩散 + MSB-first 位打包（对齐 image.rs pack_dithered）
 *
 * 与 Rust SDK 的**有意差异**：默认只在 MONO（1bpp）做误差扩散。
 * 原因——设备侧只按灰阶号直查色板显示，不再抖色（Rust 注释
 * "Floyd–Steinberg error diffusion is performed on the remote host only"），
 * 扩散图案会以双色斑点的形式原样出现在屏幕上：
 *   - GRAY16（16 阶）：量化误差最大只有半个色阶，扩散收益趋近于零，
 *     代价是把平滑的抗锯齿灰边和 1px 细线打成交替斑点（细线变虚线、灰字发脏）；
 *   - GRAY4（4 阶）：误差虽有 42.5（线性域），但 400×300 小屏上人眼的空间平均
 *     抵不过斑点感，实测细线在扩散下嵌满深色斑点、图表边缘带噪点。
 * MONO（1bpp）必须用扩散表达中间调，保持与 Rust 逐位一致。
 * 传 diffuse: true 可按 Rust 语义强制任意位深扩散（golden 对齐用）。
 */
export function packDithered(pixels, bpp, colors, options = {}) {
  const diffuse = options.diffuse ?? bpp === 1;
  const raw = Buffer.alloc(RAW_BYTES_PER_BPP * bpp);
  for (let row = 0; row < HEIGHT; row++) {
    for (let col = 0; col < WIDTH; col++) {
      const i = row * WIDTH + col;
      const value = Math.min(255, Math.max(0, pixels[i]));
      let level = 0;
      let distance = Infinity;
      for (let idx = 0; idx < colors.length; idx++) {
        const d = Math.abs(value - colors[idx]);
        if (d < distance) {
          distance = d;
          level = idx; // 严格小于：相等/重复亮度稳定取最小灰号
        }
      }
      const error = value - colors[level];
      const packed = bpp === 1 ? 1 - level : level;
      raw[(i * bpp) >> 3] |= packed << (8 - bpp - ((i * bpp) % 8));
      if (!diffuse) continue;
      if (col + 1 < WIDTH) pixels[i + 1] += (error * 7) / 16;
      if (row + 1 < HEIGHT) {
        if (col > 0) pixels[i + WIDTH - 1] += (error * 3) / 16;
        pixels[i + WIDTH] += (error * 5) / 16;
        if (col + 1 < WIDTH) pixels[i + WIDTH + 1] += error / 16;
      }
    }
  }
  return raw;
}

/** 解包回灰号（仅测试/调试用）；1bpp 时 1 表示黑，由调用方解释 */
export function unpackRaw(raw, bpp) {
  const out = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < out.length; i++) {
    const shift = 8 - bpp - ((i * bpp) % 8);
    out[i] = (raw[(i * bpp) >> 3] >> shift) & ((1 << bpp) - 1);
  }
  return out;
}
