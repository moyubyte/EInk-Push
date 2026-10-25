#!/usr/bin/env node
// 把《高性价比人生指南》（HowToLiveBetter）的 book/*.md 解析成应用数据。
//
// 用法：
//   node scripts/build-life-guide.mjs <bookDir> [--out apps/life-guide/data/entries.json]
//
// bookDir 是 HowToLiveBetter 仓库的 book/ 目录（34 个章节 .md）。
// 原文是 CC BY 4.0，派生数据必须保留署名：输出里写入 source/license，
// 卡片与页面都会显示来源。这里只做「抽字段 + 去 Markdown 标记」，不改写原意。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIELD_KEYS = ['成本', '说人话', '收益', '证据等级', '来源', '备注'];

function parseArgs(argv) {
  const args = { src: null, out: path.join(root, 'apps', 'life-guide', 'data', 'entries.json') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') args.out = path.resolve(argv[++index]);
    else if (!args.src) args.src = path.resolve(arg);
  }
  if (!args.src) throw new Error('缺少 book 目录：node scripts/build-life-guide.mjs <bookDir>');
  return args;
}

/** 去掉行内 Markdown 标记，保留可读文字（链接只留标题，裸链接原样保留） */
function plain(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/<((?:https?:\/\/)[^>\s]+)>/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[\s（(])\*(?=\S)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTags(block) {
  const match = block.match(/<!--\s*成本标签:([^>]*)-->/);
  if (!match) return null;
  const tags = {};
  for (const part of match[1].split(/\s+/)) {
    const [key, value] = part.split('=');
    if (key && value) tags[key] = value;
  }
  return Object.keys(tags).length ? tags : null;
}

/** 把一条 `### N. 标题` 下面的 `- 字段：内容` 拆出来，跨行续写并入同一字段 */
function parseFields(block) {
  const fields = {};
  let current = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#{2,4}\s/.test(line) || /^---+$/.test(line)) {
      current = null;
      continue;
    }
    const field = line.match(/^-\s*(成本|说人话|收益|证据等级|来源|备注)\s*[：:]\s*(.*)$/);
    if (field) {
      current = field[1];
      fields[current] = field[2];
      continue;
    }
    if (!current || !line) continue;
    // 续行：普通文本或引用块，都算上一个字段的一部分
    if (/^[-*]\s/.test(line) && !/^-/.test(line)) continue;
    fields[current] = `${fields[current]} ${line.replace(/^>\s*/, '')}`;
  }
  return fields;
}

function buildEntry(match, block, chapter) {
  const fields = parseFields(block);
  const title = plain(match[2]);
  const entry = {
    // 编号在每个章节里从 1 重来，跨章节唯一键用「章节-条号」
    no: Number(match[1]),
    key: `${chapter.no}-${match[1]}`,
    chapter: chapter.title,
    chapterNo: chapter.no,
    title,
    plain: plain(fields['说人话']),
    cost: plain(fields['成本']),
    benefit: plain(fields['收益']),
    evidence: plain(fields['证据等级']).toUpperCase(),
    source: plain(fields['来源']),
    note: plain(fields['备注']),
    tags: parseTags(block),
  };
  return entry;
}

function parseChapter(text, file) {
  const no = file.slice(0, 2);
  const heading = text.match(/^#\s+(?:\d+[.、]\s*)?(.+)$/m);
  const chapter = {
    no,
    title: plain(heading?.[1] ?? file.replace(/^\d+-|\.md$/g, '')),
    entries: [],
  };
  const starts = [...text.matchAll(/^###\s+(\d+)[.、]\s*(.+)$/gm)];
  starts.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < starts.length ? starts[index + 1].index : text.length;
    const entry = buildEntry(match, text.slice(start, end), chapter);
    if (entry.title && entry.plain) chapter.entries.push(entry);
  });
  return chapter;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = fs.readdirSync(args.src).filter((name) => /^\d{2}-.+\.md$/.test(name)).sort();
  if (!files.length) throw new Error(`没有找到章节文件：${args.src}`);

  const chapters = files.map((name) => parseChapter(fs.readFileSync(path.join(args.src, name), 'utf8'), name));
  const entries = chapters.flatMap((chapter) => chapter.entries);

  const keys = new Set();
  const problems = [];
  for (const entry of entries) {
    const label = `第 ${entry.chapterNo} 章第 ${entry.no} 条`;
    if (keys.has(entry.key)) problems.push(`重复条目 ${entry.key}`);
    keys.add(entry.key);
    if (!entry.cost) problems.push(`${label}缺少成本`);
    if (!entry.evidence) problems.push(`${label}缺少证据等级`);
    if (!entry.tags) problems.push(`${label}缺少成本标签`);
  }

  const data = {
    version: 1,
    title: '高性价比人生指南',
    source: 'https://github.com/eternity4719/HowToLiveBetter',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    builtAt: new Date().toISOString(),
    chapters: chapters.map((chapter) => ({
      no: chapter.no,
      title: chapter.title,
      count: chapter.entries.length,
    })).filter((chapter) => chapter.count > 0),
    entries,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(data));
  const evidence = entries.reduce((acc, entry) => {
    acc[entry.evidence || '?'] = (acc[entry.evidence || '?'] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`已生成 ${args.out}`);
  console.log(`章节 ${data.chapters.length} · 条目 ${entries.length}`);
  console.log(`证据等级 ${Object.entries(evidence).map(([key, value]) => `${key}:${value}`).join(' ')}`);
  if (problems.length) console.log(`提示 ${problems.length} 条：\n${problems.slice(0, 20).join('\n')}`);
}

main();
