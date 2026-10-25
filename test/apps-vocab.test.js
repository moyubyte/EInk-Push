// 背单词应用测试：词库读写/导入、SM-2 复习、拼写判定、会话状态机、渲染，
// 以及「设备录音 → ASR → 判分 → 写回复习计划」这条完整链路（MockDevice + 注入式语音适配器）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { createServer } from '../src/server.js';
import { OpusCodec } from '../src/audio.js';
import { KEY, ACTION } from '../src/packet.js';
import { Library, parseImport, wordId, bundledWordbook } from '../apps/vocabulary/library.js';
import { condense, normalizePhonetic } from '../scripts/build-ielts-wordbook.mjs';
import {
  review, isDue, dueCount, describeInterval, todayIso, MIN_EASE,
} from '../apps/vocabulary/srs.js';
import {
  normalizeSpelling, levenshtein, gradeSpelling, diffLetters,
} from '../apps/vocabulary/quiz.js';
import { StudySession, PHASE, MODE } from '../apps/vocabulary/session.js';
import { renderCard, renderMessage, meaningLines } from '../apps/vocabulary/render.js';
import { DEFAULT_CONFIG, orderQueue } from '../apps/vocabulary/index.js';
import {
  createSpeech, createSpeechService, DEFAULT_SPEECH_CONFIG, synthesizeEdge,
  transcriptionUrl, edgeDrmToken, extractWebmPackets, EDGE_VOICES,
} from '../src/speech.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 8000, step = 60) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(step);
  }
}

/** 距今天 +days 的 ISO 日期，用来算「下次复习」这类相对文案 */
function isoInDays(days) {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + days))
    .toISOString()
    .slice(0, 10);
}

test('词库：内置雅思 6000 词、增删改、导入解析与落盘', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-vocab-'));
  try {
    const library = await new Library(dir).load();
    const textbooks = library.textbooks();
    assert.equal(textbooks.length, 1);

    // 默认词书就是雅思 6000 词：30 个 List × 200 词
    const [ielts] = textbooks;
    assert.equal(ielts.id, 'ielts');
    assert.match(ielts.name, /雅思/);
    assert.equal(ielts.count, 6000, '内置词书应为雅思 6000 词');
    assert.equal(ielts.units.length, 30, '6000 词按每 200 词一个 List 切分');
    assert.equal(ielts.units[0].name, 'List 1');
    assert.equal(ielts.units[0].count, 200);

    const all = library.words();
    assert.equal(all.length, 6000);
    // 词条质量：拼写练习要求单词是纯小写单词、释义非空且不含换行
    for (const entry of all) {
      assert.ok(/^[a-z][a-z'-]*$/.test(entry.word), `单词不合法: ${entry.word}`);
      assert.ok(entry.meaning && !entry.meaning.includes('\n'), `释义不合法: ${entry.word}`);
      if (entry.phonetic) assert.ok(/^\/.+\/$/.test(entry.phonetic), `音标格式: ${entry.word} ${entry.phonetic}`);
    }
    assert.equal(new Set(all.map((entry) => entry.word)).size, 6000, '词书内不应有重复词');
    assert.equal(library.words({ textbookId: 'ielts', unitId: ielts.units[0].id }).length, 200);

    // 单词 id 与大小写/空白无关，改名单元不影响进度归属
    assert.equal(wordId('Apple'), wordId('  apple '));
    assert.equal(wordId('apple').length, 12);

    assert.throws(() => library.addTextbook('   '), /教材名称/);
    const textbook = library.addTextbook('  新概念  ');
    assert.equal(textbook.name, '新概念');
    const unit = library.addUnit(textbook.id, '第 1 课');

    library.addWord(textbook.id, unit.id, { word: 'harbour', meaning: ' 港口 ', phonetic: '/ˈhɑːbə/' });
    assert.equal(unit.words[0].meaning, '港口');
    assert.throws(() => library.addWord(textbook.id, unit.id, { word: 'Harbour', meaning: '港' }), /已有/);
    assert.throws(() => library.addWord(textbook.id, unit.id, { word: '港口', meaning: '港' }), /字母/);
    assert.throws(() => library.addWord(textbook.id, unit.id, { word: 'ok', meaning: '  ' }), /释义/);

    // 导入：tab / 逗号 / 多空格都认，注释与非法行跳过，重复词不计
    const text = [
      '# 注释行',
      'anchor\t锚；主播，anchor 音标列可省',
      'breeze,微风,/briːz/',
      'candle   蜡烛',
      'harbour\t港口',
      'not a word line',
      '123\t数字开头不合法',
    ].join('\n');
    const imported = library.importWords(textbook.id, unit.id, text);
    assert.equal(imported.added, 3, `应导入 anchor/breeze/candle，实际 ${JSON.stringify(imported)}`);
    assert.equal(imported.skipped, 1, 'harbour 已存在应被跳过');
    const parsed = parseImport('apple\t苹果\t/ˈæpl/');
    assert.deepEqual(parsed, [{ word: 'apple', meaning: '苹果', phonetic: '/ˈæpl/' }]);

    assert.equal(library.removeWord(textbook.id, unit.id, 'CANDLE'), 1);
    assert.equal(library.removeWord(textbook.id, unit.id, 'candle'), 0);

    await library.saveLibrary();
    const reloaded = await new Library(dir).load();
    assert.equal(reloaded.textbooks().length, 2);
    assert.equal(reloaded.findUnit(textbook.id, unit.id).words.length, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('词库：老版本的演示词表自动升级成雅思词书，进度不丢', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-vocab-migrate-'));
  try {
    await fs.writeFile(path.join(dir, 'library.json'), JSON.stringify({
      textbooks: [{
        id: 'demo',
        name: '演示词表（非教材）',
        units: [{ id: 'u1', name: '第 1 单元', words: [{ word: 'apple', meaning: '苹果' }] }],
      }],
    }), 'utf8');
    await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify({
      apple: { reps: 2, interval: 6, ease: 2.5, due: '2026-11-01', lastGrade: 2 },
    }), 'utf8');

    const library = await new Library(dir).load();
    assert.equal(library.textbooks()[0].id, 'ielts', '12 词的演示词表应被换成雅思词书');
    assert.equal(library.textbooks()[0].count, 6000);
    assert.equal(library.progress.apple.interval, 6, '进度按单词为键，迁移后仍在');

    // 迁移结果已落盘：再启动一次不会又退回演示数据
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'library.json'), 'utf8'));
    assert.equal(stored.textbooks[0].id, 'ielts');
    const reloaded = await new Library(dir).load();
    assert.equal(reloaded.textbooks()[0].id, 'ielts');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('词书数据：音标与释义都是干净、放得下屏幕的', async () => {
  const { bundledWordbook } = await import('../apps/vocabulary/library.js');
  const words = bundledWordbook().textbooks[0].units.flatMap((unit) => unit.words);
  assert.equal(words.length, 6000);

  // 音标：只有 /xxx/ 一种形态；不能残留源数据里的编码损坏（西里尔字母、^、3、\、(?@)）
  const dirty = words.filter((entry) => /[\u0400-\u04FF^\\?@]/.test(entry.phonetic));
  assert.deepEqual(dirty.slice(0, 5).map((entry) => `${entry.word} ${entry.phonetic}`), [], '音标里有编码损坏');

  // 多读音只留第一套：`/ˈkɔndʌkt, -dəkt/` 这种第二读音会把音标撑出屏幕
  const multi = words.filter((entry) => /[,;]\s|-/.test(entry.phonetic));
  assert.deepEqual(multi.slice(0, 5).map((entry) => `${entry.word} ${entry.phonetic}`), [], '音标仍带多套读音');

  // 释义：没有字面量 \n、没有 `...`，且按屏幕宽度（汉字算 2）不超过 34
  const width = (text) => {
    let total = 0;
    for (const char of text) total += char.codePointAt(0) > 0x2e80 ? 2 : 1;
    return total;
  };
  for (const entry of words) {
    assert.ok(!entry.meaning.includes('\\n'), `${entry.word} 的释义还带着字面量换行`);
    assert.ok(!entry.meaning.includes('...'), `${entry.word} 的释义该用省略号`);
  }
  const tooWide = words.filter((entry) => width(entry.meaning) > 34);
  assert.deepEqual(tooWide.slice(0, 5).map((entry) => `${entry.word}:${entry.meaning}`), [], '释义超宽会在卡上折行溢出');

  // 纯屈折词条（walls / birds / dispiriting）的释义写的是原形，不该混进词书
  const inflected = words.filter((entry) => /的(过去式|过去分词|现在分词|复数|比较级|最高级)/.test(entry.meaning));
  assert.deepEqual(inflected.map((entry) => entry.word), []);
});

test('生成脚本：音标规范化、多读音取舍、释义压缩', () => {
  // 编码损坏 → 正确 IPA
  assert.equal(normalizePhonetic('kəmˈpєə'), '/kəmˈpeə/');
  assert.equal(normalizePhonetic(',dʒiəˈ^ræfik'), '/ˌdʒiəˈgræfik/');
  assert.equal(normalizePhonetic('ˈdw3l'), '/ˈdwel/');
  assert.equal(normalizePhonetic('ˈkɔnv\\ːsli'), '/ˈkɔnvɜːsli/');
  // 只保留第一套读音
  assert.equal(normalizePhonetic('ˈkɔndʌkt, -dəkt'), '/ˈkɔndʌkt/');
  assert.equal(normalizePhonetic('siməlˈteiniəsly; (?@) saim-'), '/siməlˈteiniəsly/');
  assert.equal(normalizePhonetic('riˈtrentʃmənt,riː-'), '/riˈtrentʃmənt/');
  // 逗号是次重音而不是第二读音时不能截断
  assert.equal(normalizePhonetic(',nʌnðəˈles'), '/ˌnʌnðəˈles/');
  assert.equal(normalizePhonetic('ˈriː(h)ə,biliˈteiʃən'), '/ˈriː(h)əˌbiliˈteiʃən/');
  // 兜底
  assert.equal(normalizePhonetic(''), '');
  assert.equal(normalizePhonetic('/.'), '');

  // 释义：字面量 \n 分行、省略号、按义项边界截断
  assert.equal(condense('n. 贸易\\nvt. 交换'), 'n. 贸易');
  assert.equal(condense('vt. 把...强加于'), 'vt. 把…强加于');
  assert.equal(condense('n. 甲；乙；丙；丁', 12), 'n. 甲；乙', '放不下就少一个义项，不要切断词');
  assert.equal(condense('n. 一二三四五六七八九十', 10), 'n. 一二三…', '第一个义项就超宽才硬截');

  // 只写了另一种读法结尾的残片，直接丢弃而不是硬凑
  assert.equal(normalizePhonetic('\u00a0-kli'), '');
});

test('词库文件损坏：先备份再从内置词书重建，不静默丢数据', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-vocab-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, 'library.json'), '{"textbooks": [ 坏掉的 JSON', 'utf8');
    await fs.writeFile(path.join(dir, 'progress.json'), 'not json either', 'utf8');
    const logs = [];
    const library = await new Library(dir, { log: (message) => logs.push(message) }).load();

    assert.equal(library.textbooks().length, 1);
    assert.equal(library.textbooks()[0].count, 6000, '应回落到内置词书');
    assert.equal(library.progress.apple, undefined);
    assert.equal(logs.length, 2, `两种损坏都应留日志：${logs.join(' / ')}`);
    assert.match(logs[0], /词库文件损坏/);
    assert.match(logs[1], /复习进度文件损坏/);

    const files = await fs.readdir(dir);
    const backups = files.filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 2, `应各留一个备份：${files.join(', ')}`);
    const saved = await fs.readFile(path.join(dir, backups.find((name) => name.startsWith('library'))), 'utf8');
    assert.match(saved, /坏掉的 JSON/, '备份的应是原始内容，方便手工抢救');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('升级：旧配置指向演示词表时自动退回新词书', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-vocab-cfg-'));
  const vocab = path.join(dir, 'vocabulary');
  await fs.mkdir(vocab, { recursive: true });
  // 老版本落盘的数据：词库还是 12 词演示数据，配置指向 demo/u1
  await fs.writeFile(path.join(vocab, 'library.json'), JSON.stringify({
    textbooks: [{
      id: 'demo',
      name: '演示词表（非教材）',
      units: [{ id: 'u1', name: '第 1 单元', words: [{ word: 'apple', meaning: '苹果' }] }],
    }],
  }), 'utf8');
  await fs.writeFile(path.join(vocab, 'config.json'), JSON.stringify({ textbookId: 'demo', unitId: 'u1', limit: 5 }), 'utf8');

  const app = createServer({
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'settings.json'),
    auth: false,
    // 这里只验证配置纠正；注入离线语音服务，避免开始练习时整组预生成发音去联网
    createSpeech: () => ({
      asrReady: false,
      ttsReady: false,
      voice: 'test',
      async synthesize() { return null; },
      async recognize() { return null; },
    }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = await (await fetch(`${base}/apps/vocabulary/api/config`)).json();
    assert.equal(config.config.textbookId, 'ielts', '失效的教材 id 应退回内置词书');
    assert.equal(config.config.unitId, null, '失效的单元 id 应清空（否则按单元取词是空的）');
    assert.equal(config.config.limit, 5, '其他配置项要保留');

    // 落盘也要跟着改，否则每次启动都重复纠正
    const stored = JSON.parse(await fs.readFile(path.join(vocab, 'config.json'), 'utf8'));
    assert.equal(stored.textbookId, 'ielts');
    assert.equal(stored.unitId, null);

    const started = await fetch(`${base}/apps/vocabulary/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const body = await started.json();
    assert.equal(started.status, 200, `开始练习不该失败：${body.error}`);
    assert.equal(body.view.total, 5);

    // 显式传一个不存在的词书时，报错要说清是「词书没了」而不是「没有单词」
    const stale = await fetch(`${base}/apps/vocabulary/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textbookId: 'demo' }),
    });
    assert.equal(stale.status, 400);
    assert.match((await stale.json()).error, /不存在/);
  } finally {
    await app.locals.shutdown?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('开始一轮：整组单词自动预生成 TTS', { timeout: 20000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-vocab-prefetch-'));
  const vocab = path.join(dir, 'vocabulary');
  await fs.mkdir(vocab, { recursive: true });
  await fs.writeFile(path.join(vocab, 'library.json'), JSON.stringify({
    textbooks: [{
      // 不能用 id 'demo'：那是老版演示词表的保留 id，load() 会把它强制换成雅思词书
      id: 'mini',
      name: '小词表',
      units: [{
        id: 'u1',
        name: '第 1 单元',
        words: [
          { word: 'apple', meaning: '苹果' },
          { word: 'bridge', meaning: '桥' },
          { word: 'castle', meaning: '城堡' },
        ],
      }],
    }],
  }), 'utf8');
  await fs.writeFile(path.join(vocab, 'config.json'), JSON.stringify({
    textbookId: 'mini', unitId: 'u1', limit: 2,
  }), 'utf8');

  const synthesized = [];
  const app = createServer({
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'settings.json'),
    auth: false,
    // 离线合成器：记录被预生成的词，返回一段占位 PCM
    createSpeech: () => ({
      asrReady: false,
      ttsReady: true,
      voice: 'test',
      async synthesize(text) {
        synthesized.push(text);
        return new Int16Array(160);
      },
      async recognize() { return null; },
    }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const started = await fetch(`${base}/apps/vocabulary/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 200);
    await waitFor(() => synthesized.length >= 2);
    assert.deepEqual(
      synthesized.slice().sort(),
      ['apple', 'bridge'],
      '开始一轮后应把整组词都预生成到 TTS 缓存',
    );
  } finally {
    await app.locals.shutdown?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('复习计划：SM-2 间隔递增、评分纠正与到期判断', () => {
  const day1 = '2026-10-22';
  const first = review(null, 2, day1);
  assert.equal(first.reps, 1);
  assert.equal(first.interval, 1);
  assert.equal(first.due, '2026-10-23');
  assert.equal(first.seen, 1);
  assert.equal(first.lastGrade, 2);

  const second = review(first, 2, '2026-10-23');
  assert.equal(second.reps, 2);
  assert.equal(second.interval, 6);
  assert.equal(second.due, '2026-10-29');

  // 间隔用「上一轮间隔 × 当前 ease」算，再更新 ease：6 × 2.40 = 14.4 → 14
  const third = review(second, 3, '2026-10-29');
  assert.equal(third.reps, 3);
  assert.equal(third.interval, 14);
  assert.equal(third.ease, 2.5);
  assert.equal(third.due, isoFrom(day1, 1 + 6 + 14));

  // 评 0：reps 归零、lapses+1、ease 变低、明天重来
  const lapse = review(third, 0, '2026-11-12');
  assert.equal(lapse.reps, 0);
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.interval, 1);
  assert.equal(lapse.due, '2026-11-13');
  assert.ok(lapse.ease < third.ease);

  // ease 有下限，连续评 0 不会无限下探
  let state = lapse;
  for (let i = 0; i < 12; i++) state = review(state, 0, '2026-11-13');
  assert.equal(state.ease, MIN_EASE);

  assert.equal(isDue(null, day1), true, '没有进度记录视为新词，立刻可学');
  assert.equal(isDue({ due: day1 }, day1), true);
  assert.equal(isDue({ due: '2026-10-23' }, day1), false);
  assert.equal(dueCount({ a: { due: day1 }, b: { due: '2099-01-01' } }, day1), 1);

  assert.equal(describeInterval(null), '首次学习');
  assert.equal(describeInterval(review(null, 2)), '明天复习');
  assert.equal(describeInterval({ due: isoInDays(1) }), '明天复习');
  assert.equal(describeInterval({ due: isoInDays(0) }), '今天再看');
  assert.equal(describeInterval({ due: isoInDays(4) }), '4 天后复习');
  assert.equal(describeInterval({ due: isoInDays(60) }), '2 个月后复习');
});

function isoFrom(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

test('拼写判定：规整、编辑距离、差一字母与中文串扰', () => {
  assert.equal(normalizeSpelling('A P P L E.'), 'apple');
  assert.equal(normalizeSpelling('a-p-p-l-e'), 'apple');
  assert.equal(normalizeSpelling('apple 苹果'), 'apple');
  assert.equal(normalizeSpelling(undefined), '');

  assert.equal(levenshtein('apple', 'apple'), 0);
  assert.equal(levenshtein('apple', 'aple'), 1);
  assert.equal(levenshtein('kitten', 'sitting'), 3);

  assert.equal(gradeSpelling('Apple', 'apple').correct, true);
  const near = gradeSpelling('aple', 'apple');
  assert.equal(near.correct, false);
  assert.equal(near.near, true);
  assert.equal(near.distance, 1);
  assert.equal(near.got, 'aple');

  // 首字母不对就不给「重读一次」的机会，避免把完全听错当成差一点
  assert.equal(gradeSpelling('xpple', 'apple').near, false);
  assert.equal(gradeSpelling('banana', 'apple').near, false);

  const empty = gradeSpelling('  ', 'apple');
  assert.equal(empty.empty, true);
  assert.equal(empty.correct, false);
  assert.equal(empty.near, false);

  const marks = diffLetters('apple', 'aple');
  assert.equal(marks.length, 5);
  assert.equal(marks.filter((mark) => !mark.ok).length, 1);
  assert.equal(marks.filter((mark) => mark.ok).length, 4);
});

test('会话状态机：翻卡与拼写两条路径、跳过与汇总', () => {
  const words = [
    { word: 'apple', meaning: '苹果', phonetic: '/ˈæpl/' },
    { word: 'bridge', meaning: '桥' },
  ];

  // 翻卡：确认 → 答案（默认记得）→ 确认 → 下一词
  const flash = new StudySession({ words, mode: MODE.FLASHCARD });
  assert.equal(flash.phase, PHASE.PROMPT);
  assert.deepEqual([flash.view().index, flash.view().total], [1, 2]);
  assert.match(flash.view().hint, /确认键看答案/);
  assert.match(flash.view().hint, /上键/, '提示里应说明上键听发音');
  flash.reveal(2);
  assert.equal(flash.phase, PHASE.ANSWER);
  assert.equal(flash.pendingGrade, 2);
  assert.match(flash.view().hint, /上键/, '答案页提示里应说明上键重听');
  flash.markGrade(3);
  flash.commit();
  assert.equal(flash.phase, PHASE.PROMPT);
  assert.equal(flash.view().index, 2);
  flash.reveal(2);
  flash.commit();
  assert.equal(flash.phase, PHASE.DONE);
  assert.equal(flash.done, true);
  const summary = flash.summary();
  assert.equal(summary.total, 2);
  assert.equal(summary.correct, 2);
  assert.equal(summary.wrong, 0);
  assert.equal(summary.records.length, 2);

  // 拼写：没听清 → 重读；差一字母 → 只给一次机会；第二次升级为「整词朗读」并判错
  const spell = new StudySession({ words, mode: MODE.SPELLING });
  spell.startSpelling();
  assert.equal(spell.phase, PHASE.SPELLING);
  const silent = spell.submitSpelling({ empty: true, correct: false, near: false });
  assert.equal(silent.retry, true);
  assert.equal(silent.empty, true);
  assert.equal(spell.phase, PHASE.SPELLING, '没听清不应离开拼写阶段');

  const firstNear = spell.submitSpelling({ correct: false, near: true, got: 'aple', expected: 'apple' });
  assert.equal(firstNear.retry, true);
  assert.equal(spell.retried, true);
  assert.match(spell.view().hint, /再读一次/);
  const secondNear = spell.submitSpelling({ correct: false, near: true, got: 'aple', expected: 'apple' });
  assert.equal(secondNear.retry, false);
  assert.equal(spell.phase, PHASE.WORD);
  assert.equal(spell.pendingGrade, 0);

  // 跳过：留痕但不计入对错
  const skip = new StudySession({ words, mode: MODE.FLASHCARD });
  skip.skip();
  assert.equal(skip.view().index, 2);
  assert.equal(skip.records[0].skipped, true);
  assert.equal(skip.counts.answered, 1);
  assert.equal(skip.counts.correct + skip.counts.wrong, 0);

  // 没有待评成绩时 commit 视为跳过
  const ungraded = new StudySession({ words, mode: MODE.FLASHCARD });
  ungraded.commit();
  assert.equal(ungraded.records[0].grade, null);
  assert.equal(ungraded.records[0].skipped, true);

  const limited = new StudySession({ words: [...words, { word: 'candle', meaning: '蜡烛' }], limit: 2 });
  assert.equal(limited.total, 2);
  const empty = new StudySession({ words: [] });
  assert.equal(empty.phase, PHASE.DONE);
});

test('渲染：最长的 200 条释义在提示页和朗读页都能完整放下，不被截断', async () => {
  const { createDeviceCanvas } = await import('../apps/shared/canvas.js');
  const { ctx } = createDeviceCanvas({ background: '#ffffff' });
  const width = (text) => {
    let total = 0;
    for (const char of text) total += char.codePointAt(0) > 0x2e80 ? 2 : 1;
    return total;
  };
  const words = bundledWordbook().textbooks[0].units
    .flatMap((unit) => unit.words)
    .sort((a, b) => width(b.meaning) - width(a.meaning))
    .slice(0, 200);

  const failures = [];
  for (const entry of words) {
    const total = [...entry.meaning].length;
    // 提示页 [26,22,20] 与朗读页 [18,16] 两套字号
    for (const sizes of [[26, 22, 20], [18, 16]]) {
      const { lines, size } = meaningLines(ctx, entry.meaning, { sizes });
      const covered = lines.reduce((count, item) => count + [...item].length, 0);
      assert.ok(lines.length <= 2, `${entry.word} 排了 ${lines.length} 行`);
      if (covered < total) failures.push(`${entry.word}@${size}px: ${entry.meaning}`);
    }
  }
  assert.deepEqual(failures.slice(0, 5), [], '释义被截断，回忆时线索就丢了');
});

test('渲染：各阶段都是 400×300，且提示/朗读阶段不泄漏英文拼写', async () => {
  const base = {
    mode: MODE.SPELLING,
    index: 1,
    total: 3,
    textbookName: '演示词表',
    unitName: '第 1 单元',
    counts: { correct: 0, wrong: 0, skipped: 0, answered: 0 },
    elapsedMs: 1000,
    hint: '长按语音键读字母',
    retried: false,
    result: null,
    nextReview: '明天复习',
  };
  const item = { word: 'apple', meaning: '苹果', phonetic: '/ˈæpl/' };
  const png = renderCard({ ...base, phase: PHASE.PROMPT, item });
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
  const stats = await sharp(png).stats();
  // 灰阶抗锯齿后整图均值仍然接近白底，用「存在深色像素」判断图里确实画了东西
  assert.ok(stats.channels[0].min < 128, '图里应有内容');

  // 提示阶段与朗读阶段只给中文：换掉英文单词不该改变任何像素（拼写不泄漏）
  const otherWord = renderCard({ ...base, phase: PHASE.PROMPT, item: { ...item, word: 'banana' } });
  assert.ok(png.equals(otherWord), '提示阶段不应绘制英文单词');
  const wordPhase = renderCard({ ...base, phase: PHASE.WORD, item, hint: '长按只读整词' });
  const wordPhaseOther = renderCard({ ...base, phase: PHASE.WORD, item: { ...item, word: 'banana' }, hint: '长按只读整词' });
  assert.ok(wordPhase.equals(wordPhaseOther), '朗读阶段不应绘制英文单词（音标也不能画）');

  // 答案阶段必须画出来：换单词图就该变
  const answer = renderCard({ ...base, phase: PHASE.ANSWER, item, hint: '确认=记得' });
  const answerOther = renderCard({ ...base, phase: PHASE.ANSWER, item: { ...item, word: 'banana' }, hint: '确认=记得' });
  assert.ok(!answer.equals(answerOther), '答案阶段应绘制英文单词');

  for (const phase of [PHASE.SPELLING, PHASE.DONE]) {
    const view = phase === PHASE.SPELLING
      ? { ...base, phase, item, result: { correct: false, near: true, got: 'aple', expected: 'apple' } }
      : { ...base, phase, item };
    assert.equal((await sharp(renderCard(view)).metadata()).width, 400, `${phase} 阶段渲染失败`);
  }
  assert.equal((await sharp(renderMessage('背单词', '还没有开始练习')).metadata()).width, 400);
});

test('排队顺序：到期优先、新词次之，order/random 两种模式', () => {
  // 日期跟着「今天」走：硬编码日期会在跨天后悄悄失效
  const words = [
    { word: 'a', progress: { due: isoInDays(1) } }, // 明天才到期 → 排后
    { word: 'b', progress: null }, // 新词 → 立刻可学
    { word: 'c', progress: { due: isoInDays(-1) } }, // 已过期 → 排前
  ];
  const due = orderQueue(words, 'due');
  assert.deepEqual(due.map((item) => item.word), ['b', 'c', 'a'], '新词与到期词都在前排，远期词垫底');
  assert.deepEqual(orderQueue(words, 'order').map((item) => item.word), ['a', 'b', 'c']);
  assert.equal(orderQueue(words, 'random').length, 3);
  assert.equal(DEFAULT_CONFIG.mode, 'auto');
});

test('Web 接口：词库增删、会话推进、设备按键与录音拼写（离线注入 ASR）', { timeout: 40000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-vocab-e2e-'));
  const recognitions = [];
  let asrText = 'apple'; // 拼写阶段「听见」的内容，取到本轮的词之后再改
  const app = createServer({
    device: `127.0.0.1:${port}`,
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'config.json'),
    auth: false,
    // 注入一个假 ASR：不联网也能验证整条拼写链路
    createSpeech: (options = {}) => ({
      asrReady: true,
      ttsReady: true,
      voice: options.ttsVoice ?? 'test',
      async recognize(pcm) {
        recognitions.push(pcm.length);
        return asrText;
      },
      async synthesize() { return null; },
    }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const codec = new OpusCodec();
  const samples = new Int16Array(960);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.3) * 9000);
  const frames = codec.encode(samples);
  const session = async () => (await (await fetch(`${base}/apps/vocabulary/api/session`)).json()).view;

  try {
    const config = await (await fetch(`${base}/apps/vocabulary/api/config`)).json();
    assert.equal(config.mode, 'spelling', '注入了 ASR 应自动进入拼写模式');
    assert.equal(config.asrReady, true);
    assert.equal(config.speechVoice, DEFAULT_SPEECH_CONFIG.ttsVoice, '默认音色应是 Aria');

    // 语音服务是全局能力：配置与试听都在 /api/speech，不再挂在背单词应用下
    const speechState = await (await fetch(`${base}/api/speech`)).json();
    assert.equal(speechState.ok, true);
    assert.equal(speechState.config.ttsVoice, DEFAULT_SPEECH_CONFIG.ttsVoice);
    assert.ok(speechState.voices.some((v) => v.id === 'en-GB-SoniaNeural'), '应下发英文音色');
    assert.ok(speechState.voices.some((v) => v.id === 'zh-CN-XiaoxiaoNeural'), '应下发中文音色');

    // 音色写错要 400；合法语音配置应落盘并能被页面读回
    const headers = { 'Content-Type': 'application/json' };
    const badVoice = await fetch(`${base}/api/speech`, {
      method: 'PUT', headers, body: JSON.stringify({ ttsVoice: 'apple' }),
    });
    assert.equal(badVoice.status, 400);
    const speechSaved = await fetch(`${base}/api/speech`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ttsVoice: 'en-GB-SoniaNeural', asrBaseUrl: 'https://api.example.com/v1', asrModel: 'whisper-1', asrApiKey: 'sk-1',
      }),
    });
    const speechSavedBody = await speechSaved.json();
    assert.equal(speechSaved.status, 200, JSON.stringify(speechSavedBody));
    assert.equal(speechSavedBody.config.ttsVoice, 'en-GB-SoniaNeural');
    assert.equal(speechSavedBody.asrReady, true);
    const storedSpeech = JSON.parse(await fs.readFile(path.join(dir, 'speech.json'), 'utf8'));
    assert.equal(storedSpeech.asrBaseUrl, 'https://api.example.com/v1');
    assert.equal(storedSpeech.asrModel, 'whisper-1');

    // 试听：注入的合成器返回 null，接口应报「合成失败」而不是 500
    const ttsProbe = await fetch(`${base}/api/speech/test`, {
      method: 'POST', headers, body: JSON.stringify({ text: 'apple' }),
    });
    assert.equal(ttsProbe.status, 200);
    const ttsProbeBody = await ttsProbe.json();
    assert.equal(ttsProbeBody.ok, false);
    assert.equal(ttsProbeBody.voice, 'en-GB-SoniaNeural');

    const library = await (await fetch(`${base}/apps/vocabulary/api/library`)).json();
    assert.equal(library.stats.total, 6000, '接口应加载内置雅思词书');
    assert.equal(library.stats.due, 6000, '新词都算到期');
    assert.equal(library.textbooks[0].id, 'ielts');

    // 本轮用第一个 List 的头两个词；ASR 照用户念的逐字母回包
    const firstUnit = library.textbooks[0].units[0];
    const listBody = await (await fetch(
      `${base}/apps/vocabulary/api/library/words?textbookId=ielts&unitId=${firstUnit.id}`,
    )).json();
    const [word1, word2] = listBody.words;
    assert.ok(word1 && word2, '第一个 List 至少要两个词');
    assert.equal(listBody.total, 200);
    asrText = word1.word.split('').join(' ');

    // 没开始就推进 → 409，而不是把 null 当会话用
    const tooEarly = await fetch(`${base}/apps/vocabulary/api/session/next`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(tooEarly.status, 409);

    // 词库写入链路
    const created = await fetch(`${base}/apps/vocabulary/api/library/textbooks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '自建教材' }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 200);
    const badWord = await fetch(`${base}/apps/vocabulary/api/library/words`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ textbookId: createdBody.textbook.id, unitId: 'missing', word: 'apple', meaning: '苹果' }),
    });
    assert.equal(badWord.status, 400, '不存在的单元应 400');

    const started = await fetch(`${base}/apps/vocabulary/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 2 }),
    });
    const startedBody = await started.json();
    assert.equal(started.status, 200, JSON.stringify(startedBody));
    assert.equal(startedBody.view.phase, PHASE.PROMPT);
    assert.equal(startedBody.view.total, 2);
    assert.equal(startedBody.view.item.word, word1.word);

    const preview = await fetch(`${base}/apps/vocabulary/api/preview.png`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');

    // 1) 设备录音上行 → ASR「a p p l e」→ 判对 → 进入整词朗读阶段
    await device.sendRecording(501, frames, 960, 0);
    const spelled = await waitFor(async () => {
      const view = await session();
      return view?.phase === PHASE.WORD ? view : null;
    });
    assert.ok(spelled, `录音后应进入 word 阶段，实际 ${JSON.stringify(await session())}`);
    assert.equal(spelled.result.correct, true);
    assert.ok(recognitions.length >= 1, 'ASR 应被调用一次');

    // 2) 确认 → 答案页；再确认 → 记为「记得」并进入第二个词
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    const answerView = await waitFor(async () => {
      const view = await session();
      return view?.phase === PHASE.ANSWER ? view : null;
    });
    assert.ok(answerView, '确认键应翻到答案页');
    assert.equal(answerView.item.word, word1.word);

    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    const second = await waitFor(async () => {
      const view = await session();
      return view?.phase === PHASE.PROMPT && view.index === 2 ? view : null;
    });
    assert.ok(second, `应前进到第 2 个词，实际 ${JSON.stringify(await session())}`);
    assert.equal(second.item.word, word2.word);

    // 第一个词的成绩应已按 SM-2 落盘
    const learned = await waitFor(async () => {
      const progress = await readJson(path.join(dir, 'vocabulary', 'progress.json'));
      return progress?.[word1.word] ?? null;
    });
    assert.ok(learned, `${word1.word} 的复习进度应写入 progress.json`);
    assert.equal(learned.reps, 1);
    assert.equal(learned.interval, 1);
    assert.equal(learned.lastGrade, 2);

    // 3) 第二个词继续「听见 apple」→ 与 bridge 不符 → 判错 → 下滑记为「忘了」
    await device.sendRecording(502, frames, 960, 0);
    const wrong = await waitFor(async () => {
      const view = await session();
      return view?.phase === PHASE.WORD ? view : null;
    });
    assert.ok(wrong, '第二次录音也应进入 word 阶段');
    assert.equal(wrong.result.correct, false);
    assert.equal(wrong.result.expected, word2.word);

    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    assert.ok(await waitFor(async () => (await session())?.phase === PHASE.ANSWER));
    device.sendKey(KEY.DOWN, ACTION.SHORT);
    const done = await waitFor(async () => {
      const view = await session();
      return view?.phase === PHASE.DONE ? view : null;
    });
    assert.ok(done, `两个词都过完应结束，实际 ${JSON.stringify(await session())}`);
    assert.equal(done.counts.correct, 1);
    assert.equal(done.counts.wrong, 1);

    const failed = await waitFor(async () => {
      const progress = await readJson(path.join(dir, 'vocabulary', 'progress.json'));
      return progress?.[word2.word] ?? null;
    });
    assert.ok(failed, `${word2.word} 也应写入复习进度`);
    assert.equal(failed.lastGrade, 0);
    assert.equal(failed.interval, 1);

    // 设备确实收到了多次推送（每换一屏一张图）
    assert.ok(device.images.size >= 4, `设备应收到多张图，实际 ${device.images.size}`);

    const stopped = await fetch(`${base}/apps/vocabulary/api/session/stop`, { method: 'POST' });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).summary.total, 2);
    assert.equal(await session(), null);
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    device.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

test('其他应用下发后，背单词本轮自动结束，按键不再抢屏', { timeout: 20000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: false });
  const port = await device.start();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-vocab-yield-'));
  const app = createServer({
    device: `127.0.0.1:${port}`,
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'config.json'),
    auth: false,
    createSpeech: () => ({
      asrReady: false,
      ttsReady: false,
      voice: 'test',
      async synthesize() { return null; },
      async recognize() { return null; },
    }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = async () => (await (await fetch(`${base}/apps/vocabulary/api/session`)).json()).view;

  try {
    const started = await fetch(`${base}/apps/vocabulary/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(started.status, 200);
    assert.ok(await session(), '背单词应处于练习中');

    // 另一个应用（掷杯筊）向设备推图：背单词本轮应立刻结束
    const thrown = await fetch(`${base}/apps/jiaobei/api/throw`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ push: true }),
    }).then((r) => r.json());
    assert.equal(thrown.ok, true, JSON.stringify(thrown));
    assert.ok(await waitFor(() => device.images.size >= 2), '掷杯筊的画面应推到设备');

    assert.equal(await session(), null, '其他应用下发后背单词本轮应自动结束');

    // 本轮结束后确认键不应再把背单词的卡片推上设备
    const imagesAfterThrow = device.images.size;
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    await sleep(400);
    assert.equal(device.images.size, imagesAfterThrow, '确认键不应再推背单词的卡片');
    assert.equal(await session(), null);
  } finally {
    await app.locals.shutdown().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    device.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- 语音：Edge TTS 协议 + OpenAI 兼容 ASR ----

test('ASR 地址规整：/v1、完整接口、裸域名三种写法都能用', () => {
  assert.equal(transcriptionUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(transcriptionUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(transcriptionUrl('https://asr.example.com/audio/transcriptions'), 'https://asr.example.com/audio/transcriptions');
  assert.equal(transcriptionUrl('https://asr.example.com'), 'https://asr.example.com/v1/audio/transcriptions');
  assert.equal(transcriptionUrl(null), null);
  assert.equal(transcriptionUrl('   '), null);
});

test('ASR：multipart 上传 16kHz WAV，带模型与 Bearer 密钥', async () => {
  const calls = [];
  const speech = createSpeech({
    asrBaseUrl: 'https://api.example.com/v1',
    asrModel: 'whisper-1',
    asrApiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ text: 'a p p l e' }), { status: 200 });
    },
    log: () => {},
  });
  assert.equal(speech.asrReady, true);
  assert.equal(speech.ttsReady, true);

  const pcm = new Int16Array(1600).fill(1200);
  assert.equal(await speech.recognize(pcm), 'a p p l e');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/audio/transcriptions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData, '应按 OpenAI 兼容接口发 multipart');
  assert.equal(form.get('model'), 'whisper-1');
  const file = form.get('file');
  assert.ok(file instanceof Blob);
  assert.equal(file.type, 'audio/wav');
  const wav = Buffer.from(await file.arrayBuffer());
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);

  // 静音不浪费一次网络请求
  calls.length = 0;
  assert.equal(await speech.recognize(new Int16Array(1600)), null);
  assert.equal(calls.length, 0);

  // 未配模型/地址时直接不可用
  assert.equal(createSpeech({ log: () => {} }).asrReady, false);
});

test('Edge TTS：发 SSML、拼音频帧、返回 16kHz PCM', async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.sent = [];
      this.listeners = new Map();
      this.closed = false;
      sockets.push(this);
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type, event = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; }
  }

  const promise = synthesizeEdge('apple', {
    voice: 'en-US-AriaNeural', WebSocketImpl: FakeSocket, timeout: 3000, log: () => {},
    decode: (buffer) => {
      decoded = buffer;
      return new Int16Array([16, -16]);
    },
  });
  let decoded = null;
  const ws = sockets[0];
  assert.match(ws.url, /^wss:\/\/api\.msedgeservices\.com\/tts\/cognitiveservices\/websocket\/v1\?/);
  assert.match(ws.url, /Ocp-Apim-Subscription-Key=6A5AA1D4EAFF4E9FB37E23D68491D6F4/);
  assert.match(ws.url, /Sec-MS-GEC=[A-F0-9]{64}/);
  assert.match(ws.url, /Sec-MS-GEC-Version=1-143\./);
  assert.equal(ws.options.headers.Origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
  assert.match(ws.options.headers['User-Agent'], /Edg\/143/);

  ws.emit('open');
  assert.equal(ws.sent.length, 2, '应先发 speech.config 再发 ssml');
  assert.match(ws.sent[0], /Path:speech\.config/);
  assert.match(ws.sent[0], /webm-24khz-16bit-mono-opus/);
  assert.match(ws.sent[1], /Path:ssml/);
  assert.match(ws.sent[1], /<voice name='en-US-AriaNeural'>/);
  assert.match(ws.sent[1], />apple</);

  const frame = (header, audio) => {
    const head = Buffer.from(header, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(head.length);
    return Buffer.concat([len, head, audio]); // 直接给 Buffer，避免 .buffer 带上内存池的前缀
  };
  const audioPayload = Buffer.from('fake-webm-bytes');
  ws.emit('message', { data: frame('X-RequestId:1\r\nPath:turn.start\r\n', Buffer.alloc(0)) });
  ws.emit('message', { data: frame('X-RequestId:1\r\nPath:audio\r\n', audioPayload) });
  ws.emit('message', { data: 'X-RequestId:1\r\nPath:turn.end\r\n' });

  const pcm = await promise;
  assert.deepEqual([...pcm], [16, -16]);
  assert.deepEqual(decoded, audioPayload, '应按顺序拼接 Path:audio 的负载再解码');
  assert.equal(ws.closed, true);
});

test('WebM 解包：从流式（长度未知）容器里按顺序取出 Opus 包', () => {
  const idBytes = (id) => {
    const hex = id.toString(16).padStart(2, '0');
    return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  };
  const sizeBytes = (size) => {
    if (size < 0x80) return Buffer.from([0x80 | size]);
    return Buffer.from([0x40 | (size >> 8), size & 0xff]);
  };
  const el = (id, payload, unknown = false) => Buffer.concat([
    idBytes(id),
    // EBML 的「未知长度」是 8 字节 vint 全 1：0x01 后面跟 7 个 0xff
    unknown ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : sizeBytes(payload.length),
    payload,
  ]);
  const block = (packet) => el(0xa3, Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), packet]));

  const webm = Buffer.concat([
    el(0x1a45dfa3, Buffer.alloc(4)),
    el(0x18538067, Buffer.concat([
      el(0x1f43b675, Buffer.concat([block(Buffer.from('packet-1')), block(Buffer.from('packet-2'))]), true),
      el(0x1f43b675, block(Buffer.from('packet-3')), true), // 第二个 Cluster 也是未知长度
    ]), true),
  ]);
  const packets = extractWebmPackets(webm).map((p) => p.toString());
  assert.deepEqual(packets, ['packet-1', 'packet-2', 'packet-3']);
});

test('Edge TTS：合成结果按音色+文本缓存，失败返回 null 且不缓存', async () => {
  let sockets = 0;
  let fail = false;
  class AutoSocket {
    constructor() {
      sockets += 1;
      this.listeners = new Map();
      setTimeout(() => {
        this.emit('open');
        if (fail) return this.emit('close', { code: 1006 });
        const audio = Buffer.from([0x20, 0x00]);
        const head = Buffer.from('Path:audio\r\n', 'utf8');
        const len = Buffer.alloc(2);
        len.writeUInt16BE(head.length);
        this.emit('message', { data: Buffer.concat([len, head, audio]) });
        this.emit('message', { data: 'Path:turn.end' });
      }, 0);
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type, event = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    send() {}
    close() {}
  }

  const speech = createSpeech({
    ttsVoice: 'en-US-AriaNeural',
    WebSocketImpl: AutoSocket,
    decode: () => new Int16Array([32]),
    log: () => {},
  });
  const first = await speech.synthesize('apple');
  const second = await speech.synthesize('apple');
  assert.deepEqual([...first], [32]);
  assert.equal(first, second, '同一个词不应重复联网');
  assert.equal(sockets, 1);
  await assert.doesNotReject(speech.synthesize('  '));
  assert.equal(await speech.synthesize('  '), null, '空文本直接返回 null');

  fail = true;
  assert.equal(await speech.synthesize('bridge'), null);
  assert.equal(sockets, 2, '失败的结果不缓存');
});

test('Edge 的 DRM 参数：64 位大写十六进制，5 分钟内稳定', () => {
  const a = edgeDrmToken(Date.UTC(2026, 9, 24, 4, 1, 0));
  const b = edgeDrmToken(Date.UTC(2026, 9, 24, 4, 4, 59));
  const c = edgeDrmToken(Date.UTC(2026, 9, 24, 4, 5, 1));
  assert.match(a, /^[A-F0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('语音服务：音色列表中英文齐全，配置校验、落盘与重新加载', async () => {
  // 中英文常见口音都要有，避免“只能读英文单词”这种半残状态
  for (const locale of ['zh-CN', 'zh-HK', 'zh-TW', 'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN']) {
    assert.ok(EDGE_VOICES.some((voice) => voice.lang === locale), `缺少 ${locale} 音色`);
  }
  assert.ok(EDGE_VOICES.some((voice) => voice.id === 'zh-CN-liaoning-XiaobeiNeural'), '方言音色也要能选');
  const ids = EDGE_VOICES.map((voice) => voice.id);
  assert.equal(new Set(ids).size, ids.length, '音色 id 不应重复');
  assert.equal(DEFAULT_SPEECH_CONFIG.ttsVoice, 'en-US-AriaNeural');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zx-speech-'));
  const file = path.join(dir, 'speech.json');
  const factory = (options = {}) => ({
    asrReady: Boolean(options.asrModel),
    ttsReady: true,
    voice: options.ttsVoice,
    synthesize: async () => null,
    recognize: async () => null,
  });
  try {
    const service = createSpeechService({ file, factory, log: () => {} });
    await service.load();
    assert.equal(service.voice, DEFAULT_SPEECH_CONFIG.ttsVoice);
    assert.equal(service.asrReady, false);

    await assert.rejects(service.update({ ttsVoice: 'apple' }), /音色/);
    await assert.rejects(service.update({ asrBaseUrl: 'ftp://x' }), /http/);

    await service.update({
      ttsVoice: 'zh-CN-XiaoxiaoNeural', asrBaseUrl: 'https://asr.example.com/v1', asrModel: 'whisper-1',
    });
    assert.equal(service.voice, 'zh-CN-XiaoxiaoNeural');
    assert.equal(service.asrReady, true);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.ttsVoice, 'zh-CN-XiaoxiaoNeural');
    assert.equal(stored.asrBaseUrl, 'https://asr.example.com/v1');

    // 新进程/新实例应读到同一份配置，而不是回到默认音色
    const again = createSpeechService({ file, factory, log: () => {} });
    await again.load();
    assert.equal(again.voice, 'zh-CN-XiaoxiaoNeural');
    assert.equal(again.config.asrModel, 'whisper-1');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
