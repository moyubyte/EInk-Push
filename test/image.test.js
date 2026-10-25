// 图像管线 golden 测试：与 Rust SDK src/image.rs 的 #[cfg(test)] 用例逐位对齐。
// 这些向量不依赖真实设备，验证的是“任意 PNG → 设备可直接校验的 zlib 位图”整条链路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { prepareImage, packDithered, resolveFormat, FORMAT, WIDTH, HEIGHT } from '../src/image.js';

const UNIFORM = {
  gray4: [0, 85, 170, 255],
  gray16: [0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255],
};

async function pngOf(rgb, width = WIDTH, height = HEIGHT) {
  return sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function solid(r, g, b, w = WIDTH, h = HEIGHT) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
  }
  return buf;
}

async function prepareRaw(png, format = FORMAT.MONO, palette = UNIFORM) {
  const compressed = await prepareImage(png, format, palette);
  const raw = zlib.inflateSync(compressed);
  return { compressed, raw };
}

test('全黑图 → 15000 字节全 0xFF（与 Rust full_canvas_includes_the_top_rows 一致）', async () => {
  const { raw } = await prepareRaw(await pngOf(solid(0, 0, 0)));
  assert.equal(raw.length, 15000);
  assert.ok(raw.every((b) => b === 255));
});

test('全白图 → 15000 字节全 0x00', async () => {
  const { raw } = await prepareRaw(await pngOf(solid(255, 255, 255)));
  assert.ok(raw.every((b) => b === 0));
});

test('白底黑点逐位一致（与 Rust full_size_pixels_keep_their_coordinates 一致）', async () => {
  const rgb = solid(255, 255, 255);
  const points = [[0, 0], [399, 0], [0, 299], [399, 299], [100, 31], [100, 32]];
  for (const [x, y] of points) {
    const i = (y * WIDTH + x) * 3;
    rgb[i] = 0; rgb[i + 1] = 0; rgb[i + 2] = 0;
  }
  const { raw } = await prepareRaw(await pngOf(rgb));
  const expected = Buffer.alloc(15000);
  for (const [x, y] of points) {
    expected[y * 50 + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
  }
  assert.deepEqual(raw, expected);
});

test('sRGB 128 中灰抖色黑位落在 [93500,94700)（与 Rust host_dithering_preserves_midgray_average 一致）', async () => {
  const { raw } = await prepareRaw(await pngOf(solid(128, 128, 128)));
  const black = [...raw].reduce((sum, b) => sum + ((b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1) + ((b >> 3) & 1) + ((b >> 4) & 1) + ((b >> 5) & 1) + ((b >> 6) & 1) + ((b >> 7) & 1)), 0);
  assert.ok(black >= 93500 && black < 94700, `black=${black}`);
});

test('gray4 均匀色板精确落位 → 全 0x1B（与 Rust native_gray_levels_are_packed_msb_first 一致）', () => {
  const pixels = new Float64Array(120000);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i % 4) * 85;
  const raw = packDithered(pixels, FORMAT.GRAY4, UNIFORM.gray4);
  assert.equal(raw.length, 30000);
  assert.ok(raw.every((b) => b === 0x1b));
});

test('gray16 均匀色板精确落位 → 高低半字节递增（与 Rust 同源用例一致）', () => {
  const pixels = new Float64Array(120000);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i % 16) * 17;
  const raw = packDithered(pixels, FORMAT.GRAY16, UNIFORM.gray16);
  assert.equal(raw.length, 60000);
  for (let i = 0; i < 30000; i++) {
    assert.equal(raw[i], ((i * 2) % 16) << 4 | (((i * 2) + 1) % 16));
  }
});

test('非均匀色板驱动量化（显式 diffuse:true 时按 Rust 语义扩散并保持均值）', () => {
  const colors = [0, 40, 180, 255];
  const diffused = packDithered(new Float64Array(120000).fill(80), FORMAT.GRAY4, colors, { diffuse: true });
  let luminance = 0n;
  for (const byte of diffused) {
    for (const shift of [6, 4, 2, 0]) luminance += BigInt(colors[(byte >> shift) & 3]);
  }
  assert.ok(Math.abs(Number(luminance) / 120000 - 80) < 0.5, '扩散后均值应仍在 80 附近');
  const exact = packDithered(new Float64Array(120000).fill(40), FORMAT.GRAY4, colors);
  assert.ok(exact.every((b) => b === 0x55));
});

test('GRAY4 默认不扩散：阶间灰度整幅稳定落同一级（设备侧不抖色，细线才不发脏）', () => {
  // 80 介于色板 0/40/180/255 中离 40 最近：扩散会把 1px 细线打成深色斑点嵌在灰线里
  // （放大实测确认），不扩散则全幅稳定落 1 级（0x55）。
  const raw = packDithered(new Float64Array(120000).fill(80), FORMAT.GRAY4, [0, 40, 180, 255]);
  assert.ok(raw.every((b) => b === 0x55), `应全部为 0x55，实际出现 ${[...new Set(raw)].map((b) => `0x${b.toString(16)}`).join(',')}`);
});

test('重复色板亮度取最小灰号（与 Rust duplicate_palette_entries 一致）', () => {
  const raw = packDithered(new Float64Array(120000).fill(85), FORMAT.GRAY4, [0, 85, 85, 255]);
  assert.ok(raw.every((b) => b === 0x55));
});

test('GRAY16 默认不扩散：阶间灰度整幅稳定落同一级（设备侧不抖色，细线才不会变虚线）', () => {
  // 80 介于色板 68 与 85 之间：扩散会把它搅成 4/5 级交替的斑点（细线发脏的根源），
  // 不扩散则全幅落 5 级（0x55），1px 细线与灰字在 16 阶墨屏上才是干净的。
  const raw = packDithered(new Float64Array(120000).fill(80), FORMAT.GRAY16, UNIFORM.gray16);
  assert.ok(raw.every((b) => b === 0x55), `应全部为 0x55，实际出现 ${[...new Set(raw)].map((b) => `0x${b.toString(16)}`).join(',')}`);
});

test('GRAY16 显式 diffuse:true 时仍按 Rust 语义扩散，且保持均值', () => {
  const raw = packDithered(new Float64Array(120000).fill(80), FORMAT.GRAY16, UNIFORM.gray16, { diffuse: true });
  assert.ok(!raw.every((b) => b === 0x55), '显式开启扩散后不应再是单一灰阶');
  let sum = 0;
  for (const byte of raw) {
    for (const shift of [4, 0]) sum += UNIFORM.gray16[(byte >> shift) & 15];
  }
  assert.ok(Math.abs(sum / 120000 - 80) < 1.0, `扩散后均值应仍在 80 附近，实际 ${sum / 120000}`);
});

test('MONO 仍按 Rust 语义 FS 抖色（1bpp 必须靠扩散表达中间调）', () => {
  const raw = packDithered(new Float64Array(120000).fill(80), FORMAT.MONO, [0, 255]);
  assert.ok(!raw.every((b) => b === 0x00) && !raw.every((b) => b === 0xff), 'MONO 应出现黑白混合');
});

test('resolveFormat 把请求位深夹取到设备能力以内', () => {
  const full = { palette: { gray4: [0, 85, 170, 255], gray16: UNIFORM.gray16 } };
  const gray4Only = { palette: { gray4: [0, 85, 170, 255], gray16: [] } };
  const none = { palette: null };
  assert.equal(resolveFormat(full, FORMAT.GRAY16), FORMAT.GRAY16);
  assert.equal(resolveFormat(full, FORMAT.GRAY4), FORMAT.GRAY4);
  assert.equal(resolveFormat(full, FORMAT.MONO), FORMAT.MONO);
  assert.equal(resolveFormat(gray4Only, FORMAT.GRAY16), FORMAT.GRAY4);
  assert.equal(resolveFormat(gray4Only, FORMAT.GRAY4), FORMAT.GRAY4);
  assert.equal(resolveFormat(gray4Only, FORMAT.MONO), FORMAT.MONO);
  assert.equal(resolveFormat(none, FORMAT.GRAY16), FORMAT.MONO);
  assert.equal(resolveFormat(none, FORMAT.GRAY4), FORMAT.MONO);
  assert.equal(resolveFormat(full, 99), FORMAT.GRAY16, '非法请求退回设备最优');
});

test('zlib 流可被设备侧解压且长度合法（≤65535，解压恰好 15000×bpp）', async () => {
  for (const [format, bpp] of [[FORMAT.MONO, 1], [FORMAT.GRAY4, 2], [FORMAT.GRAY16, 4]]) {
    const png = await pngOf(solid(200, 60, 60));
    const { compressed, raw } = await prepareRaw(png, format);
    assert.ok(compressed.length <= 0xffff, `format=${format} len=${compressed.length}`);
    assert.equal(raw.length, 15000 * bpp);
    // zlib 头校验：0x78 开头（RFC1950）
    assert.equal(compressed[0], 0x78);
  }
});

test('非匹配宽高比输入等比缩放后上下留白居中', async () => {
  // 400x150（宽幅）放入 400x300：缩放比为 1（不放大），垂直居中，上下各 75 像素白边。
  // 注意：与 Rust image crate 一致，等比“适应”包含放大——200x150 会被放大到 400x300 全画幅。
  const png = await pngOf(solid(0, 0, 0, 400, 150), 400, 150);
  const { raw } = await prepareRaw(png);
  const bitAt = (x, y) => (raw[y * 50 + Math.floor(x / 8)] >> (7 - (x % 8))) & 1;
  assert.equal(bitAt(0, 74), 0);  // 上白边
  assert.equal(bitAt(0, 75), 1);  // 黑幅起始
  assert.equal(bitAt(399, 224), 1); // 黑幅结束
  assert.equal(bitAt(399, 225), 0); // 下白边
  assert.equal(bitAt(0, 0), 0);
  assert.equal(bitAt(399, 299), 0);
});

test('非法 PNG 被拒绝', async () => {
  await assert.rejects(() => prepareImage(Buffer.from('not a png'), FORMAT.MONO, UNIFORM), /无效|PNG|Input/);
});
