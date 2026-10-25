// 今天吃什么：一个纯娱乐应用。
// 网页点「换一个」，或者在设备上按确认键，都会随机换一道菜并推到墨水屏。
//
// 它是一个「无状态也可以玩」的应用：设备没配好时，网页仍能换菜、看预览；
// 推送失败只提示，不阻塞换菜本身。

import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureFont } from '../shared/canvas.js';
import { httpStatusOf } from '../../src/errors.js';
import { formatFor } from '../../src/image.js';
import { DISHES, categoryStats, pickNext } from './dishes.js';
import { renderDish } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 设备按键是全局事件，所有应用都会收到。这个应用只在网页「接管」期间响应确认键，
// 否则用背单词时按确认也会顺手把菜换了（页面关掉后租约自然过期）。
const KEY_LEASE_MS = 2 * 60 * 1000;

export default {
  id: 'what-to-eat',
  name: '今天吃什么',
  description: '按一下确认键换一道菜，专治每天的选择困难',

  create(ctx) {
    ensureFont({ fontsDir: ctx.fontsDir });

    const random = ctx.random ?? Math.random;
    const state = {
      dish: pickNext(DISHES, null, random),
      rolls: 0,
      activeUntil: 0,
      lastPush: null,
      lastError: null,
    };
    let chain = Promise.resolve();
    const unsubscribers = [];

    /** 与背单词一致：所有「换菜 → 推图」串成一条链，避免两张图交错上传 */
    function run(task) {
      const next = chain.then(task);
      chain = next.then(
        () => {},
        (err) => {
          state.lastError = String(err?.message || err);
          ctx.log(`今天吃什么：${state.lastError}`);
        },
      );
      return next;
    }

    function currentPng() {
      return renderDish(state.dish, { rolls: state.rolls, total: DISHES.length });
    }

    /** 网页是否接管了设备确认键（按键是全局事件，必须明确归属） */
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

    /**
     * 换一道并（可选）推送到设备。
     * 推送失败不是硬错误：菜已经换了，返回 pushed=false 与 error 交给页面提示。
     */
    async function roll({ pushToDevice = true, trigger = 'manual' } = {}) {
      const previous = state.dish;
      state.dish = pickNext(DISHES, previous?.name, random);
      state.rolls += 1;
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
      ctx.log(`今天吃什么：${previous?.name ?? '—'} → ${state.dish.name}`
        + `${pushed ? '（已推送）' : error ? `（未推送：${error}）` : ''}`);
      return {
        dish: state.dish,
        previous: previous?.name ?? null,
        pushed,
        error,
        trigger,
      };
    }

    // 设备确认键：只有在网页接管期间，每按一次才换一道
    unsubscribers.push(ctx.on('event', (event) => {
      if (event.type === 'key' && event.key === 'confirm' && isActive()) {
        run(() => roll({ trigger: 'key' })).catch(() => {});
      }
    }));

    const router = express.Router();

    router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

    router.get('/api/state', (req, res) => {
      res.json({
        ok: true,
        dish: state.dish,
        rolls: state.rolls,
        total: DISHES.length,
        categories: categoryStats(),
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

    router.post('/api/roll', async (req, res) => {
      try {
        const result = await run(() => roll({
          pushToDevice: req.body?.push !== false,
          trigger: 'manual',
        }));
        res.json({
          ok: true,
          ...result,
          rolls: state.rolls,
          total: DISHES.length,
          lastError: state.lastError,
        });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.post('/api/push', async (req, res) => {
      try {
        const lastPush = await run(() => pushCurrent());
        res.json({ ok: true, lastPush, dish: state.dish });
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
        ctx.log(`今天吃什么已就绪：${DISHES.length} 道候选，当前「${state.dish.name}」`);
      },
      stop() {
        for (const off of unsubscribers.splice(0)) {
          try { off(); } catch { /* 已解绑 */ }
        }
      },
      status() {
        return {
          dish: state.dish,
          rolls: state.rolls,
          active: isActive(),
          lastPush: state.lastPush,
          lastError: state.lastError,
        };
      },
      router,
      roll,
      pushCurrent,
    };
  },
};

export { pickNext, DISHES };
