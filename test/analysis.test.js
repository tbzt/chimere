import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_RATE,
  decimate,
  onsetEnvelope,
  estimateTempo,
  chroma,
  estimateKey,
  camelot,
  camelotCompatible,
  keyName,
  keyNameFr,
  analyze,
} from '../src/analysis.js';

const RATE = 44100;

/** Decaying noise bursts every beat (kick-like), with a softer off-beat hat. */
function clickTrack(bpm, seconds, rate = ANALYSIS_RATE) {
  const x = new Float32Array(Math.round(seconds * rate));
  const period = (60 / bpm) * rate;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; b * period < x.length; b++) {
    const start = Math.round(b * period);
    const amp = b % 2 === 0 ? 1 : 0.7;
    for (let i = 0; i < 0.05 * rate && start + i < x.length; i++) x[start + i] += amp * rnd() * Math.exp(-i / (0.01 * rate));
    const off = Math.round(start + period / 2);
    for (let i = 0; i < 0.02 * rate && off + i < x.length; i++) x[off + i] += 0.25 * rnd() * Math.exp(-i / (0.004 * rate));
  }
  return x;
}

/** Sum of harmonic tones for the given MIDI notes. */
function chordSignal(notes, seconds, rate = ANALYSIS_RATE) {
  const x = new Float32Array(Math.round(seconds * rate));
  for (const midi of notes) {
    const f = 440 * 2 ** ((midi - 69) / 12);
    for (let h = 1; h <= 3; h++) {
      if (f * h > rate / 2) continue;
      for (let i = 0; i < x.length; i++) x[i] += (0.2 / h) * Math.sin((2 * Math.PI * f * h * i) / rate);
    }
  }
  return x;
}

for (const bpm of [90, 120, 128, 140, 174]) {
  test(`tempo of a ${bpm} BPM click track`, () => {
    const { env, frameRate } = onsetEnvelope(clickTrack(bpm, 30));
    const t = estimateTempo(env, frameRate);
    // Above ~160 BPM an exact octave error is accepted (fixed with the ×2
    // button); 2/3 or 3/2 errors are not.
    const ok = Math.abs(t.bpm - bpm) < 1 || (bpm > 160 && Math.abs(2 * t.bpm - bpm) < 1);
    assert.ok(ok, `got ${t.bpm}`);
    assert.ok(t.confidence > 0.3, `confidence ${t.confidence}`);
  });
}

test('silence gives no tempo', () => {
  const { env, frameRate } = onsetEnvelope(new Float32Array(ANALYSIS_RATE * 10));
  assert.equal(estimateTempo(env, frameRate).confidence, 0);
});

test('C major progression is detected as C major', () => {
  // I – IV – V – I in C (C E G, F A C, G B D, C E G), with a bass note.
  const parts = [
    [48, 60, 64, 67],
    [53, 65, 69, 72],
    [55, 67, 71, 74],
    [48, 60, 64, 67],
  ].map((n) => chordSignal(n, 3));
  const x = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    x.set(p, o);
    o += p.length;
  }
  const k = estimateKey(chroma(x));
  assert.deepEqual([k.tonic, k.mode], [0, 'major']);
});

test('A minor progression is detected as A minor', () => {
  // i – iv – V – i in A minor (A C E, D F A, E G# B, A C E).
  const parts = [
    [45, 57, 60, 64],
    [50, 62, 65, 69],
    [52, 64, 68, 71],
    [45, 57, 60, 64],
  ].map((n) => chordSignal(n, 3));
  const x = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    x.set(p, o);
    o += p.length;
  }
  const k = estimateKey(chroma(x));
  assert.deepEqual([k.tonic, k.mode], [9, 'minor']);
});

test('decimation keeps a low tone and removes a high one', () => {
  const n = RATE;
  const low = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / RATE));
  const high = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 9000 * i) / RATE));
  const rms = (a) => Math.sqrt(a.slice(100, -100).reduce((s, v) => s + v * v, 0) / (a.length - 200));
  assert.ok(Math.abs(rms(decimate(low, 4)) - Math.SQRT1_2) < 0.02);
  assert.ok(rms(decimate(high, 4)) < 0.01);
});

test('Camelot codes and names', () => {
  assert.equal(camelot(0, 'major'), '8B'); // C
  assert.equal(camelot(9, 'minor'), '8A'); // Am
  assert.equal(camelot(7, 'major'), '9B'); // G
  assert.equal(camelot(11, 'major'), '1B'); // B
  assert.equal(camelot(4, 'minor'), '9A'); // Em
  assert.equal(camelot(2, 'minor'), '7A'); // Dm
  assert.equal(camelot(8, 'minor'), '1A'); // G#m
  assert.equal(keyName(1, 'major'), 'Db');
  assert.equal(keyName(1, 'minor'), 'C#m');
  assert.equal(keyNameFr(9, 'minor'), 'La mineur');
});

test('Camelot compatibility: same, ±1 (wrapping), relative', () => {
  assert.ok(camelotCompatible('8A', '8A'));
  assert.ok(camelotCompatible('8A', '9A'));
  assert.ok(camelotCompatible('12B', '1B'));
  assert.ok(camelotCompatible('8A', '8B'));
  assert.ok(!camelotCompatible('8A', '9B'));
  assert.ok(!camelotCompatible('8A', '10A'));
});

test('analyze runs end to end on 44.1 kHz stems', () => {
  const up = (x) => {
    const y = new Float32Array(x.length * 4);
    for (let i = 0; i < y.length; i++) y[i] = x[Math.floor(i / 4)];
    return [y, y];
  };
  const drums = up(clickTrack(120, 20));
  const harm = up(chordSignal([45, 57, 60, 64], 20));
  const a = analyze([drums], [harm]);
  assert.ok(Math.abs(a.bpm - 120) < 1.5, `bpm ${a.bpm}`);
  assert.deepEqual([a.tonic, a.mode], [9, 'minor']);
});
