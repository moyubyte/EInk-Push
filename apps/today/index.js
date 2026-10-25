// 今天应用：定时把天气 / 空气质量 / 月历 / 历史上的今天画成 400×300 图，直推设备。
//
// 参考实现：https://github.com/happynailinzz/zectrix-morning-brief/blob/3b3ddab6fa48eed580dc99b196b826329475ca50/scripts/morning_brief.py
//
// 推图直接调用 ZectrixClient.show() 走局域网 UDP，不经过公网，也不需要 API Key。

import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cron from 'node-cron';
import { fileURLToPath } from 'node:url';
import { ensureFont, getFontChoice } from '../shared/canvas.js';
import { httpStatusOf } from '../../src/errors.js';
import { FORMAT, formatFor, resolveFormat } from '../../src/image.js';
import { renderBrief, renderFailure } from './render.js';
import {
  buildBrief, detectLocation, resolveLocation, termPair, todayInZone, addDays, formatDate, parseDate,
} from './sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_TTL = 5 * 60 * 1000;

const DEFAULT_CONFIG = {
  location: { label: '杭州', lat: 30.27, lon: 120.16, timezone: 'Asia/Shanghai' },
  cron: '0 7 * * *',
  enabled: true,
  format: 'gray16',
  tomorrow: false,
  qweatherKey: '',
  qweatherHost: '',
};

function validateConfig(input, current) {
  const next = { ...current, ...input };
  if (input.location) {
    const { label, lat, lon, timezone } = input.location;
    if (typeof label !== 'string' || !label.trim() || label.length > 20) throw new Error('地点名称应为 1～20 个字符');
    if (!Number.isFinite(Number(lat)) || Math.abs(Number(lat)) > 90) throw new Error('纬度应在 -90～90');
    if (!Number.isFinite(Number(lon)) || Math.abs(Number(lon)) > 180) throw new Error('经度应在 -180～180');
    next.location = {
      label: label.trim(),
      lat: Number(lat),
      lon: Number(lon),
      timezone: typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'Asia/Shanghai',
    };
  }
  if (input.cron !== undefined) {
    if (typeof input.cron !== 'string' || !cron.validate(input.cron)) throw new Error('cron 表达式不合法');
    next.cron = input.cron;
  }
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.tomorrow !== undefined) next.tomorrow = Boolean(input.tomorrow);
  if (input.format !== undefined) {
    if (!['mono', 'gray4', 'gray16'].includes(input.format)) throw new Error('format 应为 mono、gray4 或 gray16');
    next.format = input.format;
  }
  if (input.qweatherKey !== undefined) {
    if (typeof input.qweatherKey !== 'string' || input.qweatherKey.trim().length > 64) {
      throw new Error('和风天气 Key 格式不正确');
    }
    next.qweatherKey = input.qweatherKey.trim();
  }
  if (input.qweatherHost !== undefined) {
    if (typeof input.qweatherHost !== 'string' || input.qweatherHost.trim().length > 120) {
      throw new Error('和风天气 API Host 格式不正确');
    }
    next.qweatherHost = input.qweatherHost.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
  return next;
}

export default {
  id: 'today',
  name: '今天',
  description: '天气 / 月历 / 历史上的今天，定时或手动推送到设备',

  create(ctx) {
    const dataDir = path.join(ctx.dataDir, 'today');
    const configFile = path.join(dataDir, 'config.json');
    ensureFont({ fontsDir: ctx.fontsDir });

    const state = {
      config: DEFAULT_CONFIG,
      loaded: false,
      cache: null, // { key, at, png }
      lastPush: null,
      lastError: null,
      job: null,
    };

    // 测试注入口：默认走真实网络抓取，测试里可换成固定数据
    const build = ctx.briefBuilder ?? buildBrief;

    const router = express.Router();
    router.use(express.json({ limit: '16kb' }));

    async function loadConfig() {
      if (state.loaded) return state.config;
      let config = null;
      try {
        config = validateConfig(JSON.parse(await fs.readFile(configFile, 'utf8')), DEFAULT_CONFIG);
      } catch {
        config = null;
      }

      // 没有配置文件、或地点仍是内置默认值时，按服务所在网络自动定位一次。
      // 定位用的是 NAS 的出站公网 IP —— 浏览器访问时只能拿到内网地址，查不到地点。
      const stillDefault = config
        && JSON.stringify(config.location) === JSON.stringify(DEFAULT_CONFIG.location);
      if (!config || stillDefault) {
        const locate = ctx.locationDetector ?? detectLocation;
        let location = null;
        try {
          location = await locate({ log: ctx.log });
        } catch (err) {
          ctx.log(`自动定位失败: ${String(err?.message || err)}`);
        }
        const base = config ?? DEFAULT_CONFIG;
        config = validateConfig(location ? { location } : {}, base);
        if (location) {
          // 落盘，重启后保持同一个地点；失败也不影响本次运行
          try {
            await saveConfig(config);
          } catch (err) {
            ctx.log(`自动定位结果未能落盘: ${String(err?.message || err)}`);
          }
        }
      }

      state.config = config;
      state.loaded = true;
      return state.config;
    }

    async function saveConfig(next) {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(configFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
      state.config = next;
      state.loaded = true;
    }

    /** 生成一张图（带 5 分钟缓存，预览与推送共用） */
    async function generate({ date, tomorrow } = {}) {
      const config = await loadConfig();
      const targetDate = date ?? formatDate(todayInZone(config.location.timezone));
      const isTomorrow = tomorrow ?? config.tomorrow;
      // 字体也是渲染输入：切换字体后必须重新出图，否则 5 分钟缓存会一直返回旧字体的 PNG
      const key = `${targetDate}|${isTomorrow}|${JSON.stringify(config.location)}|${getFontChoice()}`;
      if (state.cache && state.cache.key === key && Date.now() - state.cache.at < CACHE_TTL) {
        return { ...state.cache, cached: true };
      }
      const brief = await build({
        location: config.location,
        date: targetDate,
        tomorrow: isTomorrow,
        qweatherKey: config.qweatherKey || '',
        qweatherHost: config.qweatherHost || '',
        log: (message) => { state.lastError = message; },
      });
      const png = renderBrief({ ...brief, terms: termPair(targetDate) });
      state.cache = { key, at: Date.now(), png, brief };
      return { ...state.cache, cached: false };
    }

    async function push(options = {}) {
      const config = await loadConfig();
      const started = Date.now();
      try {
        const generated = await generate(options);
        const client = await ctx.getClient();
        // 配置里选了设备没有的位深（如旧配置 mono、设备只有 4 阶灰却选了 gray16）时，
        // 夹取到设备能力以内，而不是让整张图推送失败
        const preferred = FORMAT[config.format.toUpperCase()] ?? formatFor(client);
        const format = resolveFormat(client, preferred);
        await client.show(generated.png, format);
        state.lastPush = {
          at: new Date().toISOString(),
          date: formatDate(generated.brief.date),
          tomorrow: generated.brief.tomorrow,
          bytes: generated.png.length,
          ms: Date.now() - started,
          trigger: options.trigger ?? 'manual',
        };
        state.lastError = null;
        ctx.log(`今天已推送（${state.lastPush.date}${state.lastPush.tomorrow ? ' 明日' : ''}，${state.lastPush.bytes}B，${state.lastPush.ms}ms）`);
        return state.lastPush;
      } catch (err) {
        state.lastError = String(err.message || err);
        throw err;
      }
    }

    function schedule() {
      if (state.job) {
        state.job.stop();
        state.job = null;
      }
      const config = state.config;
      if (!config.enabled) return;
      try {
        state.job = cron.schedule(config.cron, () => {
          push({ trigger: 'cron' }).catch((err) => ctx.log(`今天定时推送失败: ${err.message || err}`));
        }, { timezone: config.location.timezone });
      } catch (err) {
        state.lastError = `定时任务注册失败: ${err.message || err}`;
      }
    }

    // ---- 页面与接口 ----
    router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

    router.get('/api/config', async (req, res) => {
      const config = await loadConfig();
      res.json({ ok: true, config, lastPush: state.lastPush, lastError: state.lastError });
    });

    router.put('/api/config', async (req, res) => {
      const current = await loadConfig();
      let next;
      try {
        next = validateConfig(req.body ?? {}, current);
      } catch (err) {
        return res.status(400).json({ ok: false, error: String(err.message || err) });
      }

      // 只改了城市名、经纬度仍是旧值时，按城市名重新解析坐标，
      // 否则会出现「名字换成北京、坐标还停在杭州」。
      const labelChanged = next.location.label !== current.location.label;
      const coordsChanged = next.location.lat !== current.location.lat
        || next.location.lon !== current.location.lon;
      if (labelChanged && !coordsChanged) {
        let resolved = null;
        try {
          resolved = await resolveLocation(next.location.label, {
            key: next.qweatherKey || '',
            log: ctx.log,
          });
        } catch (err) {
          ctx.log(`城市坐标解析失败: ${String(err?.message || err)}`);
        }
        if (!resolved) {
          return res.status(422).json({
            ok: false,
            error: `没能找到「${next.location.label}」的经纬度，请手动填写纬度/经度后再保存`,
          });
        }
        next.location = resolved;
      }

      await saveConfig(next);
      schedule();
      res.json({ ok: true, config: next });
    });

    /** 页面上的「按城市查坐标」：城市名 → 经纬度/时区 */
    router.get('/api/geocode', async (req, res) => {
      const name = String(req.query.name ?? '').trim();
      if (!name) return res.status(400).json({ ok: false, error: '请提供城市名称' });
      try {
        const config = await loadConfig();
        const location = await resolveLocation(name, {
          key: config.qweatherKey || '',
          log: ctx.log,
        });
        if (!location) return res.status(404).json({ ok: false, error: `没有找到「${name}」` });
        res.json({ ok: true, location });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.get('/api/preview.png', async (req, res) => {
      try {
        const tomorrow = req.query.tomorrow === undefined ? undefined : req.query.tomorrow === '1';
        const date = req.query.date ? String(req.query.date) : undefined;
        if (date) parseDate(date); // 非法日期直接 400
        const generated = await generate({ date, tomorrow });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(generated.png);
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.post('/api/push', async (req, res) => {
      const { date, tomorrow } = req.body ?? {};
      try {
        if (date) parseDate(date);
        const result = await push({ date, tomorrow, trigger: 'manual' });
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(httpStatusOf(err)).json({ ok: false, error: String(err.message || err) });
      }
    });

    router.get('/api/failure.png', async (req, res) => {
      res.set('Content-Type', 'image/png').send(renderFailure(state.lastError || '未知错误'));
    });

    return {
      async start() {
        await loadConfig();
        schedule();
        ctx.log(`今天应用已就绪：${state.config.location.label}，cron=${state.config.enabled ? state.config.cron : '已关闭'}`);
      },
      stop() {
        if (state.job) state.job.stop();
        state.job = null;
      },
      status() {
        return { config: state.config, lastPush: state.lastPush, lastError: state.lastError };
      },
      router,
      // 供测试、应用切换与其他模块直接调用
      generate,
      push,
      pushCurrent: push,
    };
  },
};

export { validateConfig, DEFAULT_CONFIG };
