// 通用语音服务：TTS（Edge 在线朗读）+ ASR（OpenAI 兼容转写）。
//
// 设计取舍：
//   - 这是服务层能力，不是某个应用的附属：配置落盘在 data/speech.json，
//     通过 ctx.speech 交给所有应用复用（背单词、后续的听写/朗读类应用都能用）；
//   - TTS 用 Edge 在线合成，音色多、不需要密钥，走 api.msedgeservices.com 的
//     WebSocket 返回 webm-opus，再用仓库已有的 opusscript 解码成 16kHz PCM，
//     省掉 NAS 上跑不了的本地方案（Kokoro/MLX）；
//   - ASR 只约定 OpenAI 兼容的 POST {baseUrl}/audio/transcriptions，供应商可换，
//     没配置时 asrReady=false，调用方自行降级。
//
// 两者都是可选能力：合成失败（离线、被墙）只记日志返回 null；
// 识别未配置或失败也返回 null，不影响调用方的核心功能。

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import OpusScript from 'opusscript';
import { WebSocket as UndiciWebSocket } from 'undici';
import { InvalidInput } from './errors.js';

const SILENCE = 16; // 视为静音的能量阈值

// ---- Edge TTS 常量（协议参考 node-edge-tts / edge-tts，端点已迁到 msedgeservices）----
const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_CHROMIUM = '143.0.3650.75';
const EDGE_WSS = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
// 该端点只接受 mp3 / webm-opus；选 webm 是因为能用现成的 opusscript 解码
const EDGE_FORMAT = 'webm-24khz-16bit-mono-opus';
const EDGE_TTS_CACHE = 64; // 合成结果按 音色+文本 缓存，重复长按同一个词不必再联网

/** 常用音色：中文（普通话 / 粤语 / 台湾国语）与各口音英语（Edge 实际支持的多得多，页面里也允许手填） */
export const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN', name: '晓晓 · 女声 · 普通话' },
  { id: 'zh-CN-XiaoyiNeural', lang: 'zh-CN', name: '晓伊 · 女声 · 普通话' },
  { id: 'zh-CN-YunjianNeural', lang: 'zh-CN', name: '云健 · 男声 · 普通话（沉稳）' },
  { id: 'zh-CN-YunxiNeural', lang: 'zh-CN', name: '云希 · 男声 · 普通话（年轻）' },
  { id: 'zh-CN-YunxiaNeural', lang: 'zh-CN', name: '云夏 · 男声 · 普通话（少年）' },
  { id: 'zh-CN-YunyangNeural', lang: 'zh-CN', name: '云扬 · 男声 · 普通话（播报）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', lang: 'zh-CN', name: '晓北 · 女声 · 东北话' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', lang: 'zh-CN', name: '晓妮 · 女声 · 陕西话' },
  { id: 'zh-HK-HiuGaaiNeural', lang: 'zh-HK', name: '曉佳 · 女声 · 粤语' },
  { id: 'zh-HK-HiuMaanNeural', lang: 'zh-HK', name: '曉曼 · 女声 · 粤语' },
  { id: 'zh-HK-WanLungNeural', lang: 'zh-HK', name: '雲龍 · 男声 · 粤语' },
  { id: 'zh-TW-HsiaoChenNeural', lang: 'zh-TW', name: '曉臻 · 女声 · 台湾国语' },
  { id: 'zh-TW-HsiaoYuNeural', lang: 'zh-TW', name: '曉雨 · 女声 · 台湾国语' },
  { id: 'zh-TW-YunJheNeural', lang: 'zh-TW', name: '雲哲 · 男声 · 台湾国语' },

  { id: 'en-US-AnaNeural', lang: 'en-US', name: 'Ana · 童声 · 美音' },
  { id: 'en-US-AriaNeural', lang: 'en-US', name: 'Aria · 女声 · 美音（默认）' },
  { id: 'en-US-ChristopherNeural', lang: 'en-US', name: 'Christopher · 男声 · 美音（沉稳）' },
  { id: 'en-US-DavisNeural', lang: 'en-US', name: 'Davis · 男声 · 美音' },
  { id: 'en-US-EricNeural', lang: 'en-US', name: 'Eric · 男声 · 美音' },
  { id: 'en-US-GuyNeural', lang: 'en-US', name: 'Guy · 男声 · 美音' },
  { id: 'en-US-JaneNeural', lang: 'en-US', name: 'Jane · 女声 · 美音' },
  { id: 'en-US-JasonNeural', lang: 'en-US', name: 'Jason · 男声 · 美音' },
  { id: 'en-US-JennyNeural', lang: 'en-US', name: 'Jenny · 女声 · 美音' },
  { id: 'en-US-MichelleNeural', lang: 'en-US', name: 'Michelle · 女声 · 美音（清晰）' },
  { id: 'en-US-NancyNeural', lang: 'en-US', name: 'Nancy · 女声 · 美音' },
  { id: 'en-US-RogerNeural', lang: 'en-US', name: 'Roger · 男声 · 美音' },
  { id: 'en-US-SteffanNeural', lang: 'en-US', name: 'Steffan · 男声 · 美音' },
  { id: 'en-US-TonyNeural', lang: 'en-US', name: 'Tony · 男声 · 美音' },

  { id: 'en-GB-LibbyNeural', lang: 'en-GB', name: 'Libby · 女声 · 英音' },
  { id: 'en-GB-MaisieNeural', lang: 'en-GB', name: 'Maisie · 童声 · 英音' },
  { id: 'en-GB-RyanNeural', lang: 'en-GB', name: 'Ryan · 男声 · 英音' },
  { id: 'en-GB-SoniaNeural', lang: 'en-GB', name: 'Sonia · 女声 · 英音' },
  { id: 'en-GB-ThomasNeural', lang: 'en-GB', name: 'Thomas · 男声 · 英音' },

  { id: 'en-AU-NatashaNeural', lang: 'en-AU', name: 'Natasha · 女声 · 澳音' },
  { id: 'en-AU-WilliamNeural', lang: 'en-AU', name: 'William · 男声 · 澳音' },
  { id: 'en-CA-ClaraNeural', lang: 'en-CA', name: 'Clara · 女声 · 加拿大音' },
  { id: 'en-CA-LiamNeural', lang: 'en-CA', name: 'Liam · 男声 · 加拿大音' },
  { id: 'en-IE-ConnorNeural', lang: 'en-IE', name: 'Connor · 男声 · 爱尔兰音' },
  { id: 'en-IE-EmilyNeural', lang: 'en-IE', name: 'Emily · 女声 · 爱尔兰音' },
  { id: 'en-IN-NeerjaNeural', lang: 'en-IN', name: 'Neerja · 女声 · 印度音' },
  { id: 'en-IN-PrabhatNeural', lang: 'en-IN', name: 'Prabhat · 男声 · 印度音' },
  { id: 'en-KE-AsiliaNeural', lang: 'en-KE', name: 'Asilia · 女声 · 肯尼亚音' },
  { id: 'en-KE-ChilembaNeural', lang: 'en-KE', name: 'Chilemba · 男声 · 肯尼亚音' },
  { id: 'en-NG-AbeoNeural', lang: 'en-NG', name: 'Abeo · 男声 · 尼日利亚音' },
  { id: 'en-NG-EzinneNeural', lang: 'en-NG', name: 'Ezinne · 女声 · 尼日利亚音' },
  { id: 'en-NZ-MitchellNeural', lang: 'en-NZ', name: 'Mitchell · 男声 · 新西兰音' },
  { id: 'en-PH-JamesNeural', lang: 'en-PH', name: 'James · 男声 · 菲律宾音' },
  { id: 'en-PH-RosaNeural', lang: 'en-PH', name: 'Rosa · 女声 · 菲律宾音' },
  { id: 'en-SG-LunaNeural', lang: 'en-SG', name: 'Luna · 女声 · 新加坡音' },
  { id: 'en-SG-WayneNeural', lang: 'en-SG', name: 'Wayne · 男声 · 新加坡音' },
  { id: 'en-TZ-ElimuNeural', lang: 'en-TZ', name: 'Elimu · 男声 · 坦桑尼亚音' },
  { id: 'en-TZ-ImaniNeural', lang: 'en-TZ', name: 'Imani · 女声 · 坦桑尼亚音' },
  { id: 'en-ZA-LeahNeural', lang: 'en-ZA', name: 'Leah · 女声 · 南非音' },
  { id: 'en-HK-SamNeural', lang: 'en-HK', name: 'Sam · 男声 · 香港英语' },
  { id: 'en-HK-YanNeural', lang: 'en-HK', name: 'Yan · 女声 · 香港英语' },
];

/** 语音服务的默认配置；音色默认取列表第一个可用项（Aria） */
export const DEFAULT_SPEECH_CONFIG = {
  ttsVoice: EDGE_VOICES.find((voice) => voice.lang === 'en-US' && voice.id === 'en-US-AriaNeural')?.id
    ?? EDGE_VOICES[0].id,
  asrBaseUrl: null,
  asrModel: null,
  asrApiKey: null,
};

/** PCM16 单声道 → WAV（16kHz） */
export function pcmToWav(pcm, sampleRate = 16000) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 粗略判断是否有人声（避免把一段静音丢给 ASR 白等） */
export function hasSpeech(pcm) {
  if (!pcm || pcm.length === 0) return false;
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 8) energy += Math.abs(pcm[i]);
  return energy / Math.ceil(pcm.length / 8) > SILENCE;
}

/** Edge 的 DRM 参数：Windows 文件时间（5 分钟对齐）与可信客户端令牌的 SHA-256 */
export function edgeDrmToken(now = Date.now()) {
  // 1601-01-01 起的 100ns 计数，按 5 分钟（3e9 个 100ns）对齐；用 BigInt 保证末位不丢精度
  const ticks = BigInt(Math.floor(now / 1000 + 11644473600)) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n);
  return crypto.createHash('sha256').update(`${rounded}${EDGE_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

/** 读取 EBML 元素 ID（保留标记位）或长度（去掉标记位） */
function readEbmlVint(buffer, offset, stripMarker) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buffer.length) return null;
  let value = stripMarker ? first & (mask - 1) : first;
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    if (buffer[offset + i] !== 0xff) allOnes = false;
    value = value * 256 + buffer[offset + i];
  }
  return { value, length, unknownSize: stripMarker && allOnes };
}

const EBML_SEGMENT = 0x18538067;
const EBML_CLUSTER = 0x1f43b675;
const EBML_BLOCK_GROUP = 0xa0;
const EBML_SIMPLE_BLOCK = 0xa3;
const EBML_BLOCK = 0xa1;

/**
 * 从 Edge 返回的（流式、长度未知的）WebM 里取出 Opus 包。
 * 只需要 Cluster/SimpleBlock/Block，其他元素一律跳过。
 * 未知长度的容器按「延伸到父级末尾」处理——既要拿到全部音频，也不能越界。
 */
export function extractWebmPackets(buffer) {
  const packets = [];
  const walk = (start, end) => {
    let offset = start;
    while (offset < end) {
      const id = readEbmlVint(buffer, offset, false);
      if (!id) break;
      const size = readEbmlVint(buffer, offset + id.length, true);
      if (!size) break;
      const body = offset + id.length + size.length;
      if (body > end) break;
      const bodyEnd = size.unknownSize ? end : Math.min(body + size.value, end);

      if (id.value === EBML_SEGMENT || id.value === EBML_CLUSTER || id.value === EBML_BLOCK_GROUP) {
        walk(body, bodyEnd);
      } else if (id.value === EBML_SIMPLE_BLOCK || id.value === EBML_BLOCK) {
        // 块结构：轨道号(vint) + 时间码(2B) + 标志(1B) + Opus 包
        const track = readEbmlVint(buffer, body, true);
        const payload = track ? body + track.length + 3 : bodyEnd;
        if (payload < bodyEnd) packets.push(buffer.subarray(payload, bodyEnd));
      }

      if (size.unknownSize) break; // 容器已吃到末尾，没有同级可继续
      offset = bodyEnd;
    }
  };
  walk(0, buffer.length);
  return packets;
}

/** WebM(Opus) → 16kHz 单声道 PCM16；失败返回 null */
export function decodeWebmOpus(buffer) {
  const packets = extractWebmPackets(buffer);
  if (!packets.length) return null;
  const decoder = new OpusScript(48000, 1, OpusScript.Application.AUDIO);
  const pcm48 = [];
  try {
    for (const packet of packets) {
      const out = decoder.decode(packet, 5760); // 最多 120ms @48k
      const view = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
      for (let i = 0; i < view.length; i++) pcm48.push(view[i]);
    }
  } catch {
    return null;
  } finally {
    decoder.delete?.();
  }
  if (!pcm48.length) return null;

  // 48k → 16k：三样本平均（顺带做抗混叠），末尾不足 3 个直接丢弃
  const pcm = new Int16Array(Math.floor(pcm48.length / 3));
  for (let i = 0; i < pcm.length; i++) {
    const base = i * 3;
    pcm[i] = Math.round((pcm48[base] + pcm48[base + 1] + pcm48[base + 2]) / 3);
  }
  return pcm.length ? pcm : null;
}

const escapeXml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

/**
 * 用 Edge 在线朗读合成 16kHz PCM16。
 * @param {string} text
 * @param {{voice?: string, timeout?: number, WebSocketImpl?: typeof WebSocket,
 *          decode?: (buffer: Buffer) => Int16Array|null, log?: Function}} options
 * @returns {Promise<Int16Array|null>} 失败返回 null（调用方按「没声音」处理）
 */
export function synthesizeEdge(text, options = {}) {
  const {
    voice = DEFAULT_SPEECH_CONFIG.ttsVoice,
    timeout = 15000,
    WebSocketImpl = UndiciWebSocket,
    decode = decodeWebmOpus,
    log = () => {},
  } = options;
  const content = String(text ?? '').trim();
  if (!content) return Promise.resolve(null);

  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    let socket = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* 已关闭 */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      log('Edge TTS 超时，已放弃本次发音');
      finish(null);
    }, timeout);

    let url;
    try {
      const query = [
        `Ocp-Apim-Subscription-Key=${EDGE_TOKEN}`,
        `Sec-MS-GEC=${edgeDrmToken()}`,
        `Sec-MS-GEC-Version=1-${EDGE_CHROMIUM}`,
      ].join('&');
      url = `${EDGE_WSS}?${query}`;
      const major = EDGE_CHROMIUM.split('.')[0];
      socket = new WebSocketImpl(url, {
        headers: {
          Origin: EDGE_ORIGIN,
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      log(`Edge TTS 初始化失败: ${String(err?.message || err)}`);
      finish(null);
      return;
    }

    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      const timestamp = new Date().toString();
      socket.send(
        `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: EDGE_FORMAT,
              },
            },
          },
        }),
      );
      // xml:lang 取音色的语言标签（与 edge-tts 一致），英语音色用 en-US
      const lang = voice.split('-').slice(0, 2).join('-') || 'en-US';
      socket.send(
        `X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\n`
        + `X-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n`
        + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${escapeXml(lang)}'>`
        + `<voice name='${escapeXml(voice)}'><prosody rate='default' pitch='default' volume='default'>`
        + `${escapeXml(content)}</prosody></voice></speak>`,
      );
    });

    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          const bytes = Buffer.concat(chunks);
          if (!bytes.length) return finish(null);
          let pcm = null;
          try {
            pcm = decode(bytes);
          } catch (err) {
            log(`Edge TTS 解码失败: ${String(err?.message || err)}`);
          }
          return finish(pcm ?? null);
        }
        return;
      }
      const buffer = Buffer.from(data);
      if (buffer.length < 2) return;
      const headerLength = buffer.readUInt16BE(0);
      const header = buffer.subarray(2, 2 + headerLength).toString('utf8');
      if (!header.includes('Path:audio')) return; // turn.start 等控制帧没有音频
      chunks.push(buffer.subarray(2 + headerLength));
    });

    socket.addEventListener('error', (err) => {
      log(`Edge TTS 连接失败: ${String(err?.message || err || '未知错误')}`);
      finish(null);
    });

    socket.addEventListener('close', (event) => {
      if (!settled) {
        log(`Edge TTS 连接提前关闭（${event.code}${event.reason ? ` ${event.reason}` : ''}）`);
        finish(null);
      }
    });
  });
}

/** baseUrl 兼容三种写法：…/v1、…/audio/transcriptions、…（自动补 /v1/audio/transcriptions） */
export function transcriptionUrl(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return null;
  if (/\/audio\/transcriptions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/audio/transcriptions`;
  return `${base}/v1/audio/transcriptions`;
}

/**
 * 创建一个语音适配器（不做持久化；持久化由 createSpeechService 负责）。
 * @param {{ttsVoice?: string, ttsTimeout?: number, asrBaseUrl?: string, asrModel?: string,
 *          asrApiKey?: string, asrTimeout?: number, fetchImpl?: typeof fetch,
 *          WebSocketImpl?: typeof WebSocket, decode?: (buffer: Buffer) => Int16Array|null,
 *          log?: Function}} options
 */
export function createSpeech(options = {}) {
  const {
    ttsVoice = DEFAULT_SPEECH_CONFIG.ttsVoice,
    ttsTimeout = 15000,
    asrBaseUrl = null,
    asrModel = null,
    asrApiKey = null,
    asrTimeout = 30000,
    fetchImpl = fetch,
    WebSocketImpl = UndiciWebSocket,
    decode = decodeWebmOpus,
    log = console.warn,
  } = options;

  const asrUrl = asrModel ? transcriptionUrl(asrBaseUrl) : null;
  const cache = new Map(); // 音色+文本 → PCM

  return {
    asrReady: Boolean(asrUrl),
    ttsReady: true,
    voice: ttsVoice,

    /**
     * 语音识别。返回识别文本；未配置、静音、失败都返回 null（调用方按「没听清」处理）。
     * @param {Int16Array} pcm 16kHz 单声道
     */
    async recognize(pcm) {
      if (!asrUrl) return null;
      if (!hasSpeech(pcm)) return null;
      try {
        const form = new FormData();
        form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'speech.wav');
        form.append('model', asrModel);
        const headers = asrApiKey ? { Authorization: `Bearer ${asrApiKey}` } : {};
        const response = await fetchImpl(asrUrl, {
          method: 'POST',
          headers,
          body: form,
          signal: AbortSignal.timeout(asrTimeout),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        try {
          const json = JSON.parse(text);
          return String(json.text ?? json.result ?? json.transcription ?? '').trim() || null;
        } catch {
          return text.trim() || null;
        }
      } catch (err) {
        log(`ASR 识别失败: ${String(err?.message || err)}`);
        return null;
      }
    },

    /**
     * 语音合成（Edge TTS）。返回 16kHz PCM16；失败返回 null。
     * @param {string} text
     */
    async synthesize(text) {
      const content = String(text ?? '').trim();
      if (!content) return null;
      const key = `${ttsVoice}\n${content}`;
      if (cache.has(key)) return cache.get(key);

      const pcm = await synthesizeEdge(content, {
        voice: ttsVoice,
        timeout: ttsTimeout,
        WebSocketImpl,
        decode,
        log,
      });
      if (!pcm) return null;
      if (cache.size >= EDGE_TTS_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, pcm);
      return pcm;
    },
  };
}

/** 校验音色写法：en-US-AriaNeural、zh-CN-liaoning-XiaobeiNeural 都应通过 */
export function normalizeVoice(value) {
  const voice = String(value ?? '').trim();
  if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,10}(?:-[A-Za-z0-9]+)+$/.test(voice)) {
    throw new InvalidInput('音色应形如 en-US-AriaNeural 或 zh-CN-XiaoxiaoNeural');
  }
  return voice;
}

/** 把配置对象规整成合法值；坏字段退回默认，不让一份坏文件卡住服务 */
function normalizeStoredConfig(raw) {
  const config = { ...DEFAULT_SPEECH_CONFIG };
  if (!raw || typeof raw !== 'object') return config;
  try {
    if (raw.ttsVoice) config.ttsVoice = normalizeVoice(raw.ttsVoice);
  } catch { /* 保留默认音色 */ }
  const base = String(raw.asrBaseUrl ?? '').trim();
  if (base && /^https?:\/\//i.test(base)) config.asrBaseUrl = base.slice(0, 400);
  const model = String(raw.asrModel ?? '').trim();
  if (model) config.asrModel = model.slice(0, 120);
  const key = String(raw.asrApiKey ?? '').trim();
  if (key) config.asrApiKey = key.slice(0, 400);
  return config;
}

/** 合并并校验页面提交的增量配置 */
export function applySpeechPatch(current, patch = {}) {
  const next = { ...current };
  if (patch.ttsVoice !== undefined) next.ttsVoice = normalizeVoice(patch.ttsVoice);
  if (patch.asrBaseUrl !== undefined) {
    const value = patch.asrBaseUrl === null ? '' : String(patch.asrBaseUrl).trim();
    if (value && !/^https?:\/\//i.test(value)) throw new InvalidInput('ASR 地址应为 http(s) 开头的地址');
    next.asrBaseUrl = value ? value.slice(0, 400) : null;
  }
  if (patch.asrModel !== undefined) next.asrModel = String(patch.asrModel ?? '').trim().slice(0, 120) || null;
  if (patch.asrApiKey !== undefined) next.asrApiKey = String(patch.asrApiKey ?? '').trim().slice(0, 400) || null;
  return next;
}

/** 原子写入语音配置 */
async function writeSpeechConfig(file, config) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

/**
 * 全局语音服务：一份配置 + 一个适配器，供所有应用通过 ctx.speech 复用。
 * 配置更新后重建适配器，应用持有的引用仍然有效（读写走 getter / 委托）。
 * @param {{file?: string, factory?: Function, adapter?: object, log?: Function}} options
 */
export function createSpeechService(options = {}) {
  const {
    file = null,
    factory = createSpeech,
    adapter = {},
    log = console.warn,
  } = options;

  let config = { ...DEFAULT_SPEECH_CONFIG };
  let loaded = false;
  let loading = null;

  const build = () => factory({ ...adapter, ...config, log });
  let current = build();

  async function load() {
    if (loaded) return { ...config };
    if (!loading) {
      loading = (async () => {
        if (file) {
          try {
            config = normalizeStoredConfig(JSON.parse(await fs.readFile(file, 'utf8')));
          } catch (err) {
            // 首次运行没有文件是正常的；内容损坏才值得提示
            if (err?.code !== 'ENOENT') log(`语音配置读取失败，使用默认值: ${String(err?.message || err)}`);
          }
        }
        current = build();
        loaded = true;
        return { ...config };
      })();
    }
    return loading;
  }

  return {
    get config() { return { ...config }; },
    get voice() { return current.voice; },
    get asrReady() { return current.asrReady; },
    get ttsReady() { return current.ttsReady; },
    load,
    /** 校验增量配置、落盘并重建适配器；校验失败抛 InvalidInput（400） */
    async update(patch = {}) {
      const base = await load();
      const next = applySpeechPatch(base, patch);
      if (file) await writeSpeechConfig(file, next);
      config = next;
      current = build();
      return { ...config };
    },
    synthesize: (text) => current.synthesize(text),
    recognize: (pcm) => current.recognize(pcm),
  };
}
