// 词库存储：教材 → 单元 → 单词，外加按「单词」维度记录的学习进度。
//
// 词库与进度都放在 `<dataDir>/vocabulary/library.json` 与 `progress.json`，
// 都是普通 JSON，方便直接备份/导出。
// 进度以单词本身为键（而不是行 id），同一单词在不同教材里出现时共享记忆强度。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * 内置词书：雅思 6000 词（`data/ielts-6000.json`，由 `scripts/build-ielts-wordbook.mjs`
 * 从 ECDICT 的 ielts 标签词条按词频取前 6000 生成，200 词一个 List）。
 * 文件是紧凑的 `[单词, 音标, 释义]` 数组，首次启动时展开成 textbooks/units 写进 library.json。
 */
const BUNDLED_FILE = new URL('./data/ielts-6000.json', import.meta.url);
let bundledCache = null;

/** 把内置词书展开成 library.json 用的教材/单元结构（返回副本，调用方可随意改） */
export function bundledWordbook() {
  if (!bundledCache) {
    const raw = JSON.parse(readFileSync(BUNDLED_FILE, 'utf8'));
    const unitSize = raw.unitSize ?? 200;
    const label = raw.unitLabel ?? 'List';
    const units = [];
    for (let start = 0; start < raw.words.length; start += unitSize) {
      const index = units.length + 1;
      units.push({
        id: `${raw.id}-l${index}`,
        name: `${label} ${index}`,
        words: raw.words.slice(start, start + unitSize).map(([word, phonetic, meaning]) => ({
          word,
          phonetic: phonetic ?? '',
          meaning,
        })),
      });
    }
    bundledCache = {
      textbooks: [{ id: raw.id, name: raw.name, source: raw.source, units }],
    };
  }
  return structuredClone(bundledCache);
}

const nowIso = () => new Date().toISOString();

function wordKey(word) {
  return String(word).trim().toLowerCase();
}

/** 单词 id：用内容哈希，移动/改名单元不影响进度 */
export function wordId(word) {
  return crypto.createHash('sha1').update(wordKey(word)).digest('hex').slice(0, 12);
}

export class Library {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.libraryFile = path.join(dir, 'library.json');
    this.progressFile = path.join(dir, 'progress.json');
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.data = { textbooks: [] };
    this.progress = {};
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    await fs.mkdir(this.dir, { recursive: true });
    this.data = await readJsonSafe(this.libraryFile, bundledWordbook, (err, backup) => {
      this.log(`词库文件损坏（${err.message}），已备份为 ${path.basename(backup)}，改用内置词书`);
    });
    if (!Array.isArray(this.data.textbooks) || this.data.textbooks.length === 0) {
      this.data = bundledWordbook();
    }
    // 老版本的默认词表是 12 个词的演示数据，升级时换成雅思词书（进度按单词保存，不受影响）
    if (this.data.textbooks.length === 1 && this.data.textbooks[0].id === 'demo') {
      this.data = bundledWordbook();
      await this.saveLibrary();
    }
    this.progress = await readJsonSafe(this.progressFile, () => ({}), (err, backup) => {
      this.log(`复习进度文件损坏（${err.message}），已备份为 ${path.basename(backup)}，从零开始记录`);
    });
    this.loaded = true;
    return this;
  }

  async saveLibrary() {
    await writeJson(this.libraryFile, this.data);
  }

  async saveProgress() {
    await writeJson(this.progressFile, this.progress);
  }

  textbooks() {
    return this.data.textbooks.map((textbook) => ({
      id: textbook.id,
      name: textbook.name,
      units: textbook.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        count: unit.words.length,
      })),
      count: textbook.units.reduce((total, unit) => total + unit.words.length, 0),
    }));
  }

  findTextbook(id) {
    return this.data.textbooks.find((textbook) => textbook.id === id) ?? null;
  }

  findUnit(textbookId, unitId) {
    const textbook = this.findTextbook(textbookId);
    if (!textbook) return null;
    return textbook.units.find((unit) => unit.id === unitId) ?? null;
  }

  /** 取某个范围内的单词（含进度），未指定时取全部 */
  words({ textbookId, unitId } = {}) {
    const out = [];
    for (const textbook of this.data.textbooks) {
      if (textbookId && textbook.id !== textbookId) continue;
      for (const unit of textbook.units) {
        if (unitId && unit.id !== unitId) continue;
        for (const entry of unit.words) {
          out.push({
            ...entry,
            id: wordId(entry.word),
            textbookId: textbook.id,
            textbookName: textbook.name,
            unitId: unit.id,
            unitName: unit.name,
            progress: this.progress[wordKey(entry.word)] ?? null,
          });
        }
      }
    }
    return out;
  }

  addTextbook(name) {
    const cleanName = String(name ?? '').trim();
    if (!cleanName) throw new Error('教材名称不能为空');
    const textbook = { id: `tb-${crypto.randomUUID().slice(0, 8)}`, name: cleanName, units: [] };
    this.data.textbooks.push(textbook);
    return textbook;
  }

  addUnit(textbookId, name) {
    const textbook = this.findTextbook(textbookId);
    if (!textbook) throw new Error('教材不存在');
    const cleanName = String(name ?? '').trim();
    if (!cleanName) throw new Error('单元名称不能为空');
    const unit = { id: `u-${crypto.randomUUID().slice(0, 8)}`, name: cleanName, words: [] };
    textbook.units.push(unit);
    return unit;
  }

  addWord(textbookId, unitId, { word, meaning, phonetic }) {
    const unit = this.findUnit(textbookId, unitId);
    if (!unit) throw new Error('单元不存在');
    const clean = String(word ?? '').trim();
    if (!/^[A-Za-z][A-Za-z' -]{0,40}$/.test(clean)) throw new Error('单词应为英文字母（可含空格、连字符、撇号）');
    if (!String(meaning ?? '').trim()) throw new Error('中文释义不能为空');
    if (unit.words.some((entry) => wordKey(entry.word) === wordKey(clean))) throw new Error('该单元已有这个单词');
    const entry = { word: clean, meaning: String(meaning).trim(), phonetic: String(phonetic ?? '').trim() };
    unit.words.push(entry);
    return entry;
  }

  removeWord(textbookId, unitId, word) {
    const unit = this.findUnit(textbookId, unitId);
    if (!unit) throw new Error('单元不存在');
    const before = unit.words.length;
    unit.words = unit.words.filter((entry) => wordKey(entry.word) !== wordKey(word));
    return before - unit.words.length;
  }

  /** 批量导入：每行 `word<TAB>释义[<TAB>音标]`，逗号分隔也接受 */
  importWords(textbookId, unitId, text) {
    const unit = this.findUnit(textbookId, unitId);
    if (!unit) throw new Error('单元不存在');
    const parsed = parseImport(text);
    const existing = new Set(unit.words.map((entry) => wordKey(entry.word)));
    let added = 0;
    for (const entry of parsed) {
      if (existing.has(wordKey(entry.word))) continue;
      unit.words.push(entry);
      existing.add(wordKey(entry.word));
      added++;
    }
    return { added, skipped: parsed.length - added, parsed: parsed.length };
  }

  getProgress(word) {
    return this.progress[wordKey(word)] ?? null;
  }

  setProgress(word, entry) {
    this.progress[wordKey(word)] = entry;
  }
}

/** 解析导入文本：支持 tab / 逗号 / 多个空格分隔，忽略空行与 # 注释 */
export function parseImport(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\t|,|，|\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [word, meaning, phonetic] = parts;
    if (!/^[A-Za-z][A-Za-z' -]{0,40}$/.test(word)) continue;
    out.push({ word, meaning, phonetic: phonetic ?? '' });
  }
  return out;
}

/** 读 JSON；文件不存在就走 fallback，**解析失败则先备份再从 fallback 重建**——
 *  直接吞掉错误会让用户自建的词库/复习进度无声消失，至少留个 .corrupt-<时间戳> 可救。 */
async function readJsonSafe(file, fallback, onCorrupt) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, backup).catch(() => {});
    if (onCorrupt) onCorrupt(err, backup);
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

export { nowIso };
