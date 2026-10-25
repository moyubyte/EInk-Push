// Zectrix LAN v1 客户端：连接管理、保活、图片推送、音频播放、按键/录音事件。
// 逐段对齐 Rust SDK src/device.rs 的语义与超时参数：
//   - 连接：INFO → CONNECT(PC名) → PALETTE(色板) → 启动收发与保活
//   - 保活：每 5s PING（4.5s 单次期限）；15s 未刷新成功确认则断开（终态，不自动重连）
//   - 图片：IMAGE_BEGIN 声明 bpp+压缩长度 → 1024 字节分片（头序号=块号）→
//           IMAGE_STATUS 轮询 64 位接收位图、只补缺块 → RESULT/STATE 确认显示完成
//   - 控制命令：1500ms 起步、指数退避至 4s、总期限 15s；同序号有限重传
//   - 结果未知：ResultUnknown 不得由本层自动重推，交由业务决定
//   - 录音：设备上行帧重组；3s 无进展 / 125s 超长 / 连接结束都会强制收尾
// 连接对象支持 close() 后再次 open()（会完整复位会话状态）。

import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  T, R, END, IMG,
  encodePacket, decodePacket, checkCode,
  parseInfo, parseStatus, parsePalette, parseImageStatus,
  keyName, actionName, ZectrixError,
} from './packet.js';
import { prepareImage, FORMAT } from './image.js';
import { OpusCodec, RecordingAssembler, FRAME_MS } from './audio.js';

export const DEFAULT_PORT = 32342;

const OPEN = {
  infoTimeout: 2000,
  connectTimeout: 15000,
  paletteTimeout: 5000,
  retryInterval: 1500,
};
const REQ = { initial: 1500, maxInterval: 4000, deadline: 15000, pingDeadline: 4500 };
const KEEPALIVE = { interval: 5000, timeout: 15000 };
const IMAGE = {
  chunk: 1024,
  chunkInterval: 2,
  pollInterval: 350,
  statusTimeout: 2000,
  receiveDeadline: 30000,
  refreshDeadline: 60000,
};
const AUDIO = { resultDeadline: 15000, pollInterval: 500, scheduleTolerance: 360 };
const RECORDING = { progressTimeout: 3000, totalTimeout: 125000, endGrace: 360, tickInterval: 100 };

export class ZectrixClient extends EventEmitter {
  /**
   * @param {string} address 设备 IPv4 / IPv4:port / 主机名（默认端口 32342）
   * @param {{clientName?: string}} options
   */
  constructor(address, options = {}) {
    super();
    const [host, port] = address.includes(':') ? address.split(':') : [address, String(DEFAULT_PORT)];
    this.host = host;
    this.port = Number(port);
    this.peerIp = null; // 解析后的设备 IPv4，用于接收侧来源过滤
    this.clientName = (options.clientName || 'EInkPush Node Client').slice(0, 48);
    this.socket = null;
    this.recvLoop = null;
    this._codec = null;
    this._initSessionState();
  }

  /** 会话态复位：open() 复用，保证 close() 之后可以重新 open() */
  _initSessionState() {
    this.connection = 0n;
    this.palette = null;
    this.summary = null;
    this.controlSeq = 2; // CONNECT/PALETTE 固定用 1，控制序号从 2 起
    this.querySeq = 1;
    this.pingSeq = 1;
    this.pending = new Map(); // (kind|0x80)*2^32+seq -> {resolve, reject}
    this.results = new Map(); // (object, id) -> reason
    this.closed = false;
    this.opening = false;
    this.ended = false;
    this._terminated = false;
    this._pinging = false;
    this.lastPingAt = 0;
    this.heartbeatTimer = null;
    this.recordTimer = null;
    this.recordings = new Map(); // streamId -> RecordingAssembler
    this.endedRecordingId = 0;
    this.imageGate = 0;
    this.playbackId = 0;
    this.captureId = 0;
    this.stoppedPlay = 0;
    this.stoppedCapture = 0;
    this._eventQueue = [];
    this._eventWaiters = [];
    this._messageQueue = [];
    this._messageWaiters = [];
    this._locks = { image: Promise.resolve(), play: Promise.resolve() };
  }

  // ---------- 连接生命周期 ----------

  async open() {
    if (this.socket) throw new ZectrixError('Busy', '连接已打开');
    if (this.opening) throw new ZectrixError('Busy', '连接正在建立中');
    this._initSessionState();
    try {
      this.peerIp = await resolvePeer(this.host);
      this.socket = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        this.socket.once('error', onError);
        this.socket.once('listening', () => {
          this.socket?.removeListener('error', onError);
          resolve();
        });
        this.socket.bind(0);
      });
      // 未连接 socket：所有发送显式带目标地址，接收侧按 rinfo 过滤
      this.socket.on('message', (data, rinfo) => this._onMessage(data, rinfo));
      this.socket.on('error', (err) => this.emit('socketError', err));
      this.opening = true;
      // 接收循环不挂 catch 的话，一次意外抛错会变成 unhandledRejection 直接杀进程；
      // 这里降级为 socketError，连接由 15s 保活超时兜底收尾
      this.recvLoop = this._receiveLoop().catch((err) => this.emit('socketError', err));

      // 1) INFO：connection=0, seq=1；响应头带设备当前连接编号
      const infoResp = await this._exchange(encodePacket(T.INFO, 0, 1), T.INFO, OPEN.infoTimeout, 1);
      const info = parseInfo(infoResp, `${this.host}:${this.port}`);
      this.connection = infoResp.connection;
      this.summary = info;
      if (info.busy) throw new ZectrixError('Busy', '设备正被其他连接方管理');

      // 2) CONNECT：绑定本机，取得管理权
      const nameBuf = Buffer.from(this.clientName, 'utf8');
      const connectResp = await this._exchange(
        encodePacket(T.CONNECT, this.connection, 1, Buffer.concat([Buffer.from([nameBuf.length]), nameBuf])),
        T.CONNECT,
        OPEN.connectTimeout,
        1,
      );
      checkCode(connectResp.body);

      // 3) PALETTE：读取设备色板，失败即释放管理权
      try {
        const paletteResp = await this._exchange(
          encodePacket(T.PALETTE, this.connection, 1),
          T.PALETTE,
          OPEN.paletteTimeout,
          1,
        );
        this.palette = parsePalette(paletteResp.body);
      } catch (err) {
        await this._sendClose(END.NORMAL).catch(() => {});
        throw err;
      }

      this.closed = false;
      this.opening = false;
      this.lastPingAt = Date.now();
      this.heartbeatTimer = setInterval(() => this._heartbeat(), KEEPALIVE.interval);
      this.recordTimer = setInterval(() => this._tickRecording(), RECORDING.tickInterval);
      this.emit('open', this.summary);
      return this;
    } catch (err) {
      this._abortOpen(err);
      throw err;
    }
  }

  /** 打开失败：清理 socket、心跳与接收循环，不留下半开连接 */
  _abortOpen(err) {
    this._terminated = true;
    this.closed = true;
    this.opening = false;
    this.ended = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.recordTimer) clearInterval(this.recordTimer);
    this.heartbeatTimer = null;
    this.recordTimer = null;
    const reason = err instanceof Error ? err : new Error(String(err));
    for (const entry of this.pending.values()) entry.reject(reason);
    this.pending.clear();
    for (const waiter of this._messageWaiters.splice(0)) waiter(null);
    for (const waiter of this._eventWaiters.splice(0)) waiter(null);
    if (this.socket) {
      this.socket.removeAllListeners('message');
      this.socket.removeAllListeners('error');
      try { this.socket.close(); } catch { /* 已关闭 */ }
      this.socket = null;
    }
  }

  async close() {
    if (this.closed) return;
    // 必须先发 CLOSE 再置终态：_send 会拒绝已关闭连接上的发送
    await this._sendClose(END.NORMAL).catch(() => {});
    this._terminate('Closed');
  }

  _terminate(reason) {
    if (this._terminated) return;
    this._terminated = true;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.recordTimer) clearInterval(this.recordTimer);
    this.heartbeatTimer = null;
    this.recordTimer = null;

    // 在途请求立即失败，不等各自的重传期限
    for (const entry of this.pending.values()) entry.reject(new ZectrixError('Disconnected', '连接已结束'));
    this.pending.clear();

    // 残留录音以“断开”收尾，避免 capture 状态泄漏
    for (const id of [...this.recordings.keys()]) this._finalizeRecording(id, 'Disconnected');

    this.ended = true;
    for (const waiter of this._messageWaiters.splice(0)) waiter(null);
    if (this.socket) {
      this.socket.removeAllListeners('message');
      this.socket.removeAllListeners('error');
      try { this.socket.close(); } catch { /* 已关闭 */ }
      this.socket = null;
    }
    this._emitEvent({ type: 'disconnected', reason });
    this.emit('disconnected', reason);
    for (const waiter of this._eventWaiters.splice(0)) waiter(null);
  }

  /** 发送 CLOSE；UDP 单发易丢，重发两次后即返回（不等待设备响应） */
  async _sendClose(reason) {
    if (!this.socket) return;
    const seq = this._nextControlSeq();
    const packet = encodePacket(T.CLOSE, this.connection, seq, Buffer.from([reason]));
    for (let i = 0; i < 2; i++) {
      await this._send(packet).catch(() => {});
      if (i === 0) await sleep(120);
    }
  }

  // ---------- 收发核心 ----------

  /** 持久 message 监听 + 内部队列：两轮处理之间到达的报文不丢失 */
  _nextMessage() {
    if (this._messageQueue.length) return Promise.resolve(this._messageQueue.shift());
    if (!this.socket) return Promise.resolve(null);
    return new Promise((resolve) => this._messageWaiters.push(resolve));
  }

  _onMessage(data, rinfo) {
    const entry = { data, rinfo };
    const waiter = this._messageWaiters.shift();
    if (waiter) waiter(entry);
    else this._messageQueue.push(entry);
  }

  _nextControlSeq() {
    const n = this.controlSeq;
    if (n >= 0xffffffff) throw new ZectrixError('Disconnected', '控制序号耗尽');
    this.controlSeq = n + 1;
    return n;
  }

  _nextQuerySeq() {
    const n = this.querySeq;
    this.querySeq = n >= 0xffffffff ? 1 : n + 1;
    return n;
  }

  /** PING 使用独立递增计数器（对齐 Rust Wire::ping） */
  _nextPingSeq() {
    const n = this.pingSeq;
    this.pingSeq = n >= 0xffffffff ? 1 : n + 1;
    return n;
  }

  _send(packet) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.closed) return reject(new ZectrixError('Disconnected', '连接已结束'));
      // Node 22 的 dgram 对 send(msg, cb) 支持不完整，统一用显式目标地址形式
      this.socket.send(packet, this.port, this.peerIp, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** 串行锁：图片上传与播放各自互斥，避免分片/帧交错 */
  async _withLock(name, fn) {
    const prev = this._locks[name] ?? Promise.resolve();
    let release;
    this._locks[name] = new Promise((resolve) => { release = resolve; });
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 请求-响应：同序号有限重传，1500ms 起步退避至 4s，默认总期限 15s。
   * @param {number} kind 消息类型
   * @param {Buffer} body 负载
   * @param {number} [fixedSeq] 固定序号（控制类命令用）
   * @param {{deadline?: number}} [options]
   */
  async _request(kind, body, fixedSeq, options = {}) {
    if (this.pending.size >= 8) throw new ZectrixError('Busy', '在途请求过多');
    const seq = fixedSeq ?? (kind === T.PING ? this._nextPingSeq() : this._nextQuerySeq());
    const packet = encodePacket(kind, this.connection, seq, body);
    const key = (kind | 0x80) * 0x100000000 + seq;
    const total = options.deadline ?? REQ.deadline;
    return new Promise((resolveP, rejectP) => {
      let attempt = 0;
      let timer = null;
      let settled = false;
      const deadline = Date.now() + total;
      const entry = { resolve: null, reject: null };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        // 只删除自己注册的条目：PING 等复用键位时不能误删后来者
        if (this.pending.get(key) === entry) this.pending.delete(key);
      };
      const fail = (err) => { if (!settled) { settled = true; cleanup(); rejectP(err); } };
      const tick = async () => {
        if (settled) return;
        if (this.closed) return fail(new ZectrixError('Disconnected', '连接已结束'));
        try { await this._send(packet); } catch (err) { return fail(err); }
        const wait = Math.min(REQ.initial * 2 ** attempt, REQ.maxInterval);
        attempt += 1;
        const remaining = deadline - Date.now();
        if (remaining <= wait) {
          timer = setTimeout(() => fail(new ZectrixError('ResultUnknown', '等待响应超时，结果未知')), remaining);
          return;
        }
        timer = setTimeout(tick, wait);
      };
      entry.resolve = (p) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { checkCode(p.body); resolveP(p); } catch (err) { rejectP(err); }
      };
      entry.reject = fail;
      this.pending.set(key, entry);
      tick();
    });
  }

  /** open 阶段的原始交换（固定序号，重发同一报文） */
  async _exchange(packet, kind, timeout, sequence) {
    const key = (kind | 0x80) * 0x100000000 + sequence;
    const deadline = Date.now() + timeout;
    for (;;) {
      // 先登记等待者再发送：设备回包可能早于 send 回调，晚登记会导致漏收并白等一个重传周期
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), OPEN.retryInterval);
      });
      const wait = this._waitOnce(kind, sequence);
      wait.catch(() => {}); // 超时后迟到的 rejection 不能变成 unhandled
      let response = null;
      try {
        await this._send(packet);
        response = await Promise.race([wait, timedOut]);
      } finally {
        clearTimeout(timer);
      }
      if (response) return response;
      this.pending.delete(key);
      if (Date.now() >= deadline) throw new ZectrixError('ResultUnknown', '设备未响应');
    }
  }

  /** 一次性等待指定 (kind|0x80, seq) 的响应，用于 open 阶段 */
  _waitOnce(kind, seq) {
    const key = (kind | 0x80) * 0x100000000 + seq;
    return new Promise((resolve, reject) => {
      if (this.pending.size >= 8) return reject(new ZectrixError('Busy', '在途请求过多'));
      this.pending.set(key, {
        resolve: (p) => { try { checkCode(p.body); resolve(p); } catch (err) { reject(err); } },
        reject,
      });
    });
  }

  async _receiveLoop() {
    const seen = [];
    while (!this.closed) {
      const incoming = await this._nextMessage();
      if (!incoming) break;
      const { data, rinfo } = incoming;
      // 只处理来自目标设备的报文（UDP 未连接，按解析后的设备 IP 过滤）
      if (rinfo.address !== this.peerIp) continue;
      const packet = decodePacket(data);
      if (!packet) continue;
      // open 阶段设备响应携带的是设备侧连接编号，尚未同步到 this.connection，不过滤
      if (!this.opening && packet.connection !== this.connection) continue;

      if (packet.kind & 0x80) {
        // 响应：唤醒等待者；STALE 表示连接失效
        const key = packet.kind * 0x100000000 + packet.sequence;
        const waiter = this.pending.get(key);
        if (waiter) { this.pending.delete(key); waiter.resolve(packet); }
        if (packet.body[0] === R.STALE) { this._terminate('DeviceExit'); return; }
        continue;
      }

      // 设备主动上报：先 ACK（kind|0x80 回显序号，负载 [0]），再去重
      const valid = this._validateDevicePacket(packet);
      if (!valid) continue;
      if (packet.kind !== T.AUDIO_DATA) {
        await this._send(encodePacket(packet.kind | 0x80, this.connection, packet.sequence, Buffer.from([0]))).catch(() => {});
        // 只有 KEY 需要按序号去重：ACK 丢包会让设备重发按键。其余上报要么本身幂等
        // （RESULT 覆盖同一键、CLOSE 走 _terminate、AUDIO_BEGIN 有 recordings.has 守卫），
        // 要么序号根本不唯一——AUDIO_END 的 sequence 是末帧号，两段帧数相同的录音会重复，
        // 按 (kind,seq) 去重会把后一段的 END 当重复包丢掉，整段录音只能等看门狗判失败。
        if (packet.kind === T.KEY) {
          if (seen.includes(packet.sequence)) continue;
          seen.push(packet.sequence);
          if (seen.length > 64) seen.shift();
        }
      }

      switch (packet.kind) {
        case T.CLOSE:
          this._terminate(closeReasonName(packet.body[0]));
          return;
        case T.KEY:
          this._emitEvent({
            type: 'key',
            key: keyName(packet.body[0]),
            action: actionName(packet.body[1]),
          });
          this.emit('key', keyName(packet.body[0]), actionName(packet.body[1]));
          break;
        case T.RESULT: {
          const id = packet.body.readUInt32BE(0);
          const object = packet.body[4];
          const reason = packet.body[5];
          this.results.set(`${object}:${id}`, reason);
          if (this.results.size > 16) this.results.delete(this.results.keys().next().value);
          break;
        }
        case T.AUDIO_BEGIN:
        case T.AUDIO_DATA:
        case T.AUDIO_END:
          this._handleIncomingAudio(packet);
          break;
        default:
          break;
      }
    }
  }

  _validateDevicePacket(p) {
    switch (p.kind) {
      case T.KEY:
        return p.body.length === 2 && p.body[0] >= 1 && p.body[0] <= 3 && p.body[1] >= 1 && p.body[1] <= 2 && !(p.body[0] === 3 && p.body[1] === 2);
      case T.RESULT:
        return p.body.length === 6 && p.body[4] >= 1 && p.body[4] <= 2 && p.body[5] <= 7;
      case T.CLOSE:
        return p.body.length === 1 && p.body[0] <= 7;
      case T.AUDIO_BEGIN:
        return p.body.length === 1 && p.body[0] === 0 && p.sequence > 0;
      case T.AUDIO_END:
        return p.body.length === 11 && p.body[10] <= 7;
      case T.AUDIO_DATA:
        return p.body.length >= 5 && p.body.length <= 1184;
      default:
        return false;
    }
  }

  async _heartbeat() {
    if (this.closed || this._pinging) return;
    if (Date.now() - this.lastPingAt >= KEEPALIVE.timeout) {
      this._terminate('Timeout');
      return;
    }
    this._pinging = true;
    try {
      await this._request(T.PING, Buffer.alloc(0), undefined, { deadline: REQ.pingDeadline });
      this.lastPingAt = Date.now();
    } catch { /* 单次失败不立即退出，由 15s 总超时兜底 */ } finally {
      this._pinging = false;
    }
  }

  // ---------- 事件队列 ----------

  _emitEvent(event) {
    const waiter = this._eventWaiters.shift();
    if (waiter) waiter(event);
    else this._eventQueue.push(event);
  }

  /** 与 Rust next_event() 等价：单消费者顺序事件流；连接终止后返回 null */
  nextEvent() {
    if (this._eventQueue.length) return Promise.resolve(this._eventQueue.shift());
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this._eventWaiters.push(resolve));
  }

  // ---------- 设备查询 ----------

  async status() {
    const response = await this._request(T.STATUS, Buffer.alloc(0));
    return parseStatus(response.body);
  }

  /**
   * 读取 STATE（30 字节）。图片对象 id 在偏移 20、原因在 24；播放对象 id 在 25、原因在 29。
   * 返回 undefined 表示设备未报告该对象（超时/长度不符/id 不匹配）。
   */
  async _stateResult(object, id) {
    const resp = await this._request(T.STATE, Buffer.alloc(0), undefined, { deadline: 3000 });
    if (resp.body.length !== 30) return undefined;
    const at = object === 1 ? 20 : 25;
    if (resp.body.readUInt32BE(at) !== id) return undefined;
    return resp.body[at + 4];
  }

  // ---------- 图片推送 ----------

  /**
   * 推送 PNG 到设备。成功 = 设备报告物理显示完成。
   * 并发：最多 2 个任务排队（对齐 Rust image_gate），实际上传串行化。
   * @param {Buffer} png
   * @param {1|2|4} format FORMAT.MONO / GRAY4 / GRAY16
   */
  async show(png, format = FORMAT.MONO) {
    if (!this.socket || this.closed) throw new ZectrixError('Disconnected', '连接已结束');
    if (this.captureId !== 0) throw new ZectrixError('Busy', '设备正在录音');
    if (this.imageGate >= 2) throw new ZectrixError('Busy', '图片任务已满');
    this.imageGate += 1;
    try {
      return await this._withLock('image', () => this._show(png, format));
    } finally {
      this.imageGate -= 1;
    }
  }

  async _show(png, format) {
    const data = await prepareImage(png, format, this.palette);
    const chunks = [];
    for (let offset = 0; offset < data.length; offset += IMAGE.chunk) {
      chunks.push(data.subarray(offset, offset + IMAGE.chunk));
    }
    if (chunks.length > 64) throw new ZectrixError('InvalidImage', '压缩后超过 64 块');

    // IMAGE_BEGIN：bpp + u16 压缩长度；本消息序号即图片 ID（控制序号，与播放 id 同域）
    const begin = Buffer.alloc(3);
    begin[0] = format;
    begin.writeUInt16BE(data.length, 1);
    const beginResp = await this._request(T.IMAGE_BEGIN, begin, this._nextControlSeq());
    const imageId = beginResp.sequence;

    let received = 0n;
    const all = chunks.length === 64 ? -1n : (1n << BigInt(chunks.length)) - 1n;
    const uploadDeadline = Date.now() + IMAGE.receiveDeadline;
    let refreshDeadline = 0;
    let refreshing = false;

    for (;;) {
      const stored = this.results.get(`1:${imageId}`);
      if (stored !== undefined) {
        if (stored === END.NORMAL) return;
        throw new ZectrixError('DeviceFailure', `设备报告图片失败（原因 ${stored}）`);
      }
      // 刷新阶段设备已在重绘，不再重发数据块
      if (!refreshing) {
        for (let i = 0; i < chunks.length; i++) {
          if ((received >> BigInt(i)) & 1n) continue;
          const body = Buffer.alloc(4 + chunks[i].length);
          body.writeUInt32BE(imageId, 0);
          chunks[i].copy(body, 4);
          await this._send(encodePacket(T.IMAGE_DATA, this.connection, i, body));
          await sleep(IMAGE.chunkInterval);
        }
      }
      // 轮询接收位图（Rust 侧 2s 超时，避免单次轮询吃掉整个期限）
      try {
        const statusResp = await this._request(T.IMAGE_STATUS, beU32(imageId), undefined, {
          deadline: IMAGE.statusTimeout,
        });
        if (statusResp.body.length === 10) {
          const { state, bitmap } = parseImageStatus(statusResp.body);
          received |= bitmap & all;
          if (state === IMG.DONE) return;
          if (state === IMG.FAILED) throw new ZectrixError('DeviceFailure', '设备报告图片失败');
          if (state === IMG.REFRESHING && !refreshing) {
            refreshing = true;
            refreshDeadline = Date.now() + IMAGE.refreshDeadline;
          }
        }
      } catch (err) {
        if (err instanceof ZectrixError && (err.kind === 'DeviceFailure' || err.kind === 'Disconnected')) throw err;
        // 轮询超时/结果未知：继续循环，由期限兜底
      }
      if (this.closed) throw new ZectrixError('Disconnected', '连接已结束');

      const limit = refreshing ? refreshDeadline : uploadDeadline;
      if (Date.now() >= limit) {
        // 查 STATE 做最终确认，不重建图片任务
        const reason = await this._stateResult(1, imageId).catch(() => undefined);
        if (reason === END.NORMAL) return;
        if (reason !== undefined) throw new ZectrixError('DeviceFailure', `设备报告图片失败（原因 ${reason}）`);
        throw new ZectrixError('ResultUnknown', '无法确认图片结果，请勿自动重推');
      }
      await sleep(IMAGE.pollInterval);
    }
  }

  // ---------- 音频播放 ----------

  /**
   * 播放 PCM16 16kHz 单声道音频。同一时刻只允许一路播放（对齐 Rust play_gate）。
   * @param {Int16Array|Buffer} pcm
   * @param {number} volume 0..100
   * @param {OpusCodec} [codec] 仅测试需要；默认复用客户端内的单例编码器
   * @returns {Promise<{end: 'Completed'|'Interrupted'|'Limit'|'Stopped', reason: number}>}
   */
  async play(pcm, volume = 65, codec) {
    if (!this.socket || this.closed) throw new ZectrixError('Disconnected', '连接已结束');
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new ZectrixError('InvalidOptions', '音量应为 0～100');
    }
    if (this.captureId !== 0) throw new ZectrixError('Busy', '设备正在录音');
    const frames = (codec ?? this._codecInstance()).encode(pcm);
    const vol = Math.round(volume);
    return this._withLock('play', async () => {
      if (this.closed) throw new ZectrixError('Disconnected', '连接已结束');
      if (this.captureId !== 0) throw new ZectrixError('Busy', '设备正在录音');
      const id = this._nextControlSeq();
      this.playbackId = id;
      try {
        return await this._stream(id, frames, vol);
      } finally {
        // 播放结束后清空，避免 stop() 误把已完成的流号当成当前播放
        if (this.playbackId === id) this.playbackId = 0;
      }
    });
  }

  /** 播放主体：BEGIN → 按 60ms 节拍发帧 → END → RESULT/STATE 确认 */
  async _stream(id, frames, vol) {
    const beginResp = await this._request(T.AUDIO_BEGIN, Buffer.from([vol]), id).catch((err) => {
      if (this.results.get(`2:${id}`) !== undefined) return null;
      throw err;
    });
    if (!beginResp) return this._playOutcome(this.results.get(`2:${id}`));

    const start = Date.now();
    for (let i = 0; i < frames.length; i++) {
      const due = start + i * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      else if (Date.now() - due > AUDIO.scheduleTolerance) {
        await this._sendStop(id); // 先让设备停下，再报错
        throw new ZectrixError('TransportFailure', '音频发送调度停顿');
      }
      const stored = this.results.get(`2:${id}`);
      if (stored !== undefined) return this._playOutcome(stored);
      if (this.stoppedPlay === id) return { end: 'Stopped', reason: END.NORMAL };
      const body = Buffer.alloc(4 + frames[i].length);
      body.writeUInt32BE(id, 0);
      frames[i].copy(body, 4);
      await this._send(encodePacket(T.AUDIO_DATA, this.connection, i, body));
    }

    const tail = OpusCodec.tailSamples(frames.length * 960);
    const endBody = Buffer.alloc(11);
    endBody.writeUInt32BE(id, 0);
    endBody.writeUInt32BE(frames.length, 4);
    endBody.writeUInt16BE(tail, 8);
    endBody[10] = END.NORMAL;
    try {
      await this._request(T.AUDIO_END, endBody, id);
    } catch (err) {
      const stored = this.results.get(`2:${id}`);
      if (stored !== undefined) return this._playOutcome(stored);
      throw err;
    }

    // RESULT 可能丢失：交替查询 RESULT 与 STATE（object=2），与 Rust 一致
    const deadline = Date.now() + AUDIO.resultDeadline;
    while (Date.now() < deadline) {
      const stored = this.results.get(`2:${id}`);
      if (stored !== undefined) return this._playOutcome(stored);
      if (this.stoppedPlay === id) return { end: 'Stopped', reason: END.NORMAL };
      const reason = await this._stateResult(2, id).catch(() => undefined);
      if (reason !== undefined) return this._playOutcome(reason);
      await sleep(AUDIO.pollInterval);
    }
    throw new ZectrixError('ResultUnknown', '无法确认播放结果');
  }

  _playOutcome(reason) {
    if (reason === END.NORMAL) return { end: 'Completed', reason };
    if (reason === END.INTERRUPTED) return { end: 'Interrupted', reason };
    if (reason === END.LIMIT) return { end: 'Limit', reason };
    throw new ZectrixError('DeviceFailure', `设备报告播放失败（原因 ${reason}）`);
  }

  /** 停止当前播放或录音；返回被停止的流号（0 表示当前没有可停止的目标） */
  async stop() {
    const id = this.captureId || this.playbackId;
    if (!id) return 0;
    if (this.captureId) this.stoppedCapture = id;
    else this.stoppedPlay = id;
    await this._sendStop(id);
    return id;
  }

  async _sendStop(id) {
    try {
      await this._request(T.AUDIO_STOP, beU32(id), this._nextControlSeq());
    } catch (err) {
      // ResultUnknown 视为已尽力（与 Rust 一致，不因停止确认丢失而报错）
      if (err instanceof ZectrixError && err.kind !== 'ResultUnknown' && err.kind !== 'Disconnected') throw err;
    }
  }

  // ---------- 设备→PC 录音 ----------

  _handleIncomingAudio(p) {
    const id = p.kind === T.AUDIO_BEGIN ? p.sequence : p.body.readUInt32BE(0);
    // 过旧/非法的流号直接丢弃（对齐 Rust 的 ended / 当前 id 比较规则）
    if (id === 0 || id <= this.endedRecordingId) return;
    if (this.captureId && id < this.captureId) return;

    if (p.kind === T.AUDIO_BEGIN) {
      if (this.recordings.has(id)) return;
      // 换流：上一段未完成的录音以 Failed 收尾
      for (const other of [...this.recordings.keys()]) {
        if (other !== id) this._finalizeRecording(other, 'Failed');
      }
      this.recordings.set(id, new RecordingAssembler(id, this._codecInstance()));
      this.captureId = id;
      if (this.playbackId) this.results.set(`2:${this.playbackId}`, END.INTERRUPTED);
      this._emitEvent({ type: 'recordingStarted', id });
      return;
    }

    if (!this.recordings.has(id)) {
      // 首包即 AUDIO_END：建立临时重组器，只发 Finished（与 Rust 一致）
      if (p.kind !== T.AUDIO_END) return;
      // 与 AUDIO_BEGIN 一致：换流时上一段未完成的录音以 Failed 收尾，避免两段并存
      for (const other of [...this.recordings.keys()]) {
        if (other !== id) this._finalizeRecording(other, 'Failed');
      }
      this.recordings.set(id, new RecordingAssembler(id, this._codecInstance()));
      this.captureId = id;
    }
    const rec = this.recordings.get(id);
    try {
      if (p.kind === T.AUDIO_DATA) rec.push(p.sequence, p.body.subarray(4));
      else rec.ending(p.body.readUInt32BE(4), p.body.readUInt16BE(8), recordingReason(p.body[10]));
    } catch {
      // 单帧/单包异常不影响整段录音；由看门狗按超时收尾
    }
  }

  /** 录音看门狗：收齐即收尾；无进展 3s / 总长 125s 判失败（对齐 Rust receive tick） */
  _tickRecording() {
    if (!this.recordings.size) return;
    for (const rec of [...this.recordings.values()]) {
      try {
        if (rec.end) {
          const age = Date.now() - rec.end.at;
          // 还有缓冲帧时先等在途帧（最多到进展超时），避免把晚到的乱序帧当成丢包
          const force = age >= RECORDING.endGrace && (rec.frames.size === 0 || age >= RECORDING.progressTimeout);
          rec.drain(force);
          if (rec.complete) { this._finalizeRecording(rec.id); continue; }
          if (age >= RECORDING.progressTimeout) this._finalizeRecording(rec.id, 'Failed');
        } else if (
          Date.now() - rec.progressAt >= RECORDING.progressTimeout ||
          Date.now() - rec.startedAt >= RECORDING.totalTimeout
        ) {
          this._finalizeRecording(rec.id, 'Failed');
        }
      } catch {
        this._finalizeRecording(rec.id, 'Failed');
      }
    }
  }

  _finalizeRecording(id, fallback = 'Failed') {
    const rec = this.recordings.get(id);
    if (!rec) return;
    this.recordings.delete(id);
    this.endedRecordingId = Math.max(this.endedRecordingId, id);
    if (this.captureId === id) this.captureId = 0;
    let out;
    try {
      out = rec.finish(fallback);
    } catch {
      out = { audio: null, reason: 'Failed' };
    }
    const reason = this.stoppedCapture === id ? 'Stopped' : out.reason;
    if (this.stoppedCapture === id) this.stoppedCapture = 0;
    this._emitEvent({ type: 'recordingFinished', id, audio: out.audio, reason, lostFrames: out.lostFrames ?? 0 });
    this.emit('recording', { id, audio: out.audio, reason, lostFrames: out.lostFrames ?? 0 });
  }

  /** 编解码器单例：Opus 实例承载 WASM 堆，避免每次播放/录音重新分配 */
  _codecInstance() {
    if (!this._codec) this._codec = new OpusCodec();
    return this._codec;
  }
}

/** 设备地址解析：字面 IPv4 直接使用，主机名走 DNS（接收侧按解析结果过滤来源） */
async function resolvePeer(host) {
  if (net.isIP(host) === 4) return host;
  if (net.isIP(host) === 6) throw new ZectrixError('InvalidOptions', '仅支持 IPv4 设备地址');
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    return address;
  } catch {
    throw new ZectrixError('TransportFailure', `无法解析设备地址 ${host}`);
  }
}

function beU32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeReasonName(n) {
  return ['Closed', 'DeviceExit', 'Timeout', 'Network', 'System', 'Failed'][n] ?? 'Failed';
}

/** 录音结束原因：与 audio.rs rec_reason 一致，仅 0=Completed / 6=Limit，其余 Failed */
function recordingReason(n) {
  if (n === END.NORMAL) return 'Completed';
  if (n === END.LIMIT) return 'Limit';
  return 'Failed';
}

export { FORMAT };
