import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInt16Interleaved, fromInt16Interleaved, encodeWav, mix, computePeaks } from '../src/wav.js';

test('int16 round trip stays within one quantisation step and clips', () => {
  const l = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.7]);
  const r = Float32Array.from([0.25, -0.25, 0.999, -0.999, 0, -3]);
  const pcm = toInt16Interleaved(l, r);
  assert.deepEqual([pcm[0], pcm[1]], [0, Math.round(0.25 * 32767)]);
  assert.equal(pcm[10], 32767); // 1.7 clipped
  assert.equal(pcm[11], -32768); // -3 clipped
  const [l2, r2] = fromInt16Interleaved(pcm);
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(l2[i] - l[i]) < 1 / 32767);
    assert.ok(Math.abs(r2[i] - r[i]) < 1 / 32767);
  }
});

test('WAV header describes 16-bit stereo PCM', () => {
  const pcm = Int16Array.from([1, -1, 2, -2]);
  const buf = encodeWav(pcm, 44100);
  const v = new DataView(buf);
  const tag = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(buf.byteLength, 52);
  assert.deepEqual([...new Int16Array(buf, 44)], [1, -1, 2, -2]);
});

test('mix sums stereo signals', () => {
  const a = [Float32Array.from([1, 2]), Float32Array.from([3, 4])];
  const b = [Float32Array.from([10, 20]), Float32Array.from([30, 40])];
  const [l, r] = mix([a, b]);
  assert.deepEqual([...l], [11, 22]);
  assert.deepEqual([...r], [33, 44]);
});

test('peaks take the max of both channels per bucket', () => {
  const l = Float32Array.from([0.1, -0.9, 0.2, 0.3]);
  const r = Float32Array.from([0.5, 0, -0.4, 0]);
  assert.deepEqual([...computePeaks(l, r, 2)].map((x) => +x.toFixed(2)), [0.9, 0.4]);
  assert.equal(computePeaks(new Float32Array(0), new Float32Array(0), 3).length, 3);
});
