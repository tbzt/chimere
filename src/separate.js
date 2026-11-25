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

/**
 * Offsets of each chunk start for a signal of `length` samples, as in Demucs
 * apply_model: range(0, length, stride).
 */
export function chunkOffsets(length, segment, overlap) {
  const stride = Math.max(1, Math.trunc(segment * (1 - overlap)));
  const offsets = [];
  for (let off = 0; off < length; off += stride) offsets.push(off);
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
    // A short (last) chunk is centred in the model window and padded with the
    // real audio around it, zeros only outside the signal (Demucs
    // TensorChunk.padded); its output is centre-trimmed back to n samples.
    const lead = (segment - n) >> 1;
    const start = off - lead;
    input.fill(0);
    const i0 = Math.max(0, -start);
    const i1 = Math.min(segment, length - start);
    for (let i = i0; i < i1; i++) {
      input[i] = (left[start + i] - mean) / std;
      input[segment + i] = (right[start + i] - mean) / std;
    }

    const stems = await runChunk(input);

    for (let s = 0; s < stemCount; s++) {
      for (let c = 0; c < 2; c++) {
        const src = (s * 2 + c) * segment + lead;
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

/** RMS of a, b and (a - b), and rms(a - b) / rms(b). */
export function relativeError(a, b) {
  let sa = 0;
  let sb = 0;
  let sd = 0;
  for (let i = 0; i < b.length; i++) {
    sa += a[i] * a[i];
    sb += b[i] * b[i];
    sd += (a[i] - b[i]) ** 2;
  }
  const n = Math.max(1, b.length);
  const rmsA = Math.sqrt(sa / n);
  const rmsB = Math.sqrt(sb / n);
  const rmsDiff = Math.sqrt(sd / n);
  return { rmsA, rmsB, rmsDiff, rel: rmsB > 0 ? rmsDiff / rmsB : rmsDiff };
}

/**
 * Sanity check of one model call. Demucs stems add up to the mix, so the sum
 * of the stems must be close to the input; a backend that computes garbage
 * (e.g. all zeros on some WebGPU drivers) fails this.
 * @param {Float32Array} input  [2 * segment]
 * @param {Float32Array} output [stemCount * 2 * segment]
 * @returns {{ ok: boolean, residual: number, reason?: string }}
 */
export function checkChunk(input, output, segment, stemCount, maxResidual = 0.3) {
  if (hasNaN(output)) return { ok: false, residual: NaN, reason: 'NaN' };
  let si = 0;
  let sd = 0;
  for (let i = 0; i < 2 * segment; i++) {
    let sum = 0;
    for (let s = 0; s < stemCount; s++) sum += output[s * 2 * segment + i];
    si += input[i] * input[i];
    sd += (sum - input[i]) ** 2;
  }
  // Near-silent input: nothing meaningful to compare.
  if (si / (2 * segment) < 1e-8) return { ok: true, residual: 0 };
  const residual = Math.sqrt(sd / si);
  return residual <= maxResidual
    ? { ok: true, residual }
    : { ok: false, residual, reason: `somme des pistes ≠ entrée (écart ${(residual * 100).toFixed(0)} %)` };
}

export function hasNaN(arr) {
  for (let i = 0; i < arr.length; i++) if (Number.isNaN(arr[i])) return true;
  return false;
}
