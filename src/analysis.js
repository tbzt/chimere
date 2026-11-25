// Tempo and key estimation, pure JS (no DOM, no dependency), unit-tested under
// Node and run in src/analysis.worker.js. Works best on separated stems:
// tempo from the drums, key from the harmonic stems (bass + other).

export const ANALYSIS_RATE = 11025;

// --- DSP helpers ---

/** Windowed-sinc low-pass then keep 1 sample in `factor`. */
export function decimate(x, factor) {
  const taps = 8 * factor + 1;
  const half = (taps - 1) / 2;
  const cutoff = 0.45 / factor; // of the input rate
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - half;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const n = Math.floor(x.length / factor);
  const y = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c = k * factor;
    let acc = 0;
    const i0 = Math.max(0, c - half);
    const i1 = Math.min(x.length - 1, c + half);
    for (let i = i0; i <= i1; i++) acc += x[i] * h[i - c + half];
    y[k] = acc;
  }
  return y;
}

/** In-place iterative radix-2 FFT. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Magnitude spectra of Hann-windowed frames: calls onFrame(mag, frameIndex). */
function stft(x, size, hop, onFrame) {
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const mag = new Float64Array(size / 2 + 1);
  let f = 0;
  for (let start = 0; start + size <= x.length; start += hop, f++) {
    for (let i = 0; i < size; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    onFrame(mag, f);
  }
  return f;
}

// --- Tempo ---

const FLUX_SIZE = 512;
const FLUX_HOP = 128;

/** Onset strength: half-wave rectified log-spectral flux, one value per hop. */
export function onsetEnvelope(x, rate = ANALYSIS_RATE) {
  const frames = Math.max(0, Math.floor((x.length - FLUX_SIZE) / FLUX_HOP) + 1);
  const env = new Float32Array(frames);
  let prev = null;
  stft(x, FLUX_SIZE, FLUX_HOP, (mag, f) => {
    const cur = new Float64Array(mag.length);
    let flux = 0;
    for (let k = 1; k < mag.length; k++) {
      // Mild compression: stronger log compression makes off-beat hats as
      // strong as kicks and leads to 2/3-tempo errors (unfixable with ×2).
      cur[k] = Math.log1p(10 * mag[k]);
      if (prev) flux += Math.max(0, cur[k] - prev[k]);
    }
    env[f] = flux;
    prev = cur;
  });
  // Remove the slow trend (≈ 1 s moving average) so loud passages don't dominate.
  const frameRate = rate / FLUX_HOP;
  const w = Math.round(frameRate);
  const out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += env[i];
    if (i >= w) acc -= env[i - w];
    const mean = acc / Math.min(i + 1, w);
    out[i] = Math.max(0, env[i] - mean);
  }
  // Gaussian smoothing (σ ≈ 23 ms): onsets are only 1–2 frames wide, which
  // makes the autocorrelation jumpy between integer lags.
  const sigma = 2;
  const kernel = [];
  for (let k = -3 * sigma; k <= 3 * sigma; k++) kernel.push(Math.exp(-0.5 * (k / sigma) ** 2));
  const ksum = kernel.reduce((a, b) => a + b, 0);
  const smooth = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc2 = 0;
    for (let k = 0; k < kernel.length; k++) {
      const j = i + k - 3 * sigma;
      if (j >= 0 && j < frames) acc2 += out[j] * kernel[k];
    }
    smooth[i] = acc2 / ksum;
  }
  return { env: smooth, frameRate };
}

/**
 * Tempo from the onset envelope: autocorrelation scored as a comb over
 * 4 beat multiples (sub-frame precision), weighted by a log-normal prior
 * around 120 BPM. Returns { bpm, confidence (0..1) }.
 */
export function estimateTempo(env, frameRate, { min = 60, max = 200, multiples = [1, 2, 3, 4] } = {}) {
  const maxLag = Math.ceil(((Math.max(...multiples) * 60) / min) * frameRate) + 2;
  const n = env.length;
  if (n < maxLag * 2) return { bpm: 0, confidence: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
    ac[lag] = s / (n - lag);
  }
  const at = (lag) => {
    const i = Math.floor(lag);
    const f = lag - i;
    return i + 1 <= maxLag ? ac[i] * (1 - f) + ac[i + 1] * f : 0;
  };
  let best = { bpm: 0, score: -Infinity };
  const scores = [];
  for (let bpm = min; bpm <= max; bpm += 0.05) {
    const lag = (60 / bpm) * frameRate;
    let s = 0;
    for (const k of multiples) s += at(k * lag) / k;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    const score = s * prior;
    scores.push(score);
    if (score > best.score) best = { bpm, score };
  }
  const sorted = scores.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const confidence = best.score > 0 ? Math.max(0, Math.min(1, 1 - Math.max(0, median) / best.score)) : 0;
  return { bpm: Math.round(best.bpm * 10) / 10, confidence };
}

// --- Key ---

const CHROMA_SIZE = 8192;
const CHROMA_HOP = 4096;

/** Average normalised 12-bin chroma (C = 0) over notes C2..C7. */
export function chroma(x, rate = ANALYSIS_RATE) {
  const bins = CHROMA_SIZE / 2 + 1;
  const pc = new Int8Array(bins).fill(-1);
  const weight = new Float64Array(bins);
  for (let k = 1; k < bins; k++) {
    const f = (k * rate) / CHROMA_SIZE;
    if (f < 65 || f > 2100) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const near = Math.round(midi);
    const dev = Math.abs(midi - near);
    if (dev > 0.35) continue; // between two semitones: ambiguous
    pc[k] = ((near % 12) + 12) % 12;
    weight[k] = 1 - dev;
  }
  const total = new Float64Array(12);
  const frame = new Float64Array(12);
  stft(x, CHROMA_SIZE, CHROMA_HOP, (mag) => {
    frame.fill(0);
    for (let k = 1; k < bins; k++) if (pc[k] >= 0) frame[pc[k]] += mag[k] * weight[k];
    const m = Math.max(...frame);
    if (m > 1e-6) for (let i = 0; i < 12; i++) total[i] += frame[i] / m;
  });
  const s = total.reduce((a, b) => a + b, 0) || 1;
  return Array.from(total, (v) => v / s);
}

// Krumhansl–Kessler key profiles (tonic first).
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Best of the 24 keys by correlation with the profiles.
 * @returns {{ tonic: number, mode: 'major'|'minor', score: number, margin: number }}
 */
export function estimateKey(chromaVector) {
  const results = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = Array.from({ length: 12 }, (_, i) => chromaVector[(i + tonic) % 12]);
    results.push({ tonic, mode: 'major', score: pearson(rotated, MAJOR) });
    results.push({ tonic, mode: 'minor', score: pearson(rotated, MINOR) });
  }
  results.sort((a, b) => b.score - a.score);
  return { ...results[0], margin: results[0].score - results[1].score };
}

// --- Names and Camelot wheel ---

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
const FRENCH = ['Do', 'Ré♭', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const FRENCH_MINOR = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'Si♭', 'Si'];

/** "Am", "Db"… */
export function keyName(tonic, mode) {
  return mode === 'minor' ? `${MINOR_NAMES[tonic]}m` : NAMES[tonic];
}

/** "La mineur", "Ré♭ majeur"… */
export function keyNameFr(tonic, mode) {
  return mode === 'minor' ? `${FRENCH_MINOR[tonic]} mineur` : `${FRENCH[tonic]} majeur`;
}

/** Camelot code: C major = 8B, A minor = 8A; one step = a fifth. */
export function camelot(tonic, mode) {
  const ref = mode === 'major' ? 0 : 9; // C major and A minor are both 8
  const fifths = (((tonic - ref) * 7) % 12 + 12) % 12;
  return `${((fifths + 7) % 12) + 1}${mode === 'major' ? 'B' : 'A'}`;
}

/** Same code, ±1 on the wheel, or the relative major/minor. */
export function camelotCompatible(a, b) {
  const pa = /^(\d+)([AB])$/.exec(a);
  const pb = /^(\d+)([AB])$/.exec(b);
  if (!pa || !pb) return false;
  const [na, la] = [Number(pa[1]), pa[2]];
  const [nb, lb] = [Number(pb[1]), pb[2]];
  if (na === nb) return true;
  const d = Math.abs(na - nb);
  return la === lb && (d === 1 || d === 11);
}

// --- Whole analysis ---

/** Mono sum of stereo signals [[l, r], …] at 44.1 kHz, decimated to 11025 Hz. */
export function monoAt11k(signals) {
  const n = signals[0][0].length;
  const m = new Float32Array(n);
  for (const [l, r] of signals) for (let i = 0; i < n; i++) m[i] += 0.5 * (l[i] + r[i]);
  return decimate(m, 4);
}

/**
 * @param {Array<[Float32Array, Float32Array]>} rhythm   stems for tempo (drums)
 * @param {Array<[Float32Array, Float32Array]>} harmonic stems for key (bass, other)
 */
export function analyze(rhythm, harmonic) {
  const r = monoAt11k(rhythm);
  const { env, frameRate } = onsetEnvelope(r);
  const tempo = estimateTempo(env, frameRate);
  const key = estimateKey(chroma(monoAt11k(harmonic)));
  return {
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    tonic: key.tonic,
    mode: key.mode,
    keyScore: key.score,
    keyMargin: key.margin,
  };
}
