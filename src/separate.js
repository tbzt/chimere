// Chunked overlap-add around a fixed-length separation model.
// Pure logic: no DOM, no ONNX Runtime, so it can be tested under Node.

/** Triangular weighting window (as in Demucs apply_model), peak = 1. */
export function transitionWindow(n) {
  const w = new Float32Array(n);
  const half = Math.floor(n / 2);
  for (let i = 0; i < n; i++) w[i] = i < half ? i + 1 : n - i;
  let max = 0;
  for (let i = 0; i < n; i++) if (w[i] > max) max = w[i];
  for (let i = 0; i < n; i++) w[i] /= max;
  return w;
}

/** Offsets of each chunk start for a signal of `length` samples. */
export function chunkOffsets(length, segment, overlap) {
  const stride = Math.max(1, Math.round(segment * (1 - overlap)));
  const offsets = [];
  for (let off = 0; ; off += stride) {
    offsets.push(off);
    if (off + segment >= length) break;
  }
  return offsets;
}

/** Mean and standard deviation of the mono mix, used to normalise the input. */
export function mixStats(left, right) {
  const n = left.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (left[i] + right[i]) / 2;
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = (left[i] + right[i]) / 2 - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / Math.max(1, n - 1)) || 1;
  return { mean, std };
}

/**
 * Separate a stereo signal.
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {object} opts
 * @param {number} opts.segment   samples per model call
 * @param {number} opts.overlap   fraction of overlap between chunks
 * @param {number} opts.stemCount number of output stems
 * @param {(input: Float32Array) => Promise<Float32Array>} opts.runChunk
 *        receives [2 * segment] (channel-major), returns [stemCount * 2 * segment]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<Array<[Float32Array, Float32Array]>>} per stem, [left, right]
 */
export async function separate(left, right, { segment, overlap, stemCount, runChunk, onProgress }) {
  const length = left.length;
  const { mean, std } = mixStats(left, right);
  const window = transitionWindow(segment);
  const offsets = chunkOffsets(length, segment, overlap);

  const out = Array.from({ length: stemCount }, () => [
    new Float32Array(length),
    new Float32Array(length),
  ]);
  const weight = new Float32Array(length);
  const input = new Float32Array(2 * segment);

  for (let k = 0; k < offsets.length; k++) {
    const off = offsets[k];
    const n = Math.min(segment, length - off);
    input.fill(0);
    for (let i = 0; i < n; i++) {
      input[i] = (left[off + i] - mean) / std;
      input[segment + i] = (right[off + i] - mean) / std;
    }

    const stems = await runChunk(input);

    for (let s = 0; s < stemCount; s++) {
      for (let c = 0; c < 2; c++) {
        const src = (s * 2 + c) * segment;
        const dst = out[s][c];
        for (let i = 0; i < n; i++) dst[off + i] += stems[src + i] * window[i];
      }
    }
    for (let i = 0; i < n; i++) weight[off + i] += window[i];
    onProgress?.(k + 1, offsets.length);
  }

  for (const [l, r] of out) {
    for (let i = 0; i < length; i++) {
      l[i] = (l[i] / weight[i]) * std + mean;
      r[i] = (r[i] / weight[i]) * std + mean;
    }
  }
  return out;
}

export function hasNaN(arr) {
  for (let i = 0; i < arr.length; i++) if (Number.isNaN(arr[i])) return true;
  return false;
}
