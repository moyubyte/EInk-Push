// 客户端集成测试：MockDevice 实现协议另一端，验证完整业务流程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { ZectrixClient } from '../src/client.js';
import { FORMAT } from '../src/image.js';
import { KEY, ACTION, END } from '../src/packet.js';
import { OpusCodec } from '../src/audio.js';

async function testPng() {
  const raw = Buffer.alloc(400 * 300 * 3);
  for (let i = 0; i < 400 * 300; i++) {
    raw[i * 3] = 60; raw[i * 3 + 1] = 120; raw[i * 3 + 2] = 200;
  }
  return sharp(raw, { raw: { width: 400, height: 300, channels: 3 } }).png().toBuffer();
}

test('完整连接握手：INFO → CONNECT → PALETTE', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`, { clientName: '测试NAS' });
  try {
    await client.open();
    assert.equal(client.summary.id, 'aabbccddeeff');
    assert.equal(client.summary.model, 'zectrix-s3-epaper-4.2');
    assert.deepEqual(client.palette.gray4, [0, 85, 170, 255]);
    assert.equal(client.connection > 0n, true);
  } finally {
    await client.close();
    device.stop();
  }
});

test('STATUS 查询', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  try {
    await client.open();
    const status = await client.status();
    assert.deepEqual(status, { batteryPercent: 87, charging: true, wifiRssiDbm: -45 });
  } finally {
    await client.close();
    device.stop();
  }
});

test('图片推送：丢块补传 + IMAGE_STATUS 位图 + RESULT 确认', { timeout: 20000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: true });
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  try {
    await client.open();
    const png = await testPng();
    const started = Date.now();
    await client.show(png, FORMAT.GRAY4);
    assert.ok(Date.now() - started < 10000, '推送应在 10 秒内完成');
    // 模拟设备确认收到了完整图片（含被补传的块 0）
    const image = [...device.images.values()][0];
    assert.ok(image, '设备应收到 IMAGE_BEGIN');
    assert.ok(image.chunks.has(0), '被丢弃的块 0 应被补传');
    const expectedChunks = Math.ceil(image.totalLen / 1024);
    assert.equal(image.chunks.size, expectedChunks, `应收到全部 ${expectedChunks} 块，实际 ${image.chunks.size}`);
  } finally {
    await client.close();
    device.stop();
  }
});

test('按键事件经 ACK + 去重后交付', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  try {
    await client.open();
    const eventPromise = client.nextEvent();
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    const event = await eventPromise;
    assert.deepEqual(event, { type: 'key', key: 'confirm', action: 'short' });
  } finally {
    await client.close();
    device.stop();
  }
});

test('设备录音上行：重组为完整 PCM', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  const codec = new OpusCodec();
  try {
    await client.open();
    const samples = new Int16Array(1500);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.3) * 9000);
    const frames = codec.encode(samples); // 2 帧
    const started = client.nextEvent();
    const finished = client.nextEvent();
    await device.sendRecording(42, frames, 540, END.NORMAL);
    const first = await started;
    assert.equal(first.type, 'recordingStarted');
    const second = await finished;
    assert.equal(second.type, 'recordingFinished');
    assert.equal(second.audio.length, 1500, `重组样本数应为 1500，实际 ${second.audio.length}`);
    assert.equal(second.reason, 'Completed');
  } finally {
    await client.close();
    device.stop();
  }
});

test('音频播放：AUDIO_BEGIN/DATA/END + RESULT 结束', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  const codec = new OpusCodec();
  try {
    await client.open();
    const samples = new Int16Array(4800); // 300ms
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.1) * 6000);
    const result = await client.play(samples, 70, codec);
    assert.equal(result.end, 'Completed');
    const stream = [...device.streams.values()][0];
    assert.ok(stream && stream.frames.size === 5, `设备应收到 5 帧，实际 ${stream?.frames.size}`);
  } finally {
    await client.close();
    device.stop();
  }
});

test('设备主动 CLOSE：客户端进入终态并交付 disconnected', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  await client.open();
  const eventPromise = client.nextEvent();
  // 模拟设备长按退出：发送 CLOSE（原因 1=设备主动退出）
  device.socket.send(
    (await import('../src/packet.js')).encodePacket(4, device.connectionId, 5, Buffer.from([END.DEVICE_EXIT])),
    device._lastClientPort,
    '127.0.0.1',
  );
  const event = await eventPromise;
  assert.equal(event.type, 'disconnected');
  assert.equal(event.reason, 'DeviceExit');
  assert.equal(client.closed, true);
  device.stop();
});
