// 人生指南：把《高性价比人生指南》(HowToLiveBetter) 的 767 条循证建议
// 一条一张 400×300 卡片推给墨水屏。
//
// 和「今天吃什么」一样采用按键租约：只有网页打开期间，设备确认键才归本应用，
// 关掉页面 2 分钟后自动交还，避免影响背单词等需要按确认键的应用。
//
// 内容许可是 CC BY 4.0：卡片与页面都保留来源署名，不做改写。

import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureFont } from '../shared/canvas.js';
import { httpStatusOf } from '../../src/errors.js';
import { formatFor } from '../../src/image.js';
import {
  CHAPTERS, ENTRIES, META, evidenceStats, filterEntries, pickIndex, dailyOffset,
} from './entries.js';
import { renderEntry } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KEY_LEASE_MS = 2 * 60 * 1000;

export default {
  id: 'life-guide',
  name: '人生指南',
  description: '767 条循证生活建议，一条一张卡片，按键翻下一条',

  create(ctx) {
    ensureFont({ fontsDir: ctx.fontsDir });

    const random = ctx.random ?? Math.random;
    const state = {
      chapter: 'all',
      evidence: 'all',
      pool: ENTRIES,
      index: 0,
      turns: 0,
      activeUntil: 0,
      lastPush: null,
      lastError: null,
    };
    state.index = dailyOffset() % state.pool.length;

    let chain = Promise.resolve();
    const unsubscribers = [];

    /** 与背单词/吃什么一致：所有「翻条 → 推图」串行执行，避免图片交错上传 */
    function run(task) {
      const next = chain.then(task);
      chain = next.then(
        () => {},
        (err) => {
          state.lastError = String(err?.message || err);
          ctx.log(`人生指南：${state.lastError}`);
        },
      );
      return next;
    }

    function currentEntry() {
      return state.pool[state.index] ?? null;
    }

    function currentPng() {
      return renderEntry(currentEntry(), {
        position: state.index + 1,
        total: state.pool.length,
      });
    }

    function isActive() {
      return state.activeUntil > Date.now();
    }

    async function pushCurrent() {
      const png = currentPng();
      const client = await ctx.getClient();
      const started = Date.now();
      await client.show(png, formatFor(client));
      state.lastPush = { at: new Date().toISOString(), ms: Date.now() - started };
      state.lastError = null;
      return state.lastPush;
    }

    /** 换到下一条（顺序或随机），推送失败不算硬错误，只把原因带回页面 */
    async function advance({ shuffle = false, pushToDevice = true, trigger = 'manual' } = {}) {
      const previous = currentEntry();
      if (shuffle) state.index = pickIndex(state.pool, state.index, random);
      else state.index = (state.index + 1) % state.pool.length;
      state.turns += 1;

      let pushed = false;
      let error = null;
      if (pushToDevice) {
        try {
          await pushCurrent();
          pushed = true;
        } catch (err) {
          error = String(err?.message || err);
          state.lastError = error;
        }
      }
      const entry = currentEntry();
      ctx.log(`人生指南：${previous?.key ?? '—'} → ${entry?.key ?? '—'}`
        + `（${entry?.title ?? '无'}）${pushed ? '已推送' : error ? `未推送：${error}` : ''}`);
      return { entry, previous: previous?.key ?? null, pushed, error, trigger };
    }

    /** 切换筛选：章节 / 证据等级，池子变化后回到当天的位置 */
    function setFilter({ chapter, evidence } = {}) {
      const nextChapter = chapter === 'all' || CHAPTERS.some((item) => item.no === chapter)
        ? chapter
        : state.chapter;
      const nextEvidence = evidence === 'all' || ['A', 'B', 'C'].includes(evidence)
        ? evidence
        : state.evidence;
      const pool = filterEntries({ chapter: nextChapter, evidence: nextEvidence });
      state.chapter = nextChapter;
      state.evidence = nextEvidence;
      state.pool = pool.length ? pool : ENTRIES;
      state.index = pool.length ? dailyOffset() % pool.length : 0;
      ctx.log(`人生指南：筛选章节=${nextChapter} 证据=${nextEvidence}，共 ${state.pool.length} 条`);
      return state;
    }

    // 设备确认键：网页接管期间，按一次翻下一条
    unsubscribers.push(ctx.on('event', (event) => {
      if (event.type === 'key' && event.key === 'confirm' && isActive()) {
        run(() => advance({ trigger: 'key' })).catch(() => {});
      }
    }));

    const router = express.Router();

    router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

    router.get('/api/state', (req, res) => {
      res.json({
        ok: true,
        entry: currentEntry(),
        position: state.index + 1,
        total: state.pool.length,
        allTotal: ENTRIES.length,
        filters: { chapter: state.chapter, evidence: state.evidence },
        chapters: CHAPTERS,
        evidenceOptions: evidenceStats(),
        meta: META,
        turns: state.turns,
        active: isActive(),
        lastPush: state.lastPush,
        lastError: state.lastError,
      });
    });

    /** 网页打开/关闭时调用：接管或交还设备确认键 */
    router.post('/api/arm', (req, res) => {
      const active = req.body?.active !== false;
      state.activeUntil = active ? Date.now() + KEY_LEASE_MS : 0;
      res.json({ ok: true, active });
    });

    router.post('/api/next', async (req, res) => {
      try {
        const result = await run(() => advance({
          shuffle: req.body?.shuffle === true,
          pushToDevice: req.body?.push !== false,
          trigger: 'manual',
        }));
        res.json({
          ok: true,
          ...result,
          position: state.index + 1,
          total: state.pool.length,
          filters: { chapter: state.chapter, evidence: state.evidence },
          turns: state.turns,
          lastError: state.lastError,
        });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.post('/api/filter', (req, res) => {
      setFilter(req.body ?? {});
      res.json({
        ok: true,
        entry: currentEntry(),
        position: state.index + 1,
        total: state.pool.length,
        filters: { chapter: state.chapter, evidence: state.evidence },
      });
    });

    router.post('/api/push', async (req, res) => {
      try {
        const lastPush = await run(() => pushCurrent());
        res.json({ ok: true, lastPush, entry: currentEntry() });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.get('/api/preview.png', (req, res) => {
      try {
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(currentPng());
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    return {
      async start() {
        ctx.log(`人生指南已就绪：${ENTRIES.length} 条建议、${CHAPTERS.length} 个章节（内容 CC BY 4.0）`);
      },
      stop() {
        for (const off of unsubscribers.splice(0)) {
          try { off(); } catch { /* 已解绑 */ }
        }
      },
      status() {
        const entry = currentEntry();
        return {
          entry: entry?.key ?? null,
          title: entry?.title ?? null,
          position: state.index + 1,
          total: state.pool.length,
          filters: { chapter: state.chapter, evidence: state.evidence },
          turns: state.turns,
          active: isActive(),
          lastPush: state.lastPush,
          lastError: state.lastError,
        };
      },
      router,
      advance,
      setFilter,
      pushCurrent,
    };
  },
};

export { ENTRIES, CHAPTERS };
