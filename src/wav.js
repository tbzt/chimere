// PCM helpers: int16 storage, WAV encoding, mixing, waveform peaks.
// Pure functions (no DOM), unit-tested under Node; heavy calls run in
// src/encoder.worker.js.

/** Stereo float [-1, 1] → interleaved int16 (clipped). */
export function toInt16Interleaved(left, right) {
  const n = left.length;
  const out = new Int16Array(2 * n);
  for (let i = 0; i < n; i++) {
    out[2 * i] = floatToInt16(left[i]);
    out[2 * i + 1] = floatToInt16(right[i]);
  }
  return out;
}

function floatToInt16(x) {
  const v = x < -1 ? -1 : x > 1 ? 1 : x;
  return v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
}

/** Interleaved int16 → [left, right] float. */
export function fromInt16Interleaved(pcm) {
  const n = pcm.length >> 1;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = pcm[2 * i];
    const r = pcm[2 * i + 1];
    left[i] = l < 0 ? l / 32768 : l / 32767;
    right[i] = r < 0 ? r / 32768 : r / 32767;
  }
  return [left, right];
}

/** Element-wise sum of several stereo signals [[l, r], …]. */
export function mix(signals) {
  const n = signals[0][0].length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (const [sl, sr] of signals) {
    for (let i = 0; i < n; i++) {
      l[i] += sl[i];
      r[i] += sr[i];
    }
  }
  return [l, r];
}

/** 16-bit PCM WAV file from interleaved stereo int16. */
export function encodeWav(pcm, sampleRate, channels = 2) {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

/** Max |sample| of the stereo signal over `buckets` equal slices. */
export function computePeaks(left, right, buckets) {
  const n = left.length;
  const peaks = new Float32Array(buckets);
  if (n === 0) return peaks;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / buckets));
    let m = 0;
    for (let i = start; i < end && i < n; i++) {
      const a = Math.abs(left[i]);
      const c = Math.abs(right[i]);
      if (a > m) m = a;
      if (c > m) m = c;
    }
    peaks[b] = m;
  }
  return peaks;
}
