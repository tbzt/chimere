import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separate, chunkOffsets, transitionWindow } from '../src/separate.js';

test('chunk offsets cover the whole signal', () => {
  const offs = chunkOffsets(1000, 400, 0.25);
  assert.deepEqual(offs, [0, 300, 600]);
  assert.ok(offs.at(-1) + 400 >= 1000);
});

test('window peaks at 1 and stays positive', () => {
  const w = transitionWindow(10);
  assert.equal(Math.max(...w), 1);
  assert.ok(w.every((x) => x > 0));
});

test('identity model reconstructs the input through overlap-add', async () => {
  const n = 2500;
  const left = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7));
  const right = Float32Array.from({ length: n }, (_, i) => Math.cos(i / 11) * 0.5);
  const segment = 400;
  const stemCount = 2;
  // Fake model: stem 0 = input, stem 1 = zeros.
  const runChunk = async (input) => {
    const out = new Float32Array(stemCount * 2 * segment);
    out.set(input, 0);
    return out;
  };
  const [s0, s1] = await separate(left, right, { segment, overlap: 0.25, stemCount, runChunk });
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(s0[0][i] - left[i]) < 1e-4, `left ${i}`);
    assert.ok(Math.abs(s0[1][i] - right[i]) < 1e-4, `right ${i}`);
  }
  // Zero output maps back to the mix mean, which is small here.
  assert.ok(Math.abs(s1[0][0]) < 0.05);
});

test('relative error is zero for identical signals and scales with the difference', async () => {
  const { relativeError } = await import('../src/separate.js');
  const b = Float32Array.from([1, -1, 1, -1]);
  assert.equal(relativeError(b, b).rel, 0);
  const a = b.map((x) => x * 1.1);
  assert.ok(Math.abs(relativeError(a, b).rel - 0.1) < 1e-6);
});

test('chunk check accepts stems that add up to the input and rejects zeros', async () => {
  const { checkChunk } = await import('../src/separate.js');
  const segment = 100;
  const input = Float32Array.from({ length: 2 * segment }, (_, i) => Math.sin(i / 5));
  const good = new Float32Array(4 * 2 * segment);
  for (let i = 0; i < 2 * segment; i++) {
    good[i] = input[i] * 0.7; // stem 0
    good[3 * 2 * segment + i] = input[i] * 0.3; // stem 3
  }
  assert.equal(checkChunk(input, good, segment, 4).ok, true);
  const zeros = new Float32Array(4 * 2 * segment);
  const bad = checkChunk(input, zeros, segment, 4);
  assert.equal(bad.ok, false);
  assert.ok(Math.abs(bad.residual - 1) < 1e-6);
  const nan = good.slice();
  nan[5] = NaN;
  assert.equal(checkChunk(input, nan, segment, 4).reason, 'NaN');
  assert.equal(checkChunk(new Float32Array(2 * segment), zeros, segment, 4).ok, true);
});
