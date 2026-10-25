// Web 服务层：把 ZectrixClient 封装成 NAS 上的 HTTP/SSE 服务。
// 任意局域网内的应用（包括原来的 Python/浏览器脚本）都可以通过 HTTP 推图，
// 按键与录音事件通过 SSE 实时下发，设备管理权集中在这一个 Node 进程里。
//
// 事件只有一个来源：client.nextEvent() 消费者。它同时负责写历史、广播 SSE、
// 把录音 PCM 落成 WAV 文件；不再额外挂 EventEmitter 监听，避免同一事件重复入库。

import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ZectrixClient, DEFAULT_PORT } from './client.js';
import { FORMAT, formatFor, resolveFormat } from './image.js';
import { ZectrixError } from './packet.js';
import { SAMPLE_RATE, CHANNELS } from './audio.js';
import { loadSettings, saveSettings, normalizeDevice, deviceWithPort, SettingsError } from './settings.js';
import { createApps, createBus } from './apps.js';
import { setFontChoice, getFontOptions } from '../apps/shared/canvas.js';
import { ERROR_STATUS, httpStatusOf, sendError } from './errors.js';
import { createSpeechService, EDGE_VOICES, pcmToWav } from './speech.js';
import {
  createAuth,
  createSessionToken,
  DEFAULT_PASSWORD_HASH,
  hashPassword,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  verifyPassword,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORMAT_BY_NAME = { mono: FORMAT.MONO, gray4: FORMAT.GRAY4, gray16: FORMAT.GRAY16 };
const EVENT_LIMIT = 200; // 事件环形缓冲上限
const HISTORY_LIMIT = 100; // 推送历史上限
const SSE_HEARTBEAT_MS = 15000;
const SSE_MAX_BUFFER = 1024 * 1024; // 慢客户端积压超过 1MB 即断开，避免进程内存被拖垮
const DEFAULT_RECORDINGS_KEEP = 200; // 录音文件保留数量（超出按时间删除最旧的）
const BODY_LIMIT = '16mb';
const APP_BODY_LIMIT = '256kb'; // 应用接口只收 JSON，不需要图片级上限

/**
 * @param {{device?: string, deviceSource?: 'file'|'startup', settingsFile?: string,
 *          passwordHash?: string, auth?: boolean,
 *          clientName?: string, recordingsDir?: string, recordingsKeep?: number,
 *          dataDir?: string, fontsDir?: string, apps?: boolean,
 *          briefBuilder?: Function, createSpeech?: Function, locationDetector?: Function}} config
 *   briefBuilder / createSpeech 是测试注入口：替换晨报数据源与语音适配器工厂，
 *   生产环境留空即走真实网络与真实 ASR/TTS。
 *   auth:false 同样是测试注入口，入口文件不会传，生产环境始终开启密码。
 * @returns {import('express').Express}
 */
export function createServer(config) {
  const app = express();

  // 设备地址、字体与密码哈希都存在同一个设置文件里
  const settingsFile = path.resolve(
    config.settingsFile || path.join(process.cwd(), 'data', 'config.json'),
  );
  // 鉴权放在 body 解析之前：未登录的大请求不会先被读进内存
  const authState = { hash: config.passwordHash || DEFAULT_PASSWORD_HASH };
  if (config.auth !== false) {
    app.use(createAuth({ getHash: () => authState.hash }));
  }

  /** 写入会话 Cookie；反代到 HTTPS 时补 Secure */
  function writeSessionCookie(req, res, passwordHash) {
    const token = createSessionToken(passwordHash);
    if (!token) return;
    const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const secure = req.secure || forwarded === 'https';
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_MAX_AGE_S}`,
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // 应用接口（/apps/*）先按 JSON 解析，再进全局的原始字节解析器；
  // express 只在 req._body 未置位时解析，所以顺序不会互相干扰。
  app.use('/apps', express.json({ limit: APP_BODY_LIMIT }));
  // type: () => true —— 无论是否带 Content-Type 都按原始字节解析（客户端常不带 Content-Type）
  app.use(express.raw({ type: () => true, limit: BODY_LIMIT }));

  const recordingsDir = path.resolve(
    config.recordingsDir || path.join(process.cwd(), 'data', 'recordings'),
  );
  const recordingsKeep = Number.isFinite(config.recordingsKeep)
    ? config.recordingsKeep
    : DEFAULT_RECORDINGS_KEEP;
  const state = {
    client: null,
    device: config.device || null,
    deviceSource: config.device ? config.deviceSource || 'startup' : 'none',
    font: 'noto',
    switching: null, // 切换设备时正在关闭旧连接的 promise
    settingsFile,
    connecting: false,
    lastError: null,
    events: [],
    history: [],
  };
  // 页面保存过的字体优先；配置文件里是未知字体时退回默认，不让服务起不来
  if (config.font) {
    try {
      state.font = setFontChoice(config.font);
    } catch {
      state.font = 'noto';
    }
  }
  const sseClients = new Set();

  // 应用层：数据目录与应用共用 data/，字体可放在 data/fonts 覆盖系统字体
  const dataDir = path.resolve(config.dataDir || path.join(process.cwd(), 'data'));
  const fontsDir = path.resolve(config.fontsDir || path.join(dataDir, 'fonts'));
  const bus = createBus((message) => console.error(message));
  // 语音是全局能力：配置在 data/speech.json，所有应用通过 ctx.speech 复用同一份设置
  const speech = createSpeechService({
    file: path.join(dataDir, 'speech.json'),
    factory: config.createSpeech,
    log: (message) => console.log(message),
  });
  const apps = config.apps === false
    ? null
    : createApps({
      dataDir,
      fontsDir,
      getClient: async () => clientWithPet(await ensureClient()),
      on: (name, handler) => bus.on(name, handler),
      log: (message) => console.log(message),
      speech,
      // 测试注入口：应用内部会 `ctx.briefBuilder ?? buildBrief`，
      // 只有把键真的传进 ctx，测试才能彻底离线（之前漏传，测试里其实在打真网络）。
      briefBuilder: config.briefBuilder,
      locationDetector: config.locationDetector,
    });

  /**
   * 给应用与通用推图用的客户端加一层「宠物徽章」代理。
   * 宠物自己的卡片走 showRaw，绕过装饰，避免叠加成两只猫。
   * 装饰失败只记日志，原图照常推送——宠物不能成为推送链路的单点故障。
   */
  const decoratedClients = new WeakMap();
  function clientWithPet(client) {
    if (!apps) return client;
    let proxy = decoratedClients.get(client);
    if (proxy) return proxy;
    proxy = new Proxy(client, {
      get(target, prop) {
        if (prop === 'show') {
          return async (image, format) => {
            let decorated = image;
            try {
              decorated = (await apps.get('pet')?.decorate(image)) ?? image;
            } catch (err) {
              console.log(`宠物徽章叠加失败，按原图推送：${String(err?.message || err)}`);
            }
            return target.show(decorated, format);
          };
        }
        if (prop === 'showRaw') return (image, format) => target.show(image, format);
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    decoratedClients.set(client, proxy);
    return proxy;
  }

  function broadcast(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        if (res.writableEnded) { sseClients.delete(res); continue; }
        // 背压：浏览器/网络卡住时不能让响应缓冲无限增长
        if (res.writableLength > SSE_MAX_BUFFER) {
          sseClients.delete(res);
          res.destroy();
          continue;
        }
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  /** 事件入库 + SSE 广播（唯一入口）；返回落库后的条目 */
  function pushEvent(event) {
    const entry = { ...event, at: new Date().toISOString() };
    state.events.push(entry);
    if (state.events.length > EVENT_LIMIT) state.events.splice(0, state.events.length - EVENT_LIMIT);
    broadcast(entry);
    return entry;
  }

  function pushHistory(entry) {
    state.history.unshift({ ...entry, at: new Date().toISOString() });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  }

  async function saveRecording(id, pcm) {
    if (!pcm || pcm.length === 0) return null;
    await fs.mkdir(recordingsDir, { recursive: true });
    const file = path.join(recordingsDir, `${id}.wav`);
    await fs.writeFile(file, wavFromPcm(pcm));
    await pruneRecordings(recordingsDir, recordingsKeep, file).catch(() => {});
    return `/api/recordings/${id}.wav`;
  }

  /** 只保留最近 keep 个录音文件，避免常驻服务把 NAS 磁盘写满 */
  async function pruneRecordings(dir, keep, keepFile) {
    if (!Number.isFinite(keep) || keep <= 0) return;
    const names = (await fs.readdir(dir)).filter((n) => /^\d+\.wav$/.test(n));
    if (names.length <= keep) return;
    const entries = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try { entries.push({ file, mtime: (await fs.stat(file)).mtimeMs }); } catch { /* 已删除 */ }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    const keepPath = path.resolve(keepFile);
    for (const entry of entries.slice(keep)) {
      if (path.resolve(entry.file) === keepPath) continue;
      await fs.unlink(entry.file).catch(() => {});
    }
  }

  /** 单消费者：把事件流翻译成 HTTP 侧的事件、历史与录音文件 */
  async function consumeEvents(client) {
    try {
      for (;;) {
        const event = await client.nextEvent();
        if (!event) break;
        if (event.type === 'key') {
          pushEvent({ type: 'key', key: event.key, action: event.action });
        } else if (event.type === 'recordingStarted') {
          pushEvent({ type: 'recordingStarted', id: event.id });
        } else if (event.type === 'recordingFinished') {
          let url = null;
          try {
            url = await saveRecording(event.id, event.audio);
          } catch (err) {
            state.lastError = `录音落盘失败: ${String(err.message || err)}`;
          }
          const samples = event.audio ? event.audio.length : 0;
          pushEvent({
            type: 'recording',
            id: event.id,
            reason: event.reason,
            samples,
            durationMs: Math.round((samples / SAMPLE_RATE) * 1000),
            lostFrames: event.lostFrames ?? 0,
            url,
          });
        } else if (event.type === 'disconnected') {
          pushEvent({ type: 'disconnected', reason: event.reason });
        }
        // 应用层订阅同一条事件流（key / recordingFinished / …），不再让应用自己去挂 client 监听
        bus.emit(event);
      }
    } catch {
      /* 连接已结束：由 disconnected 事件负责收尾 */
    }
  }

  async function ensureClient() {
    if (state.switching) await state.switching.catch(() => {});
    if (state.client && !state.client.closed) return state.client;
    if (!state.device) {
      throw new ZectrixError('NotConfigured', '尚未配置设备地址，请在页面「设备连接」里填写后保存');
    }
    if (state.connecting) throw new ZectrixError('Busy', '正在连接设备，请稍候');
    state.connecting = true;
    state.lastError = null;
    try {
      const client = new ZectrixClient(state.device, { clientName: config.clientName });
      // 只做状态清理，事件统一由 consumeEvents 处理，避免重复入库
      client.on('disconnected', () => {
        if (state.client === client) state.client = null;
      });
      await client.open();
      state.client = client;
      consumeEvents(client);
      pushEvent({ type: 'connected', id: client.summary?.id ?? null, model: client.summary?.model ?? null });
      return client;
    } catch (err) {
      state.lastError = String(err.message || err);
      throw err;
    } finally {
      state.connecting = false;
    }
  }

  /** 释放当前连接（发 CLOSE），并把“正在关闭”的 promise 暴露给 ensureClient 等待 */
  async function releaseClient() {
    const previous = state.client;
    state.client = null;
    if (!previous) return;
    state.switching = previous.close().catch(() => {}).finally(() => { state.switching = null; });
    await state.switching;
  }

  /**
   * 切换目标设备：先切地址（新请求不会连回旧设备），再释放旧连接。
   * 连接失败不会把旧地址写回，用户可在页面继续改。
   */
  async function applyDevice(next, source) {
    state.device = next;
    state.deviceSource = source;
    state.lastError = null;
    await releaseClient();
    pushEvent({ type: 'deviceChanged', device: next, source });
  }

  const fail = (res, err) => sendError(res, err);

  // ---- 页面 ----
  app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'favicon.ico'));
  });

  app.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.get('/device', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'device.html'));
  });

  // ---- 应用列表与挂载 ----
  app.get('/apps', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'apps.html'));
  });
  app.get('/api/apps', (req, res) => {
    res.json({ ok: true, apps: apps ? apps.summary() : [] });
  });
  if (apps) {
    for (const entry of apps.list) {
      app.use(`/apps/${entry.id}`, entry.instance.router);
    }
  }

  // ---- 设备地址配置（页面读写，落盘后重启仍生效） ----
  app.get('/api/config', (req, res) => {
    res.json({
      device: state.device,
      address: deviceWithPort(state.device),
      source: state.deviceSource, // file=页面保存 / startup=启动参数或环境变量 / none=未配置
      defaultPort: DEFAULT_PORT,
      connected: !!state.client && !state.client.closed,
      settingsFile: state.settingsFile,
      font: state.font,
      fonts: getFontOptions(),
      authToken: authState.hash, // 当前密码的哈希，也是 API 的 ?token= 取值
      lastError: state.lastError,
    });
  });

  app.post('/api/config', async (req, res) => {
    let payload;
    try {
      const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      payload = text.trim() ? JSON.parse(text) : {};
    } catch {
      return res.status(400).json({ ok: false, error: '请求体应为 JSON，例如 {"device":"192.168.1.100:32342"}' });
    }

    let device;
    try {
      device = normalizeDevice(payload?.device);
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err.message || err) });
    }

    let persisted = true;
    try {
      await saveSettings(state.settingsFile, {
        device,
        font: state.font,
        passwordHash: authState.hash,
      });
    } catch (err) {
      persisted = false;
      state.lastError = `配置保存失败（本次改动仅本进程有效）: ${String(err.message || err)}`;
    }

    if (device !== state.device) await applyDevice(device, 'file');
    else state.deviceSource = 'file';

    res.json({
      ok: true,
      device,
      address: deviceWithPort(device),
      persisted,
      ...(persisted ? {} : { warning: state.lastError }),
    });
  });

  // ---- 登录页：只校验密码，成功后发放会话 Cookie ----
  app.post('/api/login', (req, res) => {
    let payload;
    try {
      const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      payload = text.trim() ? JSON.parse(text) : {};
    } catch {
      return res.status(400).json({ ok: false, error: '请求体应为 JSON，例如 {"password":"密码"}' });
    }

    const password = typeof payload?.password === 'string' ? payload.password : '';
    if (!password || password.length > 128 || !verifyPassword(password, authState.hash)) {
      return res.status(401).json({ ok: false, error: '密码错误' });
    }

    writeSessionCookie(req, res, authState.hash);
    res.json({ ok: true });
  });

  // ---- 访问密码：登录后修改，API 可用哈希令牌 ----
  app.post('/api/password', async (req, res) => {
    // 令牌是给业务 API 用的；改密必须来自登录会话，避免令牌泄露后被直接换掉
    if (req.authMethod !== 'session') {
      return res.status(403).json({ ok: false, error: '修改密码需要先登录' });
    }
    let payload;
    try {
      const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      payload = text.trim() ? JSON.parse(text) : {};
    } catch {
      return res.status(400).json({ ok: false, error: '请求体应为 JSON，例如 {"password":"新密码"}' });
    }

    const password = typeof payload?.password === 'string' ? payload.password : '';
    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({ ok: false, error: '密码长度应为 6～128 个字符' });
    }

    const passwordHash = hashPassword(password);
    let persisted = true;
    try {
      await saveSettings(state.settingsFile, {
        device: state.device,
        font: state.font,
        passwordHash,
      });
    } catch (err) {
      persisted = false;
      state.lastError = `密码保存失败（本次改动仅本进程有效）: ${String(err.message || err)}`;
    }
    authState.hash = passwordHash;
    writeSessionCookie(req, res, passwordHash); // 旧会话全部失效，当前浏览器换发新 Cookie

    res.json({
      ok: true,
      token: passwordHash,
      persisted,
      ...(persisted ? {} : { warning: state.lastError }),
    });
  });

  // ---- 语音服务（TTS / ASR）：全局配置，所有应用共用 ----
  const readJsonBody = (req) => {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    return text.trim() ? JSON.parse(text) : {};
  };

  app.get('/api/speech', async (req, res) => {
    try {
      const config = await speech.load();
      res.json({
        ok: true,
        config,
        voices: EDGE_VOICES,
        asrReady: speech.asrReady,
        ttsReady: speech.ttsReady,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put('/api/speech', async (req, res) => {
    let payload;
    try {
      payload = readJsonBody(req);
    } catch {
      return res.status(400).json({ ok: false, error: '请求体应为 JSON' });
    }
    try {
      const config = await speech.update(payload ?? {});
      res.json({ ok: true, config, asrReady: speech.asrReady, ttsReady: speech.ttsReady });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 试听：只合成不推设备，用来确认服务器能不能访问 Edge TTS */
  app.post('/api/speech/test', async (req, res) => {
    let payload;
    try {
      payload = readJsonBody(req);
    } catch {
      payload = {};
    }
    await speech.load();
    const text = String(payload?.text ?? 'apple').trim().slice(0, 120) || 'apple';
    const startedAt = Date.now();
    const pcm = await speech.synthesize(text);
    if (!pcm) {
      return res.json({ ok: false, voice: speech.voice, error: '合成失败：服务器无法访问 Edge TTS，或音色不存在' });
    }
    // 直接把 WAV 作为 data URL 带回页面，试听无需再落盘或额外路由
    const wav = pcmToWav(pcm);
    res.json({
      ok: true,
      voice: speech.voice,
      samples: pcm.length,
      ms: Date.now() - startedAt,
      audio: `data:audio/wav;base64,${wav.toString('base64')}`,
    });
  });

  // ---- 设备图字体（只影响推送到墨水屏的图片，不改网页界面） ----
  app.post('/api/font', async (req, res) => {
    let payload;
    try {
      const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      payload = text.trim() ? JSON.parse(text) : {};
    } catch {
      return res.status(400).json({ ok: false, error: '请求体应为 JSON，例如 {"font":"wenkai"}' });
    }

    const requested = String(payload?.font ?? '');
    let font;
    try {
      font = setFontChoice(requested);
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err.message || err) });
    }

    let persisted = true;
    try {
      await saveSettings(state.settingsFile, {
        device: state.device,
        font,
        passwordHash: authState.hash,
      });
    } catch (err) {
      persisted = false;
      state.lastError = `字体保存失败（本次改动仅本进程有效）: ${String(err.message || err)}`;
    }
    state.font = font;

    res.json({
      ok: true,
      font,
      available: getFontOptions(),
      persisted,
      ...(font === requested ? {} : { warning: `字体 ${requested} 不可用（缺少字体文件），已回退默认` }),
      ...(persisted ? {} : { error: state.lastError }),
    });
  });

  // ---- 强制重连（改了地址后立刻验证是否真的能连上） ----
  app.post('/api/connect', async (req, res) => {
    if (!state.device) {
      return res.status(409).json({ ok: false, error: '尚未配置设备地址，请先填写后保存' });
    }
    await releaseClient();
    try {
      const client = await ensureClient();
      res.json({
        ok: true,
        address: deviceWithPort(state.device),
        summary: client.summary ?? null,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- 设备状态 ----
  app.get('/api/status', async (req, res) => {
    const connected = !!state.client && !state.client.closed;
    const payload = {
      device: state.device,
      address: deviceWithPort(state.device),
      deviceSource: state.deviceSource,
      connected,
      summary: state.client?.summary ?? null,
      lastError: state.lastError,
    };
    if (connected) {
      try {
        payload.status = await state.client.status();
      } catch (err) {
        payload.statusError = String(err.message || err);
      }
    }
    res.json(payload);
  });

  // ---- 推送图片（原始 PNG body，?format=mono|gray4|gray16，缺省用设备最优） ----
  app.post('/api/show', async (req, res) => {
    const rawFormat = req.query.format;
    let requested = null;
    if (rawFormat !== undefined) {
      const formatName = String(rawFormat).toLowerCase();
      requested = FORMAT_BY_NAME[formatName];
      if (!requested) {
        return res.status(400).json({ ok: false, error: 'format 应为 mono、gray4 或 gray16' });
      }
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 8) {
      return res.status(400).json({ ok: false, error: '请求体应为 PNG 二进制' });
    }
    try {
      const client = await clientWithPet(await ensureClient());
      // 不指定位深 → 设备支持的最高画质（16 灰阶设备即 GRAY16，不再默认 mono）；
      // 显式指的位深也夹取到设备能力以内，设备只有 4 阶灰时要 gray16 不会整张失败
      const format = requested === null ? formatFor(client) : resolveFormat(client, requested);
      // 首页推送同样算「屏幕易主」：让有会话状态的应用（如背单词）自行收尾
      apps?.notifyScreenTaken?.('home');
      const started = Date.now();
      await client.show(req.body, format);
      pushHistory({ kind: 'show', ok: true, format, bytes: req.body.length, ms: Date.now() - started });
      res.json({ ok: true, message: '设备已确认显示完成' });
    } catch (err) {
      pushHistory({ kind: 'show', ok: false, error: String(err.message || err) });
      fail(res, err);
    }
  });

  // ---- 播放音频（原始 PCM16 LE body，?volume=0..100） ----
  app.post('/api/play', async (req, res) => {
    const rawVolume = req.query.volume;
    let volume = 65;
    if (rawVolume !== undefined) {
      if (typeof rawVolume !== 'string' || rawVolume.trim() === '') {
        return res.status(400).json({ ok: false, error: 'volume 应为 0～100 的数字' });
      }
      volume = Number(rawVolume);
    }
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      return res.status(400).json({ ok: false, error: 'volume 应为 0～100 的数字' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 2) {
      return res.status(400).json({ ok: false, error: '请求体应为 PCM16 LE 二进制' });
    }
    // 复制到对齐的缓冲区：express 的 Buffer 不能保证 2 字节对齐
    const bytes = req.body.subarray(0, req.body.byteLength - (req.body.byteLength % 2));
    const pcm = new Int16Array(bytes.byteLength / 2);
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).set(bytes);
    try {
      const client = await ensureClient();
      const started = Date.now();
      const result = await client.play(pcm, volume);
      pushHistory({ kind: 'play', ok: true, volume, samples: pcm.length, end: result.end, ms: Date.now() - started });
      res.json({ ok: true, ...result });
    } catch (err) {
      pushHistory({ kind: 'play', ok: false, error: String(err.message || err) });
      fail(res, err);
    }
  });

  // ---- 录音下载（设备上行录音已由事件消费者落成 WAV） ----
  app.get('/api/recordings/:file', (req, res) => {
    const file = String(req.params.file);
    if (!/^\d{1,10}\.wav$/.test(file)) return res.status(400).json({ ok: false, error: '文件名应为 <id>.wav' });
    res.sendFile(path.join(recordingsDir, file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ ok: false, error: '录音不存在或已过期' });
    });
  });

  // ---- 事件流（SSE） ----
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\ndata: ${JSON.stringify({ type: 'hello', events: state.events.slice(-50) })}\n\n`);
    sseClients.add(res);
    const beat = setInterval(() => {
      try {
        if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
      } catch { /* 下一轮清理 */ }
    }, SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      sseClients.delete(res);
    });
  });

  // ---- 最近事件与推送历史 ----
  app.get('/api/history', (req, res) => {
    res.json({ events: state.events.slice(-100), history: state.history.slice(0, 50) });
  });

  // ---- 主动断开（释放设备管理权） ----
  app.post('/api/close', async (req, res) => {
    await releaseClient();
    res.json({ ok: true });
  });

  // ---- 停止当前播放/录音（长音频不必靠断开连接来中止） ----
  app.post('/api/stop', async (req, res) => {
    if (!state.client || state.client.closed) {
      return res.status(409).json({ ok: false, error: '设备未连接' });
    }
    try {
      const target = await state.client.stop();
      res.json({ ok: true, target: target || null });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 供进程退出时调用：先发 CLOSE 释放设备，再结束 SSE 连接 */
  app.locals.shutdown = async () => {
    await releaseClient().catch(() => {});
    if (apps) await apps.stop();
    for (const res of sseClients) {
      try { res.end(); } catch { /* 已关闭 */ }
    }
    sseClients.clear();
  };

  /** 供进程启动时调用：先加载全局语音配置，再注册应用定时任务、加载词库等（异步、失败只记日志） */
  app.locals.startApps = async () => {
    await speech.load().catch((err) => console.log(`语音配置加载失败: ${String(err?.message || err)}`));
    if (apps) await apps.start();
  };
  app.locals.apps = apps;
  app.locals.speech = speech;
  app.locals.bus = bus;

  // ---- 兜底：未知路径与未捕获异常都返回 JSON，不吐 HTML 错误页 ----
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: `未知接口: ${req.method} ${req.path}` });
    }
    res.status(404).type('text/plain').send('Not Found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    const message = status === 413
      ? `请求体过大（上限 ${BODY_LIMIT}）`
      : String(err.message || err);
    if (status >= 500) state.lastError = message;
    res.status(status).json({ ok: false, error: message });
  });

  return app;
}

/** PCM16 LE 单声道 → 44 字节头 + 数据（16kHz，与协议采样率一致） */
function wavFromPcm(pcm) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM 块大小
  header.writeUInt16LE(1, 20); // 格式：PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * 2, 32); // 块对齐
  header.writeUInt16LE(16, 34); // 位深
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export { DEFAULT_PORT };
