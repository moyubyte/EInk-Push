// 音频编解码：PCM16 16kHz 单声道 ↔ Opus 60ms 帧（960 样本）。
// 对齐 Rust SDK src/audio.rs：
//   - 播放方向：SDK 将 PCM 切成 960 样本帧，Opus Application=Audio、DTX 关闭，每帧 ≤1180 字节
//   - 录音方向：设备上行 Opus 帧，按帧序号重排、丢包用 PLC 补偿、末帧按有效采样数裁掉填充
// 编码器用 opusscript（libopus 1.4 的 Emscripten/WASM 构建），
// 纯 WASM 无原生编译，x86 / ARM NAS 均可直接运行；也可替换为 @discordjs/opus 等原生绑定。

import OpusScript from 'opusscript';
import { ZectrixError } from './packet.js';

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const FRAME_SAMPLES = 960; // 60ms
export const FRAME_MS = 60;
export const MAX_SAMPLES = SAMPLE_RATE * 120; // 单段上限 120 秒
export const MAX_PACKET = 1180; // UDP 负载上限 1200 - 16 头 - 4 字节流 ID
export const MAX_FRAMES = 2000; // 与 Rust Recording 的帧号硬上限一致

export class OpusCodec {
  constructor() {
    // Application.AUDIO = 2049
    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  }

  /** PCM16 LE Buffer/Array → Opus 帧数组（最后一帧零填充到 960 样本） */
  encode(pcm) {
    let samples;
    if (Buffer.isBuffer(pcm)) {
      if (pcm.byteLength % 2 !== 0) throw new ZectrixError('InvalidAudio', 'PCM 字节数应为偶数');
      samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    } else {
      samples = pcm;
    }
    if (samples.length === 0) throw new ZectrixError('InvalidAudio', '没有样本');
    if (samples.length > MAX_SAMPLES) throw new ZectrixError('AudioTooLong', '音频不能超过 120 秒');
    const frames = [];
    for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
      const chunk = samples.subarray(offset, offset + FRAME_SAMPLES);
      const padded = Buffer.alloc(FRAME_SAMPLES * 2);
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(padded);
      const packet = this.encoder.encode(padded, FRAME_SAMPLES);
      if (packet.length > MAX_PACKET) throw new ZectrixError('InvalidAudio', 'Opus 帧超过 1180 字节');
      frames.push(Buffer.from(packet));
    }
    return frames;
  }

  /**
   * 解码一个 Opus 帧 → Int16Array(960)，长度异常时归一化。
   * 注意：opusscript(WASM) 对空输入的 PLC 返回长度不稳定（实测 2880 样本），
   * 因此丢帧 concealment 在 Node 侧合成为 960 零样本；对音质敏感的部署
   * 建议换原生绑定（@discordjs/opus）以使用 libopus 真正的 opus_decode PLC。
   */
  decode(packet) {
    if (!packet || packet.length === 0) return new Int16Array(FRAME_SAMPLES);
    const out = this.decoder.decode(Buffer.from(packet), FRAME_SAMPLES);
    const pcm = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
    if (pcm.length === FRAME_SAMPLES) return pcm;
    const fixed = new Int16Array(FRAME_SAMPLES);
    fixed.set(pcm.subarray(0, Math.min(FRAME_SAMPLES, pcm.length)));
    return fixed;
  }

  /**
   * 严格解码：帧必须恰好 960 样本且为单声道，否则报错。
   * 对齐 Rust Recording::push 对 get_nb_samples / get_nb_channels 的校验；
   * 空帧用于丢包补偿，返回 960 个零样本。
   */
  decodeFrame(packet) {
    if (!packet || packet.length === 0) return new Int16Array(FRAME_SAMPLES);
    // Opus TOC 第 3 位（0x04）为 stereo 标志，协议约定单声道
    if (packet[0] & 0x04) throw new ZectrixError('InvalidAudio', 'Opus 帧不是单声道');
    const out = this.decoder.decode(Buffer.from(packet), FRAME_SAMPLES);
    if (out.byteLength !== FRAME_SAMPLES * 2) {
      throw new ZectrixError('InvalidAudio', '解码帧长度错误');
    }
    return new Int16Array(out.buffer, out.byteOffset, FRAME_SAMPLES);
  }

  /** 末帧有效采样数：与 Rust play() 一致，(n-1) % 960 + 1 */
  static tailSamples(totalSamples) {
    return totalSamples === 0 ? 0 : ((totalSamples - 1) % FRAME_SAMPLES) + 1;
  }
}

/**
 * 录音重组器：接收设备上行的 Opus 帧流，输出完整 PCM。
 * 逻辑对齐 audio.rs Recording：帧序号 < next+6 才缓存、乱序入 map、按序 drain、
 * 缺帧用 PLC 补偿、结束后按 tail 裁掉最后一帧填充。
 * drain 的“等不到就跳过”条件与 Rust 一致：force / 缓冲满 6 帧 / 空闲 180ms。
 */
export class RecordingAssembler {
  constructor(id, codec) {
    this.id = id;
    this.codec = codec;
    this.frames = new Map();
    this.next = 0;
    this.pcm = [];
    this.last = new Int16Array(0);
    this.end = null; // { total, tail, reason, at }
    this.startedAt = Date.now();
    this.progressAt = Date.now(); // 最近一次收到有效帧的时间（看门狗用）
    this.forceLimit = null; // 没有 AUDIO_END 时的硬上限：只补到已收到的最高帧
    this.gaps = 0; // 用静音补偿的缺帧数（可观测性）
  }

  /** 缓存一帧；返回 false 表示该帧被丢弃（序号过旧/过远/重复/已结束） */
  push(seq, data) {
    if (
      seq < this.next ||
      seq >= MAX_FRAMES ||
      seq >= this.next + 6 ||
      this.frames.has(seq) ||
      (this.end && seq >= this.end.total)
    ) {
      return false;
    }
    if (data.length === 0 || data.length > MAX_PACKET) {
      throw new ZectrixError('InvalidAudio', 'Opus 帧长度错误');
    }
    this.frames.set(seq, Buffer.from(data));
    this.progressAt = Date.now();
    this.drain(false);
    return true;
  }

  ending(total, tail, reason) {
    if (
      total > MAX_FRAMES ||
      (total === 0 && tail !== 0) ||
      (total > 0 && (tail < 1 || tail > FRAME_SAMPLES)) ||
      total < this.next
    ) {
      throw new ZectrixError('InvalidAudio', '录音结束长度错误');
    }
    if (!this.end) this.end = { total, tail, reason, at: Date.now() };
  }

  drain(force) {
    const limit = this.end ? this.end.total : (this.forceLimit ?? Infinity);
    while (this.next < MAX_FRAMES && this.next < limit) {
      const present = this.frames.has(this.next);
      // 180ms 空闲跳帧只用于“还在传输中”的实时解码；已收到 AUDIO_END（总帧数已知）时
      // 应继续等乱序帧到进展超时，否则会把晚到的帧当成丢包补成静音。
      const stalled = !this.end && this.frames.size > 0 && Date.now() - this.progressAt >= 180;
      if (!present && !(force || this.frames.size >= 6 || stalled)) break;
      if (this.last.length) this.pcm.push(...this.last);
      const data = this.frames.get(this.next);
      if (!present) this.gaps += 1;
      const pcm = this.codec.decodeFrame(data); // 缺帧 → 静音补偿
      this.last = pcm;
      this.frames.delete(this.next);
      this.next += 1;
    }
  }

  /** 结束后是否已收齐（供看门狗判断收尾时机） */
  get complete() {
    return this.end ? this.next >= this.end.total : false;
  }

  /** 收尾：输出完整 PCM 与结束原因；零帧返回 null audio */
  finish(fallbackReason) {
    if (!this.end) {
      // 没有 AUDIO_END（丢包/设备异常）：只补到已收到的最高帧，
      // 否则 force 会把序列一直补到 MAX_FRAMES，产出 2 分钟全静音
      this.forceLimit = this.frames.size ? Math.max(...this.frames.keys()) + 1 : this.next;
    }
    this.drain(true);
    const tail = this.end ? this.end.tail : this.last.length;
    const reason = this.end ? this.end.reason : fallbackReason;
    const out = new Int16Array(this.pcm.length + Math.min(tail, this.last.length));
    out.set(this.pcm, 0);
    out.set(this.last.subarray(0, Math.min(tail, this.last.length)), this.pcm.length);
    return { audio: out.length ? out : null, reason, lostFrames: this.gaps };
  }
}
