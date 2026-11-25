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
