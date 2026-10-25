// 从 ECDICT 生成「雅思 6000 词」词书（apps/vocabulary/data/ielts-6000.json）。
//
// 数据来源：ECDICT（https://github.com/skywind3000/ECDICT），MIT 授权的中英词典数据库，
// 每个词条带 `tag`（zk/gk/cet4/cet6/ky/toefl/ielts/gre）、`phonetic`、`translation` 与两套词频。
// 选词口径：tag 含 ielts → 去掉专有名词/词组/无中文释义/纯屈折形式的词 → 按当代语料库词频
// （frq，缺失退到 bnc，再缺按柯林斯星级分层）排序；只有 4 千来个直接带 ielts 标签的词，
// 不足 6000 时用 toefl 共考词按词频补足 → 每 200 词一个 List（共 30 个）。
//
// 用法：
//   npm run build:wordbook                                  # 缺省读 .cache/ecdict.csv
//   node scripts/build-ielts-wordbook.mjs 别的词典.csv
//   node scripts/build-ielts-wordbook.mjs --limit 3000 --size 100
//   node scripts/build-ielts-wordbook.mjs --base-rank 0      # 不剔除 the/in/on 这类超基础词
//
// 这个脚本只需要在更新词表时手动跑一次，产物已随仓库提交，日常运行不依赖网络。
// 65 MB 的 ecdict.csv 用 curl 直下容易半途截断（拼出来的 CSV 会混进二进制垃圾），
// 建议用 scripts/fetch-ecdict.mjs：分块下载 + 逐块校验 + 多镜像重试。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'apps/vocabulary/data/ielts-6000.json');

/** 解析命令行：`--name value` / `--name=value` / 单独的位置参数（词典路径）。
 *  注意别把 `--fill-tags toefl` 的取值当成词典路径。 */
function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true); // 开关式参数
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const flag = (name, fallback = null) => (flags.has(name) ? flags.get(name) : fallback);
const intFlag = (name, fallback, { min = 0 } = {}) => {
  const value = Number(flag(name, fallback));
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
};

const LIMIT = intFlag('limit', 6000, { min: 1 });
const UNIT_SIZE = intFlag('size', 200, { min: 1 });
const BASE_RANK = intFlag('base-rank', 800); // 词频排名在这之前的词（the/in/on…）不进词书
const INPUT = positional[0] ?? path.join(ROOT, '.cache/ecdict.csv');
// 可选：再叠加一份精选雅思词表（qwerty-learner 的 IELTS_3_T.json 格式），用来补 ECDICT 标签池不够的部分
const EXTRA_GIVEN = flags.has('extra');
const EXTRA = EXTRA_GIVEN
  ? (typeof flags.get('extra') === 'string' ? flags.get('extra') : null)
  : path.join(ROOT, '.cache/IELTS_3_T.json');
// ECDICT 里 tag=ielts 的词条去重后只有 4 千多，不够 6000；不足部分用这些标签的词按词频补足（雅思/托福共考词）
const FILL_TAGS = String(flag('fill-tags', 'toefl')).split(',').map((tag) => tag.trim()).filter(Boolean);
const FILL_RE = FILL_TAGS.length ? new RegExp(`\\b(${FILL_TAGS.join('|')})\\b`) : null;

/** 音标规范化。ECDICT 的音标字段混着几类脏数据，不清理会直接显示到屏幕上：
 *   - 西里尔字母 ә / є 被当 schwa / e 用（复制出来对不上任何词典）
 *   - `^`、`3`、`\` 是 g / e / ɜ 的编码损坏（`/,dʒiəˈ^ræfik/`、`/ˈdw3l/`、`/ˈkɔnv\ːsli/`）
 *   - 用 ASCII 撇号当重音符、用 `.` `,` 当次重音符
 *   - 一个词条塞两三套读音（`/ˈkɔndʌkt, -dəkt/`、`/siməlˈteiniəsly; (?@) saim-/`） */
const PHONETIC_CHARS = [
  [/\u04d9/g, '\u0259'], // ә (西里尔 schwa) → ə
  [/\u0454/g, 'e'], // є (西里尔 e) → e
  [/\u03b5/g, 'e'], // ε (希腊 epsilon，源数据里当 e 用) → e
  [/\u1d27/g, '\u028c'], // ᴧ → ʌ
  [/\^/g, 'g'], // ^ → g
  [/3/g, 'e'], // 3 → e
  [/\\/g, '\u025c'], // \ → ɜ
  [/'/g, '\u02c8'], // ' → ˈ
  [/:/g, '\u02d0'], // : → ː
];

/** 只保留第一套读音：分隔符后面如果是空格、短横线，或整段以短横线结尾，
 *  那它是在列另一种读法（美音、弱读、变体），对一张卡片没意义。
 *  而 `/,nʌnðəˈles/`、`/ˈriː(h)ə,biliˈteiʃən/` 里的逗号是次重音，要保留。 */
export function firstPronunciation(text) {
  const clean = String(text).replace(/;\s*\(\?@\).*$/i, ''); // `; (?@) saim-` 这种占位垃圾
  for (let i = 1; i < clean.length; i++) {
    const char = clean[i];
    if (char !== ',' && char !== ';' && char !== '.') continue;
    const rest = clean.slice(i + 1);
    if (/^\s/.test(rest) || rest.startsWith('-') || rest.trim().endsWith('-')) {
      return clean.slice(0, i);
    }
  }
  return clean;
}

export function normalizePhonetic(raw) {
  let text = String(raw ?? '').trim().replace(/^\/|\/$/g, '').replace(/^[\s\u00a0]+/, '');
  if (!text) return '';
  // 源数据里有「只写了另一种读法结尾」的残片（如 `-kli`），还原不了就整条丢掉，别硬凑
  if (text.startsWith('-')) return '';
  text = firstPronunciation(text);
  for (const [pattern, value] of PHONETIC_CHARS) text = text.replace(pattern, value);
  // 词首/词中的 `.` `,` 都是次重音
  text = text.replace(/[,.]/g, '\u02cc');
  text = text
    .replace(/\s+/g, ' ')
    .replace(/^[\u02cc\u02c8]+$/, '') // 只剩重音符号（`/./`）等于没有
    .replace(/[-\u02cc]+$/, '')
    .trim();
  return text ? `/${text}/` : '';
}

/** 屏幕宽度：汉字算 2，ASCII 算 1。
 * 提示页 26px 折两行、朗读页 18px 单行，最紧的是单行 360px ≈ 20 个汉字，取 34 留余量。 */
function displayWidth(text) {
  let width = 0;
  for (const char of text) width += char.codePointAt(0) > 0x2e80 ? 2 : 1;
  return width;
}

const ELLIPSIS = '\u2026';

/** 屏幕能放下的义项：宁可少一个义项，也不要在词中间切断（`把...重；比...重要；…` 这种） */
function fitSenses(senses, maxWidth) {
  let out = '';
  for (const sense of senses) {
    const candidate = out ? `${out}；${sense}` : sense;
    if (displayWidth(candidate) <= maxWidth) {
      out = candidate;
      continue;
    }
    if (!out) {
      // 括号里多是修饰语（`（就重大政治或社会问题进行的）公民投票`），
      // 直接硬截会把核心词切掉，先把括号剥了再量一次
      const stripped = sense.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
      if (stripped && displayWidth(stripped) <= maxWidth) {
        out = stripped;
      } else {
        let head = '';
        for (const char of sense) {
          if (displayWidth(head + char) > maxWidth - 1) break;
          head += char;
        }
        out = `${head}${ELLIPSIS}`;
      }
    }
    break;
  }
  return out;
}

/** ECDICT 的 translation 用 `\n` 分多行（一行一个词性，CSV 里是字面量反斜杠 n），
 *  这里压成一行、最多三个义项、按屏幕宽度截断 */
export function condense(translation, maxWidth = 34) {
  const lines = String(translation)
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  // [计] / [医] / [化] 这类专业义项放后面；实在只剩专业义项就仍然用它
  const general = lines.filter((line) => !/[[【〔][^\]】〕]{1,4}[\]】〕]/.test(line.slice(0, 8)));
  const primary = (general[0] ?? lines[0]).replace(/\.{2,}/g, ELLIPSIS);
  const senses = primary
    .split(/[;,；，]/)
    .map((part) => part.trim())
    .filter(Boolean)
    // 同一行里也可能混着专业义项，保留第一个，后面的专业标注丢掉
    .filter((part, index) => index === 0 || !/^[[【〔][^\]】〕]{1,4}[\]】〕]/.test(part))
    .slice(0, 3);
  return fitSenses(senses, maxWidth);
}

const WORD_RE = /^[a-z][a-z'-]{1,23}$/;

/** 流式 CSV：ECDICT 的字段有引号包裹且内部含换行，必须按状态机解析 */
function createCsvParser(onRow) {
  let inQuotes = false;
  let field = '';
  let fields = [];
  let quotePending = false;

  return {
    push(text) {
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inQuotes) {
          if (quotePending) {
            quotePending = false;
            if (char === '"') {
              field += '"';
              continue;
            }
            inQuotes = false;
            // 引号闭合后重新处理当前字符
            i--;
            continue;
          }
          if (char === '"') quotePending = true;
          else field += char;
          continue;
        }
        if (char === '"') inQuotes = true;
        else if (char === ',') {
          fields.push(field);
          field = '';
        } else if (char === '\n') {
          fields.push(field);
          onRow(fields);
          fields = [];
          field = '';
        } else if (char !== '\r') field += char;
      }
    },
    end() {
      if (field || fields.length) {
        fields.push(field);
        onRow(fields);
        fields = [];
        field = '';
      }
    },
  };
}

/** 读一份「精选词表」（qwerty-learner 的 dict 格式：[{name, trans[], ukphone, usphone}]）。
 *  这是可选的补充源：没显式指定又恰好没有这个文件时只警告，不退出——
 *  ECDICT 单靠 ielts 标签只有 4 千多词，词书会短一些，但仍然可用。 */
function loadExtra(file, { required }) {
  const map = new Map();
  if (!file) return map;
  if (!fs.existsSync(file)) {
    const hint = `下载：curl -L -o ${path.relative(ROOT, file)} https://raw.githubusercontent.com/Kaiyiwing/qwerty-learner/master/public/dicts/IELTS_3_T.json`;
    if (required) {
      console.error(`找不到补充词表 ${file}（--extra 指定）。\n${hint}`);
      process.exit(1);
    }
    console.warn(`没有补充词表 ${path.relative(ROOT, file)}，只用 ECDICT 的词条（数量可能不足 ${LIMIT}）。\n  ${hint}`);
    return map;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`补充词表 ${file} 不是合法 JSON：${err.message}`);
    console.error('文件可能是下载失败的错误页，删掉重下即可。');
    process.exit(1);
  }
  const list = Array.isArray(raw) ? raw : raw.data ?? [];
  for (const item of list) {
    const word = String(item.name ?? item.word ?? '').trim().toLowerCase();
    if (!WORD_RE.test(word) || map.has(word)) continue;
    const trans = Array.isArray(item.trans) ? item.trans.join('；') : String(item.trans ?? item.translation ?? '');
    const meaning = condense(trans);
    if (!meaning) continue;
    map.set(word, { meaning, phonetic: normalizePhonetic(item.ukphone ?? item.usphone ?? item.phonetic) });
  }
  return map;
}

/** 「recycled: 回收利用( recycle的过去式…)」「walls: 墙壁（wall的复数）」这类词条的释义
 *  写的是**另一个词**（原形）的信息，对拼写练习没有价值；`dispiriting` 甚至直接抄成了
 *  `dispirited 的过去分词`。整条收掉，缺口由共考词池按词频补。 */
const INFLECTION_RE = /的(过去式|过去分词|现在分词|复数|比较级|最高级)/;

/** 就地过滤纯屈折词条 */
function dropInflections(pool) {
  let dropped = 0;
  for (const [word, entry] of pool) {
    if (!INFLECTION_RE.test(entry.meaning)) continue;
    pool.delete(word);
    dropped++;
  }
  return dropped;
}

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`找不到词典文件 ${INPUT}`);
    console.error('先下载：curl -L -o .cache/ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv');
    process.exit(1);
  }
  const extra = loadExtra(EXTRA, { required: EXTRA_GIVEN });

  const ieltsPool = new Map();
  const fillPool = new Map();
  let scanned = 0;
  let tagged = 0;
  let fromExtra = 0;

  const parser = createCsvParser((row) => {
    const [word, phonetic, , translation, , collins, oxford, tag, bnc, frq] = row;
    scanned++;
    if (scanned === 1 && word === 'word') return; // 表头

    const text = String(word ?? '').trim();
    if (!text || text !== text.toLowerCase()) return; // 专有名词、缩写一律跳过
    if (!WORD_RE.test(text)) return; // 词组、含数字或空格的不进词书（拼写练习没法用）
    if (ieltsPool.has(text) || fillPool.has(text)) return;

    const tagText = String(tag ?? '');
    const isIelts = /\bielts\b/.test(tagText);
    const isFill = !isIelts && FILL_RE !== null && FILL_RE.test(tagText);
    const extraEntry = extra.get(text);
    if (!isIelts && !isFill && !extraEntry) return;
    if (isIelts) tagged++;

    const meaning = condense(translation) || extraEntry?.meaning || '';
    if (!meaning) return;
    if (/^abbr/i.test(meaning)) return; // 缩写（phd 这种）不适合做拼写练习

    const f = Number(frq) || 0;
    const b = Number(bnc) || 0;
    const c = Number(collins) || 0;
    const o = Number(oxford) || 0;
    // 没有任何词频与词典标注的词基本是地名/生僻缩写（wollongong 这种），不进词书
    if (!f && !b && !c && !o) return;

    const rank = f > 0
      ? f
      : b > 0
        ? 500000 + b
        // 两套词频都缺的词：按柯林斯星级与牛津核心词分层，避免生僻词和无词频的常用词混在一起
        : 900000 + (5 - Math.min(c, 5)) * 10000 + (o ? 0 : 5000);
    // the / in / on 这类超基础词不在雅思词书里（默认阈值 0 = 不排除）
    if (rank < BASE_RANK) return;

    const entry = {
      word: text,
      phonetic: normalizePhonetic(phonetic) || extraEntry?.phonetic || '',
      meaning,
      rank,
    };
    if (isIelts || (extraEntry && !isFill)) {
      if (extraEntry) fromExtra++;
      ieltsPool.set(text, entry);
    } else {
      fillPool.set(text, entry);
    }
  });

  const stream = fs.createReadStream(INPUT);
  for await (const chunk of stream) parser.push(chunk.toString('utf8'));
  parser.end();

  // 精选词表里有、但词典里查不到的极少几个词，仍然补进来（排在末尾）
  for (const [word, entry] of extra) {
    if (!ieltsPool.has(word) && !fillPool.has(word)) ieltsPool.set(word, { word, rank: 9e9, ...entry });
  }

  const dropped = dropInflections(ieltsPool) + dropInflections(fillPool);

  const byRank = (a, b) => a.rank - b.rank || a.word.localeCompare(b.word);
  const primary = [...ieltsPool.values()].sort(byRank);
  const words = primary.slice(0, LIMIT);
  // 雅思标注词不够时，用雅思/托福共考词按词频补足
  if (words.length < LIMIT && fillPool.size) {
    const taken = new Set(words.map((entry) => entry.word));
    const filler = [...fillPool.values()]
      .filter((entry) => !taken.has(entry.word))
      .sort(byRank)
      .slice(0, LIMIT - words.length);
    words.push(...filler);
    words.sort(byRank);
  }
  const short = words.length < LIMIT;

  const payload = {
    id: 'ielts',
    name: `雅思 ${words.length} 词`,
    source: [
      'ECDICT (skywind3000/ECDICT, MIT) 的 tag=ielts 词条',
      EXTRA ? 'qwerty-learner 雅思核心词表（IELTS_3_T）' : null,
      FILL_TAGS.length ? `不足部分用 tag=${FILL_TAGS.join('/')} 的共考词按词频补足` : null,
      '按当代语料库词频排序，剔除无标注专名',
    ].filter(Boolean).join('；'),
    builtAt: new Date().toISOString().slice(0, 10),
    unitSize: UNIT_SIZE,
    unitLabel: 'List',
    // [单词, 音标, 释义]；数组比对象省一半体积
    words: words.map((entry) => [entry.word, entry.phonetic, entry.meaning]),
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload)}\n`, 'utf8');

  const noPhonetic = words.filter((entry) => !entry.phonetic).length;
  const size = fs.statSync(OUT_FILE).size;
  console.log(`解析 ${scanned} 行：tag=ielts 可用 ${ieltsPool.size} 个（补充词表命中 ${fromExtra} 个），共考补充池 ${fillPool.size} 个，剔除屈折词条 ${dropped} 个`);
  if (short) console.warn(`可用词只有 ${words.length} 个，不足 ${LIMIT}`);
  console.log(`取前 ${words.length} 词 → ${path.relative(ROOT, OUT_FILE)}（${(size / 1024).toFixed(0)} KB，${Math.ceil(words.length / UNIT_SIZE)} 个单元，${noPhonetic} 词无音标）`);
  console.log('前 5 个：', words.slice(0, 5).map((entry) => entry.word).join(', '));
  console.log('后 5 个：', words.slice(-5).map((entry) => entry.word).join(', '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
