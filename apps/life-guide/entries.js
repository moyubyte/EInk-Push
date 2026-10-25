// 人生指南：把《高性价比人生指南》(HowToLiveBetter) 的条目装进来。
//
// 内容来自 https://github.com/eternity4719/HowToLiveBetter（CC BY 4.0），
// 由 scripts/build-life-guide.mjs 从 book/*.md 抽字段生成，这里只负责查询与筛选。

import fs from 'node:fs';

const DATA = JSON.parse(fs.readFileSync(new URL('./data/entries.json', import.meta.url), 'utf8'));

export const ENTRIES = DATA.entries;
export const CHAPTERS = DATA.chapters;
export const META = {
  title: DATA.title,
  source: DATA.source,
  license: DATA.license,
  licenseUrl: DATA.licenseUrl,
  builtAt: DATA.builtAt,
};

/** 原文有「A（争议）」「B（指南强推荐…）」这类写法，筛选与卡片只取首字母 */
export function evidenceBase(entry) {
  return String(entry?.evidence ?? '').match(/^[A-C]/)?.[0] ?? '?';
}

/** 按章节 / 证据等级筛选；'all' 表示不过滤 */
export function filterEntries({ chapter = 'all', evidence = 'all' } = {}) {
  return ENTRIES.filter((entry) => (chapter === 'all' || entry.chapterNo === chapter)
    && (evidence === 'all' || evidenceBase(entry) === evidence));
}

/** 证据等级计数，供页面下拉框显示条数 */
export function evidenceStats() {
  const stats = new Map();
  for (const entry of ENTRIES) {
    const level = evidenceBase(entry);
    stats.set(level, (stats.get(level) ?? 0) + 1);
  }
  return ['A', 'B', 'C']
    .filter((level) => stats.has(level))
    .map((level) => ({ level, count: stats.get(level) }));
}

/** 当天的条目偏移：同一天内重启服务仍是同一张卡片，换一天就换一条 */
export function dailyOffset(date = new Date()) {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
  return Math.max(0, dayOfYear);
}

/** 随机挑一个与当前不同的下标；pool 只有一个条目时返回原下标 */
export function pickIndex(pool, current, random = Math.random) {
  if (pool.length <= 1) return 0;
  const currentKey = pool[current]?.key;
  const candidates = pool.map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry.key !== currentKey);
  if (!candidates.length) return current;
  const value = Number(random());
  const pick = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 0.999999);
  return candidates[Math.floor(pick * candidates.length)].index;
}
