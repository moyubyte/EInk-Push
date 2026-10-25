// 掷杯筊：一个纯娱乐的占卜应用。
// 网页点「再掷一次」，或者在设备上按确认键，都会掷出一杯并推到墨水屏。
//
// 和设备没配好时网页仍能掷、能看预览；推送失败只提示，不影响掷杯本身。

import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureFont } from '../shared/canvas.js';
import { httpStatusOf } from '../../src/errors.js';
import { formatFor } from '../../src/image.js';
import { throwJiaobei } from './outcomes.js';
import { renderJiaobei } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 设备按键是全局事件。只在网页「接管」期间响应确认键，页面关掉后租约自动过期。
const KEY_LEASE_MS = 2 * 60 * 1000;

export default {
  id: 'jiaobei',
  name: '掷杯筊',
  description: '心中默念所求，按一下确认键掷一杯，看神明如何应答',

  create(ctx) {
    ensureFont({ fontsDir: ctx.fontsDir });

    const random = ctx.random ?? Math.random;
    const state = {
      outcome: null,
      throws: 0,
      activeUntil: 0,
      lastPush: null,
      lastError: null,
    };
    let chain = Promise.resolve();
    const unsubscribers = [];

    /** 与背单词一致：所有「掷杯 → 推图」串成一条链，避免两张图交错上传 */
    function run(task) {
      const next = chain.then(task);
      chain = next.then(
        () => {},
        (err) => {
          state.lastError = String(err?.message || err);
          ctx.log(`掷杯筊：${state.lastError}`);
        },
      );
      return next;
    }

    function currentPng() {
      return renderJiaobei(state.outcome, { throws: state.throws });
    }

    /** 网页是否接管了设备确认键（按键是全局事件，必须明确归属） */
    function isActive() {
      return state.activeUntil > Date.now();
    }

    async function pushCurrent() {
      const png = await currentPng();
      const client = await ctx.getClient();
      const started = Date.now();
      await client.show(png, formatFor(client));
      state.lastPush = { at: new Date().toISOString(), ms: Date.now() - started };
      state.lastError = null;
      return state.lastPush;
    }

    /**
     * 掷一次并（可选）推送到设备。
     * 推送失败不是硬错误：结果已经出来了，返回 pushed=false 与 error 交给页面提示。
     */
    async function throwOnce({ pushToDevice = true, trigger = 'manual' } = {}) {
      const previous = state.outcome;
      state.outcome = throwJiaobei(random);
      state.throws += 1;
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
      ctx.log(`掷杯筊：${previous?.name ?? '—'} → ${state.outcome.name}`
        + `${pushed ? '（已推送）' : error ? `（未推送：${error}）` : ''}`);
      return {
        outcome: state.outcome,
        previous: previous?.name ?? null,
        pushed,
        error,
        trigger,
      };
    }

    // 设备确认键：只有在网页接管期间，每按一次才掷一杯
    unsubscribers.push(ctx.on('event', (event) => {
      if (event.type === 'key' && event.key === 'confirm' && isActive()) {
        run(() => throwOnce({ trigger: 'key' })).catch(() => {});
      }
    }));

    const router = express.Router();

    router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

    router.get('/api/state', (req, res) => {
      res.json({
        ok: true,
        outcome: state.outcome,
        throws: state.throws,
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

    router.post('/api/throw', async (req, res) => {
      try {
        const result = await run(() => throwOnce({
          pushToDevice: req.body?.push !== false,
          trigger: 'manual',
        }));
        res.json({
          ok: true,
          ...result,
          throws: state.throws,
          lastError: state.lastError,
        });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.post('/api/push', async (req, res) => {
      try {
        const lastPush = await run(() => pushCurrent());
        res.json({ ok: true, lastPush, outcome: state.outcome });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.get('/api/preview.png', async (req, res) => {
      try {
        const png = await currentPng();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(png);
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    return {
      async start() {
        ctx.log(`掷杯筊已就绪，当前${state.outcome ? `「${state.outcome.name}」` : '尚未掷杯'}`);
      },
      stop() {
        for (const off of unsubscribers.splice(0)) {
          try { off(); } catch { /* 已解绑 */ }
        }
      },
      status() {
        return {
          outcome: state.outcome,
          throws: state.throws,
          active: isActive(),
          lastPush: state.lastPush,
          lastError: state.lastError,
        };
      },
      router,
      throwOnce,
      pushCurrent,
    };
  },
};

export { throwJiaobei };
