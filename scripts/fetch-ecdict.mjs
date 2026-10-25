// 下载 ECDICT 的 ecdict.csv（约 65 MB）并做完整性校验。
//
// 为什么不用一条 curl：GitHub 及其镜像的 Range 请求经常在半途断流，curl 会把半截
// 内容写进文件但不报错；几次分片拼接后，CSV 里就混进了压缩二进制或错位文本，
// 结果「行数只有 17 万」（实际 74.5 万），词书怎么也凑不满 6000。
// 这里改成 2 MB 小块下载，逐块校验（长度 + 无控制字节 + UTF-8 合法），
// 失败了换镜像重试，块级缓存支持断点续传。
//
// 用法：
//   node scripts/fetch-ecdict.mjs                 # 写到 .cache/ecdict.csv
//   node scripts/fetch-ecdict.mjs --out a.csv --blocks 8

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const OUT = path.resolve(flag('out', path.join(ROOT, '.cache/ecdict.csv')));
const BLOCK_DIR = `${OUT}.blocks`;
const CONCURRENCY = Number(flag('blocks', 4));
const BLOCK = 2 * 1024 * 1024;

const SOURCES = [
  'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv',
  'https://ghfast.top/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv',
  'https://ghproxy.net/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv',
];

/** 文本文件不该出现的控制字节（\t\n\r 除外） */
function hasControlBytes(buf) {
  for (const byte of buf) if (byte < 9 || (byte > 13 && byte < 32)) return true;
  return false;
}

/** 片首片尾可能切在多字节字符中间，先对齐到字符边界再严格解码 */
function isValidUtf8(buf) {
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  let end = buf.length;
  while (end > start && (buf[end - 1] & 0xc0) === 0x80) end--;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start, end));
    return true;
  } catch {
    return false;
  }
}

function checkBlock(buf, want) {
  if (buf.length !== want) return `只收到 ${buf.length}/${want} 字节`;
  if (hasControlBytes(buf)) return '内容是二进制（多半是压缩流或错误页）';
  if (!isValidUtf8(buf)) return 'UTF-8 解码失败';
  return null;
}

async function getRange(start, end, total) {
  const want = end - start + 1;
  let last = '未尝试';
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = SOURCES[attempt % SOURCES.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
        signal: controller.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && buf.length === total) return buf.subarray(start, end + 1); // 源忽略了 Range
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const problem = checkBlock(buf, want);
      if (problem) throw new Error(problem);
      return buf;
    } catch (err) {
      last = err.name === 'AbortError' ? '超时' : err.message;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`区间 ${start}-${end} 重试 12 次仍失败：${last}`);
}

async function totalSize() {
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const size = Number(res.headers.get('content-length'));
      if (res.ok && size > 1024 * 1024) return size;
    } catch { /* 换下一个源 */ }
  }
  throw new Error('拿不到文件大小，检查网络');
}

const total = await totalSize();
const ranges = [];
for (let start = 0; start < total; start += BLOCK) ranges.push([start, Math.min(start + BLOCK - 1, total - 1)]);
console.log(`远端 ${total} 字节，按 2 MB 切成 ${ranges.length} 块，写到 ${path.relative(ROOT, OUT)}`);

await fs.mkdir(BLOCK_DIR, { recursive: true });
const queue = ranges.map((range, index) => ({ range, index }));
let finished = 0;
let cached = 0;

async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    const [start, end] = job.range;
    const file = path.join(BLOCK_DIR, String(job.index).padStart(4, '0'));
    const want = end - start + 1;
    const existing = await fs.readFile(file).catch(() => null);
    if (existing && !checkBlock(existing, want)) {
      cached++;
    } else {
      await fs.writeFile(file, await getRange(start, end, total));
    }
    finished++;
    process.stdout.write(`\r${finished}/${ranges.length} 块（缓存命中 ${cached}）`);
  }
}

await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
process.stdout.write('\n');

const buffers = [];
for (let index = 0; index < ranges.length; index++) {
  buffers.push(await fs.readFile(path.join(BLOCK_DIR, String(index).padStart(4, '0'))));
}
const merged = Buffer.concat(buffers);
const problem = checkBlock(merged, total);
if (problem) throw new Error(`合并后校验失败：${problem}`);

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, merged);
const head = merged.subarray(0, 40).toString('utf8').split('\n')[0];
console.log(`完成：${merged.length} 字节，首行 ${JSON.stringify(head)}`);
console.log(`分块缓存留在 ${path.relative(ROOT, BLOCK_DIR)}，重新下载时可复用（删掉即强制重下）`);
