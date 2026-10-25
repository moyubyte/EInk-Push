// 音频编解码测试：与 Rust SDK src/audio.rs 的 #[cfg(test)] 用例对齐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpusCodec, RecordingAssembler, MAX_SAMPLES, FRAME_SAMPLES } from '../src/audio.js';
import { ZectrixError } from '../src/packet.js';

const codec = new OpusCodec();

test('PCM → Opus 分帧：960 样本/帧，每帧 ≤1180 字节', () => {
  const samples = new Int16Array(1083);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.2) * 8000);
  const frames = codec.encode(samples);
  assert.equal(frames.length, 2);
  for (const f of frames) assert.ok(f.length > 0 && f.length <= 1180);
});

test('乱序帧 + 部分尾帧重组（与 Rust reordered_audio_and_partial_tail 一致）', () => {
  const samples = new Int16Array(1083);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.2) * 8000);
  const frames = codec.encode(samples);
  const rec = new RecordingAssembler(9, codec);
  rec.push(1, frames[1]);
  rec.push(0, frames[0]);
  rec.ending(2, 123, 'Completed');
  rec.drain(false);
  const { audio, reason } = rec.finish('Failed');
  assert.equal(reason, 'Completed');
  assert.equal(audio.length, 1083);
  // Opus 有损且带编解码延迟，不逐点比对；确认非静音、能量守恒
  let energy = 0;
  for (const v of audio) energy += v * v;
  assert.ok(Math.sqrt(energy / audio.length) > 1000, '解码结果不应为静音');
});

test('丢帧隐藏补偿（与 Rust missing_frame_is_concealed_at_end 一致）', () => {
  const samples = new Int16Array(1920).fill(300);
  const frames = codec.encode(samples);
  const rec = new RecordingAssembler(1, codec);
  rec.push(1, frames[1]); // 帧 0 丢失
  rec.ending(2, 960, 'Completed');
  const { audio } = rec.finish('Failed');
  assert.equal(audio.length, 1920);
  assert.equal(audio[0], 0); // 丢包补偿为静音
});

test('零帧录音不生成音频（与 Rust zero_frame_has_no_audio 一致）', () => {
  const rec = new RecordingAssembler(1, codec);
  rec.ending(0, 0, 'Completed');
  rec.drain(true);
  const { audio } = rec.finish('Failed');
  assert.equal(audio, null);
});

test('超过 120 秒被拒绝（与 Rust oversized_audio_is_rejected 一致）', () => {
  assert.throws(
    () => codec.encode(new Int16Array(MAX_SAMPLES + 1)),
    (e) => e instanceof ZectrixError && e.kind === 'AudioTooLong',
  );
});

test('Opus 编解码往返：960 样本帧长守恒', () => {
  const pcm = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((i / FRAME_SAMPLES) * Math.PI * 8) * 10000);
  const [frame] = codec.encode(pcm);
  const back = codec.decode(frame);
  assert.equal(back.length, FRAME_SAMPLES);
});
