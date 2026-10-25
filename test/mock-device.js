// 模拟 ZECTRIX Note 4 设备：UDP 服务器实现 LAN v1 协议的另一端。
// 用于在没有真实硬件的情况下验证客户端的连接握手、图片分片补传、按键与录音流程。
import dgram from 'node:dgram';
import {
  T, END, IMG,
  encodePacket, decodePacket,
} from '../src/packet.js';

export class MockDevice {
  constructor({ dropChunkOnce = true, suppressResult = false, busy = false } = {}) {
    this.socket = dgram.createSocket('udp4');
    this.port = null;
    this.connectionId = 0x1234n;
    this.paletteBody = Buffer.from([
      0, 0, 85, 170, 255,
      0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255,
    ]);
    this.images = new Map(); // imageId -> {chunks: Map, dropped:Set}
    this.streams = new Map(); // streamId -> {frames: Map}
    this.receivedKeys = [];
    this.closed = false;
    this.dropChunkOnce = dropChunkOnce;
    // 模拟 RESULT 丢包：仍回 ACK 与 IMAGE_STATUS，但不上报最终结果
    this.suppressResult = suppressResult;
    this.busy = busy;
    this.resultSeq = 1000;
    this.keySeq = 6;
    this.lastImageDone = null;
    this.lastPlayDone = null;
    this._onPacket = null;
  }

  _nextResultSeq() {
    const seq = this.resultSeq;
    this.resultSeq = this.resultSeq >= 0xffffffff ? 1 : this.resultSeq + 1;
    return seq;
  }

  start() {
    return new Promise((resolve) => {
      this.socket.bind(0, '127.0.0.1', () => {
        this.port = this.socket.address().port;
        this.socket.on('message', (msg, rinfo) => this._handle(msg, rinfo));
        resolve(this.port);
      });
    });
  }

  get address() {
    return `127.0.0.1:${this.port}`;
  }

  stop() {
    try { this.socket.close(); } catch { /* 已关闭 */ }
  }

  _reply(rinfo, kind, seq, body, connection) {
    this.socket.send(
      encodePacket(kind | 0x80, connection ?? this.connectionId, seq, body),
      rinfo.port,
      rinfo.address,
    );
  }

  _handle(msg, rinfo) {
    const p = decodePacket(msg);
    if (!p) return;
    this._lastClientPort = rinfo.port;
    if (this._onPacket) this._onPacket(p);

    switch (p.kind) {
      case T.INFO: {
        const id = Buffer.from('aabbccddeeff');
        const model = Buffer.from('zectrix-s3-epaper-4.2');
        const body = Buffer.from([0, this.busy ? 1 : 0, id.length]);
        const rest = Buffer.concat([
          id,
          Buffer.from([model.length]),
          model,
          Buffer.from([1, 144, 1, 44, 0, 0, 0, 0, 0, 0, 0, 0]),
        ]);
        this._reply(rinfo, T.INFO, p.sequence, Buffer.concat([body, rest]), this.connectionId);
        return;
      }
      case T.CONNECT:
        this._reply(rinfo, T.CONNECT, p.sequence, Buffer.from([END.NORMAL]));
        return;
      case T.PALETTE:
        this._reply(rinfo, T.PALETTE, p.sequence, this.paletteBody);
        return;
      case T.PING:
        this._reply(rinfo, T.PING, p.sequence, Buffer.from([END.NORMAL]));
        return;
      case T.STATUS:
        this._reply(rinfo, T.STATUS, p.sequence, Buffer.from([0, 87, 1, 256 - 45])); // 87%, 充电中, -45dBm
        return;
      case T.CLOSE:
        this.closed = true;
        this._reply(rinfo, T.CLOSE, p.sequence, Buffer.from([END.NORMAL]));
        return;
      case T.IMAGE_BEGIN: {
        const imageId = p.sequence;
        const len = p.body.readUInt16BE(1);
        this.images.set(imageId, { totalLen: len, chunks: new Map(), droppedOnce: new Set() });
        this._reply(rinfo, T.IMAGE_BEGIN, p.sequence, Buffer.from([END.NORMAL]));
        return;
      }
      case T.IMAGE_DATA: {
        const imageId = p.body.readUInt32BE(0);
        const image = this.images.get(imageId);
        if (!image) return;
        if (this.dropChunkOnce && p.sequence === 0 && !image.droppedOnce.has(0)) {
          image.droppedOnce.add(0); // 模拟丢包：第一次不收块 0
          return;
        }
        image.chunks.set(p.sequence, p.body.subarray(4));
        return;
      }
      case T.IMAGE_STATUS: {
        const imageId = p.body.readUInt32BE(0);
        const image = this.images.get(imageId);
        if (!image) {
          this._reply(rinfo, T.IMAGE_STATUS, p.sequence, Buffer.from([R_INVALID, IMG.FAILED, 0, 0, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const expectedChunks = Math.ceil(image.totalLen / 1024);
        let bitmap = 0n;
        for (let i = 0; i < expectedChunks; i++) if (image.chunks.has(i)) bitmap |= 1n << BigInt(i);
        const complete = image.chunks.size === expectedChunks;
        const state = complete ? IMG.DONE : IMG.RECEIVING;
        const body = Buffer.alloc(10);
        body[0] = END.NORMAL;
        body[1] = state;
        body.writeBigUInt64BE(bitmap, 2);
        this._reply(rinfo, T.IMAGE_STATUS, p.sequence, body);
        if (complete && !image.resultSent) {
          image.resultSent = true;
          this.lastImageDone = { id: imageId, reason: END.NORMAL };
          if (this.suppressResult) return;
          // 设备主动上报 RESULT（对象 1=图片，原因 0=正常）
          const result = Buffer.alloc(6);
          result.writeUInt32BE(imageId, 0);
          result[4] = 1;
          result[5] = END.NORMAL;
          this.socket.send(encodePacket(T.RESULT, this.connectionId, this._nextResultSeq(), result), rinfo.port, rinfo.address);
        }
        return;
      }
      case T.AUDIO_BEGIN:
        this.streams.set(p.sequence, { frames: new Map() });
        this._reply(rinfo, T.AUDIO_BEGIN, p.sequence, Buffer.from([END.NORMAL]));
        return;
      case T.AUDIO_DATA: {
        const streamId = p.body.readUInt32BE(0);
        const stream = this.streams.get(streamId);
        if (stream) stream.frames.set(p.sequence, p.body.subarray(4));
        return;
      }
      case T.AUDIO_END: {
        const streamId = p.body.readUInt32BE(0);
        const total = p.body.readUInt32BE(4);
        const tail = p.body.readUInt16BE(8);
        this.lastPlayDone = { id: streamId, reason: END.NORMAL, total, tail };
        if (!this.suppressResult) {
          // 回一个播放完成 RESULT（对象 2=播放）
          const result = Buffer.alloc(6);
          result.writeUInt32BE(streamId, 0);
          result[4] = 2;
          result[5] = END.NORMAL;
          this.socket.send(encodePacket(T.RESULT, this.connectionId, this._nextResultSeq(), result), rinfo.port, rinfo.address);
        }
        this._reply(rinfo, T.AUDIO_END, p.sequence, Buffer.from([END.NORMAL]));
        return;
      }
      case T.STATE: {
        // 30 字节状态体：图片 id@20/原因@24，播放 id@25/原因@29
        const body = Buffer.alloc(30);
        if (this.lastImageDone) {
          body.writeUInt32BE(this.lastImageDone.id, 20);
          body[24] = this.lastImageDone.reason;
        }
        if (this.lastPlayDone) {
          body.writeUInt32BE(this.lastPlayDone.id, 25);
          body[29] = this.lastPlayDone.reason;
        }
        this._reply(rinfo, T.STATE, p.sequence, body);
        return;
      }
      case T.AUDIO_STOP:
        this._reply(rinfo, T.AUDIO_STOP, p.sequence, Buffer.from([END.NORMAL]));
        return;
      default:
        return;
    }
  }

  /** 模拟用户按下设备按键 */
  sendKey(key, action) {
    const body = Buffer.from([key, action]);
    const port = this._lastClientPort;
    if (!port) return;
    // 序号必须递增：客户端对 KEY 按序号去重，同序号的第二次按键会被当成重传包丢掉
    this.keySeq = (this.keySeq + 1) >>> 0;
    this.socket.send(encodePacket(T.KEY, this.connectionId, this.keySeq, body), port, '127.0.0.1');
  }

  /** 模拟设备录音上行 */
  async sendRecording(streamId, frames, tail, reason = END.NORMAL) {
    const port = this._lastClientPort;
    if (!port) return;
    const send = (kind, seq, body) =>
      new Promise((resolve) => this.socket.send(encodePacket(kind, this.connectionId, seq, body), port, '127.0.0.1', resolve));
    await send(T.AUDIO_BEGIN, streamId, Buffer.from([0]));
    for (let i = 0; i < frames.length; i++) {
      const body = Buffer.alloc(4 + frames[i].length);
      body.writeUInt32BE(streamId, 0);
      frames[i].copy(body, 4);
      await send(T.AUDIO_DATA, i, body);
    }
    const end = Buffer.alloc(11);
    end.writeUInt32BE(streamId, 0);
    end.writeUInt32BE(frames.length, 4);
    end.writeUInt16BE(tail, 8);
    end[10] = reason;
    await send(T.AUDIO_END, frames.length - 1, end);
  }

  /** 记录客户端端点，便于设备主动上报 */
  observe() {
    return this;
  }
}

const R_INVALID = 2;
