// 渲染公共层测试：设备画布、USM 锐化与导出管线（单色/灰阶两条路径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIDTH, HEIGHT, createDeviceCanvas, exportPng, sharpen, DEFAULT_SHARPEN, font, fitText, wrapText,
} from '../apps/shared/canvas.js';

/** 读画布灰度数据 */
function readGray(canvas) {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const gray = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4]; // 内容都是灰阶，R 通道即亮度
  return gray;
}

/** 总梯度能量：相邻像素差的绝对值之和，越大越锐 */
function gradientSum(gray) {
  let sum = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 1; x < WIDTH; x++) sum += Math.abs(gray[y * WIDTH + x] - gray[y * WIDTH + x - 1]);
    if (y > 0) {
      for (let x = 0; x < WIDTH; x++) sum += Math.abs(gray[y * WIDTH + x] - gray[(y - 1) * WIDTH + x]);
    }
  }
  return sum;
}

/** 画一个带抗锯齿边缘的黑圆，返回 scale=1 的设备画布 */
function circleCanvas() {
  const { canvas, ctx } = createDeviceCanvas({ scale: 1, background: '#ffffff' });
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(WIDTH / 2, HEIGHT / 2, 60, 0, Math.PI * 2);
  ctx.fill();
  return { canvas, ctx };
}

test('sharpen：均匀区域一个像素都不动', () => {
  const { canvas, ctx } = circleCanvas();
  const before = readGray(canvas);
  sharpen(ctx, WIDTH, HEIGHT, 0.5);
  const after = readGray(canvas);
  // 圆心（纯黑内部）与左上角（纯白背景）必须逐像素一致
  assert.equal(after[Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)], before[Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)]);
  assert.equal(after[0], before[0]);
  // 除边缘一圈外，纯黑/纯白内部整体不变
  let changed = 0;
  for (let y = 1; y < HEIGHT - 1; y++) {
    for (let x = 1; x < WIDTH - 1; x++) {
      const i = y * WIDTH + x;
      if (before[i] !== after[i] && (before[i] === 0 || before[i] === 255)) changed++;
    }
  }
  assert.equal(changed, 0, 'USM 不应改动已经纯黑/纯白的像素');
});

test('sharpen：抗锯齿边缘对比增强（梯度能量上升）', () => {
  const { canvas, ctx } = circleCanvas();
  const before = gradientSum(readGray(canvas));
  sharpen(ctx, WIDTH, HEIGHT, DEFAULT_SHARPEN);
  const after = gradientSum(readGray(canvas));
  assert.ok(after > before, `锐化后梯度应上升：${before} → ${after}`);
});

test('sharpen：amount ≤ 0 时是彻底的 no-op', () => {
  const { canvas, ctx } = circleCanvas();
  const before = readGray(canvas);
  sharpen(ctx, WIDTH, HEIGHT, 0);
  sharpen(ctx, WIDTH, HEIGHT, -1);
  assert.deepEqual(readGray(canvas), before);
});

test('exportPng：默认导出带轻度锐化，sharpen:false 可关闭', async () => {
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(WIDTH / 2, HEIGHT / 2, 60, 0, Math.PI * 2);
  ctx.fill();

  const sharpPng = await exportPng(canvas, scale);
  const plainPng = await exportPng(canvas, scale, { sharpen: false });
  assert.ok(!sharpPng.equals(plainPng), '默认导出应与关闭锐化的结果不同');

  // 锐化版换算到设备灰度后梯度更高
  const sharpGray = await pngGray(sharpPng);
  const plainGray = await pngGray(plainPng);
  assert.ok(gradientSum(sharpGray) > gradientSum(plainGray), '默认导出的边缘应更锐');
});

test('exportPng：binarize 路径输出纯黑白且不受锐化影响', async () => {
  const { canvas, ctx, scale } = createDeviceCanvas({ background: '#ffffff' });
  ctx.fillStyle = '#555555';
  ctx.fillRect(20, 20, 100, 100);
  const png = await exportPng(canvas, scale, { binarize: true, threshold: 180 });
  const gray = await pngGray(png);
  assert.ok([...gray].every((v) => v === 0 || v === 255), '二值化输出只允许 0/255');
});

test('sharpen：destination-out 挖出的透明区域保持透明（月亮咬口不能被锐化糊成黑饼）', async () => {
  // 今天应用的月亮图标就是这种画法：实心圆上挖一个偏移圆形成月牙
  const { canvas, ctx, scale } = createDeviceCanvas({ scale: 1, background: '#ffffff' });
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(100, 100, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(109, 94, 14, 0, Math.PI * 2);
  ctx.fill();
  const png = await exportPng(canvas, scale);
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const cut = (94 * info.width + 109) * info.channels;
  assert.deepEqual([...data.slice(cut, cut + 4)], [0, 0, 0, 0], '挖空区应保持透明（RGB=0、alpha=0）');
  // (95,105) 在实心圆内、挖除圈外：应仍是不透实心黑
  const body = (105 * info.width + 95) * info.channels;
  assert.equal(data[body + 3], 255, '月亮本体仍是不透明实心');
  assert.equal(data[body], 0);
});

test('文本工具：fitText 截断带省略号，wrapText 按宽度折行', () => {
  const { ctx } = createDeviceCanvas({ scale: 1 });
  const spec = font(12);
  assert.equal(fitText(ctx, '短', spec, 200), '短');
  const fitted = fitText(ctx, '这是一段很长的文本肯定超出一行宽度', spec, 100);
  assert.ok(fitted.endsWith('…') && ctx.measureText(fitted).width <= 100);
  const lines = wrapText(ctx, '一二三四五六七八九十', spec, 30, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
});

/** PNG → 灰度数组（测试内复用） */
async function pngGray(png) {
  const sharp = (await import('sharp')).default;
  const { data } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}
