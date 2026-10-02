import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSegmenter, parseVoiceTranscript, updateVoiceDraft, wavBlob } from '../public/voice-activity.js';

test('voice pauses keep a draft until an explicit send command', () => {
  assert.deepEqual(parseVoiceTranscript('まずこの画面の'), { content: 'まずこの画面の', send: false });
  assert.deepEqual(parseVoiceTranscript('色を変えてください。'), { content: '色を変えてください。', send: false });
  assert.deepEqual(parseVoiceTranscript('送信。'), { content: '', send: true });
  assert.deepEqual(parseVoiceTranscript('ボタンを変えて、送信。'), { content: 'ボタンを変えて', send: true });
  assert.deepEqual(parseVoiceTranscript('送信ボタンを追加して。'), { content: '送信ボタンを追加して。', send: false });
  assert.deepEqual(parseVoiceTranscript('未送信'), { content: '未送信', send: false });
  const first = updateVoiceDraft('', 'まずこの画面の');
  assert.deepEqual(first, { draft: 'まずこの画面の', send: false });
  const second = updateVoiceDraft(first.draft, '色を変えてください。');
  assert.deepEqual(second, { draft: 'まずこの画面の\n色を変えてください。', send: false });
  assert.deepEqual(updateVoiceDraft(second.draft, '送信。'), { draft: second.draft, send: true });
});

test('continuous listening ignores idle noise and splits speech after a pause', () => {
  const detector = new VoiceSegmenter(1000);
  const quiet = new Float32Array(100).fill(0.002);
  const speech = new Float32Array(100).fill(0.08);
  for (let i = 0; i < 30; i++) assert.equal(detector.push(quiet).audio, null);
  assert.equal(detector.push(speech).started, false);
  assert.equal(detector.push(speech).started, true);
  for (let i = 0; i < 5; i++) assert.equal(detector.push(speech).audio, null);
  for (let i = 0; i < 10; i++) assert.equal(detector.push(quiet).audio, null);
  const first = detector.push(quiet).audio;
  assert.ok(first instanceof Float32Array);
  assert.ok(first.some(sample => sample > 0.07));
  assert.equal(detector.active, false);
  assert.equal(detector.push(speech).audio, null);
  assert.equal(detector.push(speech).started, true);
});

test('a long utterance is capped and encoded as mono 16 kHz WAV', async () => {
  const detector = new VoiceSegmenter(1000, { maxDurationMs: 600 });
  const speech = new Float32Array(100).fill(0.1);
  let segment;
  for (let i = 0; i < 8; i++) segment = detector.push(speech).audio || segment;
  assert.ok(segment);
  const blob = wavBlob(segment, 1000);
  const bytes = new DataView(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/wav');
  assert.equal(bytes.getUint32(24, true), 1000);
  assert.equal(bytes.getUint16(22, true), 1);
  assert.equal(bytes.getUint32(40, true), segment.length * 2);
  const downsampled = new DataView(await wavBlob(new Float32Array(48000).fill(0.1), 48000).arrayBuffer());
  assert.equal(downsampled.getUint32(24, true), 16000);
  assert.equal(downsampled.getUint32(40, true), 16000 * 2);
});
