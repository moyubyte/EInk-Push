// 背单词应用：词库管理 + 拼写/翻卡练习 + SM-2 复习计划，交互走设备的按键与录音上链路。
//
// 参考实现：https://github.com/itopinion/zectrix-vocabulary
//
// 实现说明：
//   - 用 canvas 画 400×300，按键走协议 KEY 消息。
//   - 语音：TTS 与 ASR 由服务层的通用语音服务提供（ctx.speech，配置在首页），
//     本应用只负责调用；配了 ASR 才启用「拼字母」阶段，
//     否则自动降级为翻卡模式，功能闭环仍然完整。
//   - 复习间隔用公开的 SM-2。

import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureFont, getFontChoice, getFontOptions } from '../shared/canvas.js';
import { httpStatusOf } from '../../src/errors.js';
import { formatFor } from '../../src/image.js';
import { Library } from './library.js';
import { StudySession, PHASE, MODE } from './session.js';
import { gradeSpelling } from './quiz.js';
import { review, isDue, describeInterval, todayIso } from './srs.js';
import { hasSpeech } from '../../src/speech.js';
import { renderCard, renderMessage } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
  textbookId: 'ielts',
  unitId: null,
  limit: 10,
  mode: 'auto', // auto | flashcard | spelling
  order: 'due', // due | random | order
  volume: 70,
  pushToDevice: true,
};

export default {
  id: 'vocabulary',
  name: '背单词',
  description: '内置雅思 6000 词，拼写/翻卡练习 + SM-2 复习计划，按键与录音直接驱动',

  create(ctx) {
    const dataDir = path.join(ctx.dataDir, 'vocabulary');
    const configFile = path.join(dataDir, 'config.json');
    ensureFont({ fontsDir: ctx.fontsDir });

    const library = new Library(dataDir, { log: (message) => ctx.log(`背单词: ${message}`) });
    const state = {
      config: { ...DEFAULT_CONFIG },
      loaded: false,
      session: null,
      lastError: null,
      lastCard: null,
    };
    // TTS/ASR 是服务层的全局能力，应用只消费，不再自己持有语音配置
    const speech = ctx.speech;
    let chain = Promise.resolve();
    // 每开始一轮就把整组发音预合成进语音服务缓存，设备上按键可直接出声
    let prefetchToken = 0;
    const unsubscribers = [];

    const router = express.Router();
    router.use(express.json({ limit: '256kb' }));

    /** 设备交互串行化：按键/录音/HTTP 都能触发推图，避免多张图交错上传 */
    function run(task) {
      chain = chain.then(task).catch((err) => {
        state.lastError = String(err?.message || err);
        ctx.log(`背单词: ${state.lastError}`);
      });
      return chain;
    }

    async function loadConfig() {
      if (state.loaded) return state.config;
      try {
        const raw = JSON.parse(await fs.readFile(configFile, 'utf8'));
        state.config = { ...DEFAULT_CONFIG, ...raw };
      } catch {
        state.config = { ...DEFAULT_CONFIG };
      }
      state.loaded = true;
      await library.load();
      // 词书被替换（例如演示词表升级成雅思词书）后，旧配置里的 id 会失效
      if (reconcileTarget()) await writeConfig(state.config);
      return state.config;
    }

    /** 配置里的教材/单元若已不存在，退回第一本教材，避免「开始练习」报「没有单词」这种误导性错误 */
    function reconcileTarget() {
      const textbooks = library.textbooks();
      if (!textbooks.length) return false;
      const stale = state.config.textbookId;
      const textbook = textbooks.find((item) => item.id === stale) ?? textbooks[0];
      let changed = false;
      if (textbook.id !== stale) {
        state.config = { ...state.config, textbookId: textbook.id, unitId: null };
        changed = true;
        ctx.log(`背单词：词书 ${stale} 已不存在，改用「${textbook.name}」`);
      }
      if (state.config.unitId && !textbook.units.some((unit) => unit.id === state.config.unitId)) {
        state.config = { ...state.config, unitId: null };
        changed = true;
      }
      return changed;
    }

    async function writeConfig(next) {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(configFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
      state.config = next;
      state.loaded = true;
    }

    async function saveConfig(next) {
      await writeConfig(next);
    }

    function effectiveMode() {
      if (state.config.mode === MODE.SPELLING) return speech.asrReady ? MODE.SPELLING : MODE.FLASHCARD;
      if (state.config.mode === MODE.FLASHCARD) return MODE.FLASHCARD;
      return speech.asrReady ? MODE.SPELLING : MODE.FLASHCARD;
    }

    /** 答案页展示的「下次复习」：按当前自评预测，未评分按「记得」算 */
    function nextReviewText() {
      const session = state.session;
      if (!session?.current) return null;
      const progress = library.getProgress(session.current.word);
      return describeInterval(review(progress, session.pendingGrade ?? 2));
    }

    async function buildPng() {
      if (!state.session) throw new Error('还没有开始练习');
      const view = { ...state.session.view(), nextReview: nextReviewText() };
      const png = renderCard(view);
      state.lastCard = { png, view, at: Date.now() };
      return png;
    }

    async function pushCurrent({ force = false } = {}) {
      // 非强制（应用内部触发）时会话已被收尾就别再推图：
      // 否则排队中的旧任务会把「还没有开始练习」的占位图推上去，盖掉别的应用刚下的画面
      if (!force && !state.session) return;
      const png = state.session
        ? await buildPng()
        : renderMessage('背单词', '还没有开始练习。在网页上选择范围后开始，设备会显示第一个词。');
      if (!force && !state.config.pushToDevice) return;
      const client = await ctx.getClient();
      await client.show(png, formatFor(client));
    }

    async function speak(text) {
      const pcm = await speech.synthesize(text);
      if (!pcm) {
        state.lastError = '发音合成失败：检查首页「语音服务」能否访问 Edge TTS';
        return false;
      }
      const client = await ctx.getClient();
      await client.play(pcm, state.config.volume);
      state.lastError = null;
      return true;
    }

    /**
     * 整组预生成发音：并行两条通道逐词合成，结果落进语音服务缓存，
     * 之后设备上单击上键就能立即播放。失败只记日志，不影响练习流程。
     */
    async function prefetchVoices(session) {
      if (!speech.ttsReady || !session?.words?.length) return;
      const token = ++prefetchToken;
      const words = session.words.map((item) => item.word).filter(Boolean);
      if (!words.length) return;
      let cursor = 0;
      let failed = 0;
      const worker = async () => {
        while (cursor < words.length && token === prefetchToken) {
          const word = words[cursor++];
          let pcm = null;
          try {
            pcm = await speech.synthesize(word);
          } catch (err) {
            ctx.log(`背单词: 预生成发音异常（${word}）：${String(err?.message || err)}`);
          }
          if (!pcm) failed += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, words.length) }, worker));
      if (token !== prefetchToken) return;
      ctx.log(failed
        ? `背单词: 整组发音预生成完成 ${words.length - failed}/${words.length}，${failed} 个失败`
        : `背单词: 整组发音已预生成（${words.length} 个词）`);
    }

    /** 成绩写入复习计划 */
    async function persistRecord(record) {
      if (!record || record.skipped || record.grade === null) return;
      const prev = library.getProgress(record.word);
      library.setProgress(record.word, review(prev, record.grade));
      await library.saveProgress();
    }

    async function finishCommit() {
      const session = state.session;
      if (!session) return null;
      const record = session.records.at(-1);
      await persistRecord(record);
      const view = session.view();
      if (view.phase === PHASE.DONE) {
        ctx.log(`背单词本轮结束：${view.counts.correct} 对 / ${view.counts.wrong} 错 / ${view.counts.skipped} 跳`);
      }
      return view;
    }

    // ---- 设备事件 ----
    unsubscribers.push(ctx.on('event', (event) => {
      if (event.type === 'key') run(() => handleKey(event));
      else if (event.type === 'recordingFinished') run(() => handleRecording(event.audio, event.reason));
    }));

    async function handleKey({ key, action }) {
      const session = state.session;
      if (!session || session.done) return;

      if (key === 'confirm' && action === 'long') {
        await speak(session.current?.word ?? '');
        return;
      }

      if (key === 'confirm') {
        if (session.phase === PHASE.PROMPT) {
          // 拼写模式：没 ASR 无法判分，直接看答案且不计分
          session.reveal(session.mode === MODE.FLASHCARD ? 2 : null);
        } else if (session.phase === PHASE.SPELLING || session.phase === PHASE.WORD) {
          session.reveal(null);
        } else if (session.phase === PHASE.ANSWER) {
          session.commit();
          await finishCommit();
        }
        await pushCurrent();
        return;
      }

      if (key === 'down') {
        if (session.phase === PHASE.ANSWER) {
          session.markGrade(0);
          session.commit();
          await finishCommit();
        } else {
          session.skip();
        }
        await pushCurrent();
        return;
      }

      // 上键单击：听当前单词（整组发音在开始时就已预生成，命中缓存立即播放）
      // 拼写模式在揭晓答案前不放音，避免把要拼的单词直接念出来
      if (key === 'up' && action === 'short') {
        const hidden = session.mode === MODE.SPELLING
          && (session.phase === PHASE.PROMPT || session.phase === PHASE.SPELLING);
        if (!hidden) await speak(session.current?.word ?? '');
      }
    }

    async function handleRecording(audio, reason) {
      const session = state.session;
      if (!session || session.done) return;
      if (session.phase !== PHASE.PROMPT || session.mode !== MODE.SPELLING) return;
      if (!audio || audio.length === 0) return;
      if (!hasSpeech(audio)) {
        state.lastError = '录音是静音，未做判定';
        return;
      }

      session.startSpelling();
      await pushCurrent();

      const text = await speech.recognize(audio);
      const expected = session.current?.word ?? '';
      const result = text
        ? gradeSpelling(text, expected)
        : { correct: false, near: false, empty: true, distance: expected.length, got: '', expected };
      session.submitSpelling(result);
      await pushCurrent();
    }

    // ---- 接口 ----
    router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

    router.get('/api/config', async (req, res) => {
      const config = await loadConfig();
      const fontKey = getFontChoice();
      const font = getFontOptions().find((item) => item.key === fontKey);
      res.json({
        ok: true,
        config,
        mode: effectiveMode(),
        asrReady: speech.asrReady,
        ttsReady: speech.ttsReady,
        speechVoice: speech.voice,
        // 设备图字体是全局设置（首页「设备」里切换），这里只上报当前值供页面显示
        deviceFont: { key: fontKey, name: font?.name ?? fontKey },
        lastError: state.lastError,
      });
    });

    router.put('/api/config', async (req, res) => {
      const current = await loadConfig();
      const body = req.body ?? {};
      const next = { ...current };
      const num = (value, name, min, max) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 应为 ${min}～${max} 的整数`);
        return n;
      };
      try {
        if (body.textbookId !== undefined) next.textbookId = String(body.textbookId);
        if (body.unitId !== undefined) next.unitId = body.unitId ? String(body.unitId) : null;
        if (body.limit !== undefined) next.limit = num(body.limit, '每轮词数', 1, 200);
        if (body.volume !== undefined) next.volume = num(body.volume, '音量', 0, 100);
        if (body.mode !== undefined) {
          if (!['auto', MODE.FLASHCARD, MODE.SPELLING].includes(body.mode)) throw new Error('mode 应为 auto、flashcard 或 spelling');
          next.mode = body.mode;
        }
        if (body.order !== undefined) {
          if (!['due', 'random', 'order'].includes(body.order)) throw new Error('order 应为 due、random 或 order');
          next.order = body.order;
        }
        if (body.pushToDevice !== undefined) next.pushToDevice = Boolean(body.pushToDevice);
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }
      await saveConfig(next);
      res.json({ ok: true, config: next, mode: effectiveMode(), asrReady: speech.asrReady, ttsReady: speech.ttsReady });
    });

    router.get('/api/library', async (req, res) => {
      await library.load();
      const textbooks = library.textbooks();
      const all = library.words();
      res.json({
        ok: true,
        textbooks,
        stats: {
          total: all.length,
          due: all.filter((item) => isDue(item.progress)).length,
          learned: all.filter((item) => item.progress).length,
          today: todayIso(),
        },
      });
    });

    router.get('/api/library/words', async (req, res) => {
      await library.load();
      const { textbookId, unitId } = req.query;
      const all = library.words({ textbookId, unitId });
      // 雅思词书有 6000 词，一次全吐给页面渲染会卡；页面按单元取，limit/offset 只是兜底
      const limit = Number(req.query.limit);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const words = Number.isFinite(limit) && limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset);
      res.json({ ok: true, total: all.length, words });
    });

    router.post('/api/library/textbooks', async (req, res) => {
      await library.load();
      try {
        const textbook = library.addTextbook(req.body?.name);
        await library.saveLibrary();
        res.json({ ok: true, textbook });
      } catch (err) {
        res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.post('/api/library/units', async (req, res) => {
      await library.load();
      try {
        const unit = library.addUnit(req.body?.textbookId, req.body?.name);
        await library.saveLibrary();
        res.json({ ok: true, unit });
      } catch (err) {
        res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.post('/api/library/words', async (req, res) => {
      await library.load();
      try {
        const { textbookId, unitId, word, meaning, phonetic } = req.body ?? {};
        const entry = library.addWord(textbookId, unitId, { word, meaning, phonetic });
        await library.saveLibrary();
        res.json({ ok: true, word: entry });
      } catch (err) {
        res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.delete('/api/library/words', async (req, res) => {
      await library.load();
      try {
        const { textbookId, unitId, word } = req.query;
        const removed = library.removeWord(textbookId, unitId, word);
        await library.saveLibrary();
        res.json({ ok: true, removed });
      } catch (err) {
        res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.post('/api/library/import', async (req, res) => {
      await library.load();
      try {
        const { textbookId, unitId, text } = req.body ?? {};
        const result = library.importWords(textbookId, unitId, text);
        await library.saveLibrary();
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(400).json({ ok: false, error: String(err.message || err) });
      }
    });

    /** 开始新一轮：默认只取到期的词，不够再补新词 */
    router.post('/api/session', async (req, res) => {
      await library.load();
      const config = await loadConfig();
      const body = req.body ?? {};
      const textbookId = body.textbookId ?? config.textbookId;
      const unitId = body.unitId ?? config.unitId;
      const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : config.limit;
      try {
        const words = library.words({ textbookId, unitId });
        if (!words.length) {
          const missing = textbookId && !library.findTextbook(textbookId);
          return res.status(400).json({
            ok: false,
            error: missing
              ? `词书 ${textbookId} 不存在（可能已被替换），请在页面上重新选择`
              : '这个范围内没有单词，请先添加或导入词表',
          });
        }
        const order = body.order ?? config.order;
        const queue = orderQueue(words, order);
        state.session = new StudySession({
          words: queue,
          limit,
          mode: effectiveMode(),
          textbookName: words[0].textbookName,
          unitName: unitId ? words[0].unitName : '',
        });
        // 预生成不阻塞出图与响应，失败只记日志
        prefetchVoices(state.session).catch((err) => {
          ctx.log(`背单词: 预生成发音失败：${String(err?.message || err)}`);
        });
        await run(() => pushCurrent());
        res.json({ ok: true, view: state.session.view() });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.get('/api/session', (req, res) => {
      res.json({ ok: true, view: state.session ? { ...state.session.view(), nextReview: nextReviewText() } : null });
    });

    router.post('/api/session/answer', async (req, res) => {
      if (!state.session) return res.status(409).json({ ok: false, error: '还没有开始练习' });
      state.session.reveal(req.body?.grade ?? null);
      await run(() => pushCurrent());
      res.json({ ok: true, view: state.session.view() });
    });

    router.post('/api/session/next', async (req, res) => {
      if (!state.session) return res.status(409).json({ ok: false, error: '还没有开始练习' });
      if (req.body?.grade !== undefined) state.session.markGrade(req.body.grade);
      state.session.commit();
      await finishCommit();
      await run(() => pushCurrent());
      res.json({ ok: true, view: state.session.view(), summary: state.session.done ? state.session.summary() : null });
    });

    router.post('/api/session/stop', async (req, res) => {
      if (!state.session) return res.status(409).json({ ok: false, error: '还没有开始练习' });
      prefetchToken += 1; // 结束本轮就不再继续预生成
      const summary = state.session.summary();
      state.session = null;
      res.json({ ok: true, summary });
    });

    router.get('/api/preview.png', async (req, res) => {
      try {
        if (!state.session) {
          res.set('Content-Type', 'image/png').send(renderMessage('背单词', '还没有开始练习。在网页上选择范围后开始，设备会显示第一个词。'));
          return;
        }
        const png = await buildPng();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(png);
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    return {
      async start() {
        await library.load();
        await loadConfig();
        const stats = library.textbooks();
        const count = stats.reduce((total, textbook) => total + textbook.count, 0);
        ctx.log(`背单词应用已就绪：${count} 个词，模式=${effectiveMode()}${speech.asrReady ? '' : '（未配置 ASR，拼写练习不可用）'}`);
      },
      stop() {
        prefetchToken += 1;
        for (const off of unsubscribers.splice(0)) {
          try { off(); } catch { /* 已解绑 */ }
        }
        state.session = null;
      },
      status() {
        return {
          mode: effectiveMode(),
          asrReady: speech.asrReady,
          ttsReady: speech.ttsReady,
          session: state.session ? state.session.view() : null,
          lastError: state.lastError,
        };
      },
      router,
      // 作答期间上键听发音、下键评分/跳过，此时不能被全局应用切换抢走
      blocksAppSwitch: () => Boolean(state.session && !state.session.done),
      // 其他应用已向设备推图：屏幕不再属于背单词，立刻结束本轮，
      // 否则设备按确认键又会把背单词的卡片推上去，画面在两个应用之间来回跳
      onScreenTaken(appId) {
        if (!state.session || state.session.done) return;
        prefetchToken += 1; // 停掉还在跑的整组发音预生成
        state.session = null;
        ctx.log(`背单词：${appId} 已向设备推送画面，自动结束本轮练习`);
      },
      pushCurrent,
      library,
      get session() { return state.session; },
    };
  },
};

/** 排队顺序：到期的优先（按到期日），再补没学过的新词；random 打乱 */
export function orderQueue(words, order = 'due') {
  const list = words.slice();
  if (order === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
  if (order === 'order') return list;
  const dueWords = list.filter((item) => isDue(item.progress));
  const future = list
    .filter((item) => !isDue(item.progress))
    .sort((a, b) => String(a.progress?.due).localeCompare(String(b.progress?.due)));
  return [...dueWords, ...future];
}

export { DEFAULT_CONFIG };
