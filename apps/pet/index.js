// 宠物：一个在服务端按真实时间自主成长的小家伙。
//
// 它不依赖浏览器在线：饥饿、心情、精力按小时衰减，经验按小时累积，
// 阶段按出生天数解锁，全部由 growth.js 用「上次结算 → 现在」补算。
// 状态落在 data/pet/state.json，NAS 重启后接着长。
//
// 两种出图：
//   1. 自己的状态卡（400×300），用 client.showRaw 推送，不带徽章；
//   2. 其他应用推送时，server 通过 decorate(png) 在图片最空的一角合成宠物徽章。

import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureFont } from '../shared/canvas.js';
import { httpStatusOf } from '../../src/errors.js';
import { formatFor } from '../../src/image.js';
import {
  ACTIONS, applyTick, createState, describeState, levelOf, normalizeState, performAction, stageOf,
} from './growth.js';
import { renderPetCard } from './render.js';
import { decoratePng } from './overlay.js';
import { spriteBuffer, spriteInfo } from './sprites.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KEY_LEASE_MS = 2 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;
const SAVE_INTERVAL_MS = 60 * 1000;
const NAME_MAX = 8;

export default {
  id: 'pet',
  name: '宠物',
  description: '在 NAS 上按真实时间成长的柯基，可单独推卡，也会出现在其他应用图片的角落',

  create(ctx) {
    ensureFont({ fontsDir: ctx.fontsDir });

    const dataDir = path.join(ctx.dataDir, 'pet');
    const stateFile = path.join(dataDir, 'state.json');
    let pet = createState();
    let loaded = false;
    let loading = null;
    let savedAt = 0;
    let saveChain = Promise.resolve();
    let timer = null;
    let chain = Promise.resolve();
    const state = { activeUntil: 0, lastPush: null, lastError: null };

    /** 所有「互动/推图」串成一条链，避免两张图交错上传 */
    function run(task) {
      const next = chain.then(task);
      chain = next.then(
        () => {},
        (err) => {
          state.lastError = String(err?.message || err);
          ctx.log(`宠物：${state.lastError}`);
        },
      );
      return next;
    }

    function persist() {
      // 写盘串行，且最多每分钟一次；互动后会主动 save
      if (Date.now() - savedAt < SAVE_INTERVAL_MS) return saveChain;
      savedAt = Date.now();
      const snapshot = JSON.stringify({ ...pet, version: 1 }, null, 2) + '\n';
      saveChain = saveChain
        .then(() => fs.mkdir(dataDir, { recursive: true }))
        .then(() => fs.writeFile(stateFile, snapshot, 'utf8'))
        .catch((err) => ctx.log(`宠物状态保存失败：${String(err?.message || err)}`));
      return saveChain;
    }

    async function ensureLoaded() {
      if (loaded) return pet;
      if (loading) return loading;
      loading = (async () => {
        try {
          const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
          pet = normalizeState(raw, Date.now());
        } catch {
          pet = createState();
        }
        if (pet.overlay === undefined) pet.overlay = true;
        pet = applyTick(pet, Date.now());
        loaded = true;
        await persist();
        return pet;
      })();
      try {
        return await loading;
      } finally {
        loading = null;
      }
    }

    /** 每次读取前先按真实时间结算；一分钟内的状态不重复写盘 */
    async function refresh() {
      await ensureLoaded();
      pet = applyTick(pet, Date.now());
      persist();
      return pet;
    }

    function isActive() {
      return state.activeUntil > Date.now();
    }

    function currentPng(now = Date.now(), { notice } = {}) {
      return renderPetCard(pet, now, { notice });
    }

    async function pushCard({ notice } = {}) {
      const png = await currentPng(Date.now(), { notice });
      const client = await ctx.getClient();
      const started = Date.now();
      // showRaw 跳过全站宠物徽章，否则自己的卡片会被贴上第二只柯基
      await client.showRaw(png, formatFor(client));
      // 卡片上了屏，设备按键在接下来的窗口期归宠物用（上/下键不再切换应用）
      state.activeUntil = Date.now() + KEY_LEASE_MS;
      state.lastPush = { at: new Date().toISOString(), ms: Date.now() - started };
      state.lastError = null;
      return state.lastPush;
    }

    async function doAction(action, { pushToDevice = true, trigger = 'manual' } = {}) {
      await refresh();
      const result = performAction(pet, action, Date.now());
      if (!result.ok) {
        // 设备按键打到冷却中的操作时，重新推宠物卡，底部提示条换成
        // 「刚喂食过，8 分钟后再来哦」——按了键必须看得见反应，又不另推纯文案卡。
        if (pushToDevice && trigger === 'key' && result.error) {
          try {
            await pushCard({ notice: result.error });
          } catch (err) {
            state.lastError = String(err?.message || err);
          }
        }
        return { ...result, pushed: false, trigger };
      }
      pet = result.state;
      savedAt = 0;
      await persist();

      let pushed = false;
      let error = null;
      if (pushToDevice) {
        try {
          await pushCard();
          pushed = true;
        } catch (err) {
          error = String(err?.message || err);
          state.lastError = error;
        }
      }
      ctx.log(`宠物：${result.message}${pushed ? '（已推送）' : error ? `（未推送：${error}）` : ''}`);
      return {
        ok: true,
        pet,
        message: result.message,
        pushed,
        error,
        trigger,
      };
    }

    /** server 的推送代理在每张应用图片上调用它 */
    async function decorate(png) {
      await refresh();
      if (pet.overlay === false) return png;
      return decoratePng(png, pet);
    }

    const unsubscribers = [];
    // 宠物卡片在屏上时的按键分配：确认=抚摸（6 种动作循环）、上=喂食、下=玩耍。
    // 键盘租约到期后上/下键自动交还给应用切换；其他应用推图时立即交还。
    const KEY_ACTIONS = { confirm: 'pet', up: 'feed', down: 'play' };
    unsubscribers.push(ctx.on('event', (event) => {
      if (event.type !== 'key' || !isActive()) return;
      const action = KEY_ACTIONS[event.key];
      if (!action) return;
      run(() => doAction(action, { trigger: 'key' })).catch(() => {});
    }));

    const router = express.Router();

    router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

    router.get('/api/state', async (req, res) => {
      try {
        await refresh();
        res.json({
          ok: true,
          pet,
          derived: describeState(pet, Date.now()),
          sprite: spriteInfo(pet),
          actions: Object.entries(ACTIONS).map(([key, item]) => ({ key, label: item.label })),
          overlay: pet.overlay !== false,
          active: isActive(),
          lastPush: state.lastPush,
          lastError: state.lastError,
        });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err?.message || err) });
      }
    });

    /** 网页打开/关闭时调用：接管或交还设备确认键 */
    router.post('/api/arm', (req, res) => {
      const active = req.body?.active !== false;
      state.activeUntil = active ? Date.now() + KEY_LEASE_MS : 0;
      res.json({ ok: true, active });
    });

    router.post('/api/action', async (req, res) => {
      try {
        const action = String(req.body?.action ?? '');
        const result = await run(() => doAction(action, {
          pushToDevice: req.body?.push !== false,
          trigger: 'manual',
        }));
        if (!result.ok) {
          return res.status(400).json({ ok: false, error: result.error, pet, derived: describeState(pet) });
        }
        res.json({
          ok: true,
          pet,
          derived: describeState(pet),
          sprite: spriteInfo(pet),
          message: result.message,
          pushed: result.pushed,
          error: result.error,
        });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err?.message || err) });
      }
    });

    router.post('/api/push', async (req, res) => {
      try {
        await refresh();
        const lastPush = await run(() => pushCard());
        res.json({ ok: true, lastPush, pet, derived: describeState(pet), sprite: spriteInfo(pet) });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err?.message || err) });
      }
    });

    /** 改名与「叠加到其他应用」开关 */
    router.post('/api/config', async (req, res) => {
      try {
        await ensureLoaded();
        if (req.body?.name !== undefined) {
          const name = String(req.body.name).trim();
          if (!name || [...name].length > NAME_MAX) {
            return res.status(400).json({ ok: false, error: `名字需要 1~${NAME_MAX} 个字` });
          }
          pet.name = name;
        }
        if (req.body?.overlay !== undefined) pet.overlay = req.body.overlay !== false;
        savedAt = 0;
        await persist();
        res.json({ ok: true, pet, overlay: pet.overlay !== false, sprite: spriteInfo(pet) });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err?.message || err) });
      }
    });

    router.get('/api/preview.png', async (req, res) => {
      try {
        await refresh();
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(await currentPng());
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err?.message || err) });
      }
    });

    /** 当前表情的原始素材，网页头像用 */
    router.get('/api/sprite.png', async (req, res) => {
      try {
        await refresh();
        const info = spriteInfo(pet);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.set('X-Sprite', info.key);
        res.send(await spriteBuffer(info.key));
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err?.message || err) });
      }
    });

    return {
      async start() {
        await ensureLoaded();
        timer = setInterval(() => {
          refresh().catch((err) => ctx.log(`宠物结算失败：${String(err?.message || err)}`));
        }, TICK_MS);
        timer.unref?.();
        const stage = stageOf(pet.bornAt);
        ctx.log(`宠物已就绪：${pet.name} Lv.${levelOf(pet.exp)}（${stage.name}，第 ${stage.ageDays + 1} 天）`);
      },
      async stop() {
        if (timer) clearInterval(timer);
        timer = null;
        for (const off of unsubscribers.splice(0)) {
          try { off(); } catch { /* 已解绑 */ }
        }
        savedAt = 0;
        await persist();
      },
      status() {
        const stage = stageOf(pet.bornAt);
        return {
          name: pet.name,
          level: levelOf(pet.exp),
          stage: stage.name,
          ageDays: stage.ageDays,
          mood: Math.round(pet.mood),
          overlay: pet.overlay !== false,
          lastPush: state.lastPush,
          lastError: state.lastError,
        };
      },
      router,
      decorate,
      doAction,
      pushCard,
      // 卡片在屏上的租约期内，上/下键归宠物（喂食/玩耍），不切换应用
      blocksAppSwitch: () => isActive(),
      // 其他应用把图推上屏了：立刻交还按键，避免上下键还在喂食
      onScreenTaken() {
        state.activeUntil = 0;
      },
      pushCurrent: async () => {
        await refresh();
        return pushCard();
      },
      refresh,
    };
  },
};
