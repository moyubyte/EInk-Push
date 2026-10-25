// Zectrix LAN v1 线协议编解码。
// 与 Rust SDK (src/protocol.rs) 及 docs/zectrix-lan-v1.html 第 03/04 节逐字节对齐。
//
// 报文布局（16 字节公共头 + 负载，网络字节序）：
//   magic(2)='ZL'  version(1)=1  type(1)  connection_id(8, BE)  sequence(4, BE)  body
// 数据报总长 16..=1200 字节；响应 = 请求 type | 0x80，回显 sequence 与 connection_id。

export const HEADER_SIZE = 16;
export const MAX_DATAGRAM = 1200;
export const MAX_BODY = MAX_DATAGRAM - HEADER_SIZE; // 1184

/** 消息类型（协议第 03 节） */
export const T = {
  INFO: 1,
  CONNECT: 2,
  PING: 3,
  CLOSE: 4,
  IMAGE_BEGIN: 5,
  IMAGE_DATA: 6,
  IMAGE_STATUS: 7,
  AUDIO_BEGIN: 8,
  AUDIO_DATA: 9,
  AUDIO_END: 10,
  AUDIO_STOP: 11,
  STATE: 12,
  RESULT: 13,
  KEY: 14,
  STATUS: 15,
  PALETTE: 16,
};

/** 响应结果码（协议第 04 节） */
export const R = { OK: 0, BUSY: 1, INVALID: 2, STALE: 3, FAILED: 4, OLD_REQUEST: 5 };

/** 结束原因编码（CLOSE / AUDIO_END / RESULT 共用） */
export const END = {
  NORMAL: 0,
  DEVICE_EXIT: 1,
  KEEPALIVE_TIMEOUT: 2,
  NETWORK: 3,
  SYSTEM: 4,
  INTERRUPTED: 5,
  LIMIT: 6,
  FAILED: 7,
};

export const IMG = { NONE: 0, RECEIVING: 1, REFRESHING: 2, DONE: 3, FAILED: 4 };

/** 与 Rust SDK Error 一一对应的业务错误；kind 用于程序化处理 */
export class ZectrixError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ZectrixError';
    this.kind = kind;
  }
}

export function encodePacket(kind, connection, sequence, body = Buffer.alloc(0)) {
  if (body.length > MAX_BODY) throw new ZectrixError('InvalidOptions', '负载超过 1184 字节');
  const buf = Buffer.alloc(HEADER_SIZE + body.length);
  buf[0] = 0x5a;
  buf[1] = 0x4c;
  buf[2] = 1;
  buf[3] = kind;
  buf.writeBigUInt64BE(BigInt(connection), 4);
  buf.writeUInt32BE(typeof sequence === 'bigint' ? Number(sequence) : sequence >>> 0, 12);
  body.copy(buf, HEADER_SIZE);
  return buf;
}

export function decodePacket(buf) {
  if (buf.length < HEADER_SIZE || buf.length > MAX_DATAGRAM) return null;
  if (buf[0] !== 0x5a || buf[1] !== 0x4c || buf[2] !== 1) return null;
  return {
    kind: buf[3],
    connection: buf.readBigUInt64BE(4),
    sequence: buf.readUInt32BE(12),
    body: buf.subarray(HEADER_SIZE),
  };
}

/** 响应负载首字节结果码 → 业务错误（对齐 protocol.rs code()） */
export function checkCode(body) {
  switch (body[0]) {
    case R.OK:
      return;
    case R.BUSY:
      throw new ZectrixError('Busy', '设备忙碌，请稍后重试');
    case R.STALE:
      throw new ZectrixError('Disconnected', '连接已失效');
    case R.FAILED:
      throw new ZectrixError('DeviceFailure', '设备处理失败');
    case R.INVALID:
      throw new ZectrixError('InvalidOptions', '设备拒绝了请求参数或图片格式');
    case R.OLD_REQUEST:
      throw new ZectrixError('ResultUnknown', '旧请求被拒绝，结果未知');
    default:
      throw new ZectrixError('TransportFailure', '响应格式错误');
  }
}

/**
 * 解析 INFO 响应（协议第 03 节固定布局）。
 * body: [code, busy, idLen, id..., modelLen, model..., w u16, h u16, 提示区 x/y/w/h 各 u16]
 * 连接编号取响应头（设备当前值），必须非零。
 */
export function parseInfo(packet, address) {
  const b = packet.body;
  checkCode(b);
  if (packet.connection === 0n || b.length < 3) throw new ZectrixError('TransportFailure', '设备信息无效');
  const idLen = b[2];
  const id = b.subarray(3, 3 + idLen).toString('ascii');
  const modelLen = b[3 + idLen];
  const model = b.subarray(4 + idLen, 4 + idLen + modelLen).toString('utf8');
  const dims = b.subarray(4 + idLen + modelLen);
  // 当前固件开放完整 400x300 画布，保留区为 0,0,0,0；旧固件布局直接拒绝
  const expected = Buffer.from([1, 144, 1, 44, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (dims.length !== 12 || !dims.equals(expected)) {
    throw new ZectrixError('InvalidOptions', '需要支持 400×300 完整画布的固件，请配套升级固件');
  }
  return { id, model, address, busy: b[1] !== 0 };
}

/** 解析 STATUS 响应：[code, battery, charging, rssi(i8)]，255/127 表示未知 */
export function parseStatus(body) {
  checkCode(body);
  if (body.length !== 4) throw new ZectrixError('TransportFailure', '设备状态响应无效');
  const [_, battery, charging, rssi] = body;
  if (!(battery <= 100 || battery === 255)) throw new ZectrixError('TransportFailure', '电量值非法');
  if (!(charging <= 1 || charging === 255)) throw new ZectrixError('TransportFailure', '充电状态非法');
  const signed = rssi > 127 ? rssi - 256 : rssi;
  if (!(signed >= -127 && signed <= 0) && signed !== 127) {
    throw new ZectrixError('TransportFailure', 'RSSI 值非法');
  }
  return {
    batteryPercent: battery <= 100 ? battery : null,
    charging: charging <= 1 ? charging === 1 : null,
    wifiRssiDbm: signed === 127 ? null : signed,
  };
}

/**
 * 解析 PALETTE 响应：21 字节 [code, gray4[4], gray16[16]]。
 * 首项必须为 0、末项必须为 255、非递减；允许重复亮度。
 */
export function parsePalette(body) {
  checkCode(body);
  if (body.length !== 21) throw new ZectrixError('TransportFailure', '设备色板无效：需要 21 字节响应');
  const gray4 = [...body.subarray(1, 5)];
  const gray16 = [...body.subarray(5, 21)];
  const valid = (v) => v[0] === 0 && v[v.length - 1] === 255 && v.every((x, i) => i === 0 || v[i - 1] <= x);
  if (!valid(gray4) || !valid(gray16)) {
    throw new ZectrixError('TransportFailure', '设备色板非法：需要非递减的 0～255 亮度');
  }
  return { gray4, gray16 };
}

/** IMAGE_STATUS 响应：[code, state, 接收位图 u64 BE]，共 10 字节 */
export function parseImageStatus(body) {
  checkCode(body);
  if (body.length !== 10) throw new ZectrixError('TransportFailure', '图片状态响应无效');
  return {
    state: body[1],
    bitmap: body.readBigUInt64BE(2),
  };
}

/** KEY 事件负载：[key(1上/2下/3确认), action(1短按/2长按)] */
export const KEY = { UP: 1, DOWN: 2, CONFIRM: 3 };
export const ACTION = { SHORT: 1, LONG: 2 };

export function keyName(k) {
  return k === KEY.UP ? 'up' : k === KEY.DOWN ? 'down' : 'confirm';
}
export function actionName(a) {
  return a === ACTION.SHORT ? 'short' : 'long';
}
