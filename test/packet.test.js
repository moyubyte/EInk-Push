// 协议编解码 golden 测试：与 Rust SDK src/protocol.rs 的 #[cfg(test)] 用例逐字节对齐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  T, R, END,
  encodePacket, decodePacket, checkCode,
  parseInfo, parseStatus, parsePalette, parseImageStatus,
  ZectrixError,
} from '../src/packet.js';

test('报文头 golden 向量（与 Rust header_is_network_order_golden 一致）', () => {
  // 注意用 BigInt 字面量：0x0102030405060708 超过 Number.MAX_SAFE_INTEGER，
  // 真实场景中 connection_id 始终以 BigInt 传递（来自 readBigUInt64BE）
  const p = encodePacket(14, 0x0102030405060708n, 0x090a0b0cn, Buffer.from([3, 1]));
  assert.deepEqual(
    [...p],
    [0x5a, 0x4c, 1, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 3, 1],
  );
});

test('畸形数据报拒绝（与 Rust malformed_datagrams_are_rejected 一致）', () => {
  for (let n = 0; n < 16; n++) {
    assert.equal(decodePacket(Buffer.alloc(n)), null);
  }
  const p = encodePacket(T.INFO, 0, 1);
  const badVersion = Buffer.from(p);
  badVersion[2] = 2;
  assert.equal(decodePacket(badVersion), null);
  assert.equal(decodePacket(Buffer.alloc(1201)), null);
  // 恰好 16 字节（空负载）与恰好 1200 字节合法
  assert.ok(decodePacket(encodePacket(T.PING, 1, 1)));
  assert.ok(decodePacket(encodePacket(T.PING, 1, 1, Buffer.alloc(1184))));
  assert.throws(() => encodePacket(T.PING, 1, 1, Buffer.alloc(1185)), ZectrixError);
});
test('结果码映射（与 Rust code() 一致）', () => {
  assert.equal(checkCode(Buffer.from([R.OK])), undefined);
  assert.throws(() => checkCode(Buffer.from([R.BUSY])), (e) => e instanceof ZectrixError && e.kind === 'Busy');
  assert.throws(() => checkCode(Buffer.from([R.STALE])), (e) => e.kind === 'Disconnected');
  assert.throws(() => checkCode(Buffer.from([R.FAILED])), (e) => e.kind === 'DeviceFailure');
  assert.throws(() => checkCode(Buffer.from([R.INVALID])), (e) => e.kind === 'InvalidOptions');
  assert.throws(() => checkCode(Buffer.from([R.OLD_REQUEST])), (e) => e.kind === 'ResultUnknown');
  assert.throws(() => checkCode(Buffer.from([9])), (e) => e.kind === 'TransportFailure');
});

test('STATUS 解析（与 Rust status_values_preserve_zero_false_and_signed_rssi 一致）', () => {
  assert.deepEqual(parseStatus(Buffer.from([0, 0, 0, 129])), {
    batteryPercent: 0, charging: false, wifiRssiDbm: -127,
  });
  assert.deepEqual(parseStatus(Buffer.from([0, 100, 1, 0])), {
    batteryPercent: 100, charging: true, wifiRssiDbm: 0,
  });
  assert.deepEqual(parseStatus(Buffer.from([0, 255, 255, 127])), {
    batteryPercent: null, charging: null, wifiRssiDbm: null,
  });
  for (const body of [[], [0], [0, 1, 0], [0, 1, 0, 195, 0], [0, 101, 0, 195], [0, 50, 2, 195], [0, 50, 0, 1], [0, 50, 0, 128]]) {
    assert.throws(() => parseStatus(Buffer.from(body)), ZectrixError, `body=${body}`);
  }
});

test('PALETTE 解析（与 Rust palette_layout 用例一致）', () => {
  const body = Buffer.from([0, 0, 40, 180, 255, 0, 9, 9, 30, 50, 70, 90, 100, 130, 150, 170, 190, 210, 225, 240, 255]);
  const palette = parsePalette(body);
  assert.deepEqual(palette.gray4, [0, 40, 180, 255]);
  assert.equal(palette.gray16[1], palette.gray16[2]); // 允许重复亮度
  for (const position of [1, 4, 5, 20]) {
    const bad = Buffer.from(body);
    bad[position] ^= 1;
    assert.throws(() => parsePalette(bad), ZectrixError, `position=${position}`);
  }
  const tooLong = Buffer.concat([body, Buffer.from([0])]);
  assert.throws(() => parsePalette(tooLong));
  const tooShort = body.subarray(0, 20);
  assert.throws(() => parsePalette(tooShort));
  assert.throws(() => parsePalette(Buffer.from([4])), (e) => e.kind === 'DeviceFailure');
});

test('INFO 解析（与 Rust full_canvas_info 用例一致）', () => {
  const body = Buffer.from([0, 0, 12]);
  const idAndModel = Buffer.concat([body, Buffer.from('112233aabbcc'), Buffer.from([4]), Buffer.from('test')]);
  const full = Buffer.concat([idAndModel, Buffer.from([1, 144, 1, 44, 0, 0, 0, 0, 0, 0, 0, 0])]);
  const packet = { kind: T.INFO | 0x80, connection: 1n, sequence: 1, body: full };
  assert.equal(parseInfo(packet, '127.0.0.1').id, '112233aabbcc');
  const legacy = Buffer.concat([idAndModel, Buffer.from([1, 144, 1, 44, 0, 0, 0, 0, 1, 144, 0, 32])]);
  assert.throws(
    () => parseInfo({ kind: T.INFO | 0x80, connection: 1n, sequence: 1, body: legacy }, '127.0.0.1'),
    (e) => e.kind === 'InvalidOptions',
  );
});

test('IMAGE_STATUS 解析', () => {
  const body = Buffer.alloc(10);
  body[1] = 2; // REFRESHING
  body.writeBigUInt64BE(0b101n, 2);
  assert.deepEqual(parseImageStatus(body), { state: 2, bitmap: 0b101n });
  assert.throws(() => parseImageStatus(Buffer.alloc(9)));
});

test('结束原因编码齐全', () => {
  assert.equal(END.NORMAL, 0);
  assert.equal(END.INTERRUPTED, 5);
  assert.equal(END.LIMIT, 6);
  assert.equal(END.FAILED, 7);
});
