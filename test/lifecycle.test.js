// 生命周期与异常路径测试：覆盖审计中发现的 P0/P1 缺陷，防止回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { ZectrixClient } from '../src/client.js';
import { FORMAT } from '../src/image.js';
import { OpusCodec } from '../src/audio.js';
import { T, END, encodePacket } from '../src/packet.js';

const png = () =>
  sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .png()
    .toBuffer();

/** 以设备身份向客户端发一个包（复用 MockDevice 记录的客户端端点） */
function sender(device) {
  return (kind, seq, body) =>
    new Promise((resolve) =>
      device.socket.send(
        encodePacket(kind, device.connectionId, seq, body),
        device._lastClientPort,
        '127.0.0.1',
        resolve,
      ));
}

function rms(audio, from, to) {
  let energy = 0;
  for (let i = from; i < to; i++) energy += audio[i] * audio[i];
  return Math.sqrt(energy / (to - from));
}

test('close() 必须真正向设备发送 CLOSE（释放管理权）', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  await client.open();
  assert.equal(device.closed, false);
  await client.close();
  assert.equal(device.closed, true, '设备应收到 CLOSE');
  assert.equal(client.closed, true);
  device.stop();
});

test('close() 之后可以重新 open()，事件流继续可用', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  try {
    await client.open();
    await client.close();
    await client.open();
    assert.equal(client.closed, false);
    assert.equal(client.ended, false);
    const eventPromise = client.nextEvent();
    device.sendKey(3, 1);
    const event = await eventPromise;
    assert.deepEqual(event, { type: 'key', key: 'confirm', action: 'short' });
  } finally {
    await client.close().catch(() => {});
    device.stop();
  }
});

test('设备主机名可直接使用（DNS 解析后按 IP 过滤来源）', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`localhost:${port}`);
  try {
    await client.open();
    assert.equal(client.peerIp, '127.0.0.1');
    // PING 使用独立递增序号（与 Rust Wire::ping 一致），不能固定为 1
    const before = client.pingSeq;
    await client._heartbeat();
    await client._heartbeat();
    assert.equal(client.pingSeq, before + 2);
    const eventPromise = client.nextEvent();
    device.sendKey(1, 1);
    assert.equal((await eventPromise).key, 'up');
  } finally {
    await client.close().catch(() => {});
    device.stop();
  }
});

test('AUDIO_END 丢失时录音状态自动释放，不再永久占用设备', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  const codec = new OpusCodec();
  const send = sender(device);
  try {
    await client.open();
    const frames = codec.encode(new Int16Array(960).fill(800));
    const started = client.nextEvent();
    await send(T.AUDIO_BEGIN, 55, Buffer.from([0]));
    assert.equal((await started).type, 'recordingStarted');
    const finished = client.nextEvent();
    const body = Buffer.alloc(4 + frames[0].length);
    body.writeUInt32BE(55, 0);
    frames[0].copy(body, 4);
    await send(T.AUDIO_DATA, 0, body);

    // 不发 AUDIO_END：看门狗应在 3s 无进展后收尾
    const event = await finished;
    assert.equal(event.type, 'recordingFinished');
    assert.equal(event.reason, 'Failed');
    assert.equal(client.captureId, 0, 'captureId 必须归零');

    // 录音占用解除后，图片推送应立刻可用
    await client.show(await png(), FORMAT.MONO);
  } finally {
    await client.close().catch(() => {});
    device.stop();
  }
});

test('迟到的乱序帧不会被丢弃（收齐后收尾而非固定 360ms 截断）', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  const codec = new OpusCodec();
  const send = sender(device);
  try {
    await client.open();
    // 帧 0 静音、帧 1 强信号、帧 2 静音
    const samples = new Int16Array(2880);
    for (let i = 960; i < 1920; i++) samples[i] = Math.round(Math.sin(i * 0.2) * 12000);
    const frames = codec.encode(samples);

    const started = client.nextEvent();
    await send(T.AUDIO_BEGIN, 99, Buffer.from([0]));
    await started;
    const finished = client.nextEvent();

    for (const i of [0, 2]) {
      const b = Buffer.alloc(4 + frames[i].length);
      b.writeUInt32BE(99, 0);
      frames[i].copy(b, 4);
      await send(T.AUDIO_DATA, i, b);
    }
    const end = Buffer.alloc(11);
    end.writeUInt32BE(99, 0);
    end.writeUInt32BE(3, 4);
    end.writeUInt16BE(960, 8);
    end[10] = END.NORMAL;
    await send(T.AUDIO_END, 2, end);

    // 第 2 帧 600ms 后才到（超过旧的 360ms 固定收尾点）
    setTimeout(() => {
      const b = Buffer.alloc(4 + frames[1].length);
      b.writeUInt32BE(99, 0);
      frames[1].copy(b, 4);
      send(T.AUDIO_DATA, 1, b);
    }, 600);

    const event = await finished;
    assert.equal(event.audio.length, 2880);
    assert.ok(rms(event.audio, 960, 1920) > 1000, `迟到帧内容应被保留，实际 RMS=${rms(event.audio, 960, 1920)}`);
    assert.equal(event.reason, 'Completed');
  } finally {
    await client.close().catch(() => {});
    device.stop();
  }
});

test('RESULT 丢失时通过 STATE 回退确认播放完成', { timeout: 20000 }, async () => {
  const device = new MockDevice({ suppressResult: true });
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  const codec = new OpusCodec();
  try {
    await client.open();
    const started = Date.now();
    const result = await client.play(new Int16Array(960).fill(2000), 60, codec);
    assert.equal(result.end, 'Completed');
    assert.ok(Date.now() - started < 6000, '不应退化到 15s 超时');
  } finally {
    await client.close().catch(() => {});
    device.stop();
  }
});

test('连续两段帧数相同的录音都能正常收尾（END 不按帧号去重）', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  const codec = new OpusCodec();
  try {
    await client.open();
    // AUDIO_END 的 sequence 是末帧号，两段单帧录音都是 0：若按 (kind, seq) 去重，
    // 第二段的 END 会被当成重复包丢弃，只能等 3s 看门狗判 Failed 并补出 2000 帧静音
    for (const id of [201, 202]) {
      const frames = codec.encode(new Int16Array(960).fill(1500));
      const events = [];
      const collecting = (async () => {
        for (;;) {
          const e = await client.nextEvent();
          if (!e) return;
          events.push(e);
          if (e.type === 'recordingFinished') return;
        }
      })();
      await device.sendRecording(id, frames, 960, END.NORMAL);
      await collecting;
      const finished = events.find((e) => e.type === 'recordingFinished');
      assert.equal(finished.id, id);
      assert.equal(finished.audio.length, 960, `第 ${id} 段应为 960 样本，实际 ${finished.audio.length}`);
      assert.equal(finished.reason, 'Completed');
    }
  } finally {
    await client.close().catch(() => {});
    device.stop();
  }
});

test('未连接时 show/play 抛 Disconnected，而不是类型错误', { timeout: 10000 }, async () => {
  const client = new ZectrixClient('127.0.0.1:1');
  const image = await png();
  await assert.rejects(() => client.show(image, FORMAT.GRAY4), (err) => {
    assert.equal(err.kind, 'Disconnected');
    return true;
  });
  await assert.rejects(() => client.play(new Int16Array(960)), (err) => {
    assert.equal(err.kind, 'Disconnected');
    return true;
  });
});
