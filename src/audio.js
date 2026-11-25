import { SAMPLE_RATE } from './config.js';

/** Decode a file and resample it to 44.1 kHz stereo. */
export async function decodeFile(file) {
  const data = await file.arrayBuffer();
  // decodeAudioData on an OfflineAudioContext resamples to the context rate.
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  return ctx.decodeAudioData(data);
}

/** Copy [startSec, startSec + durSec) of an AudioBuffer as two Float32Arrays. */
export function extract(buffer, startSec, durSec) {
  const start = Math.max(0, Math.min(buffer.length, Math.round(startSec * buffer.sampleRate)));
  const end = Math.min(buffer.length, start + Math.round(durSec * buffer.sampleRate));
  const left = buffer.getChannelData(0).slice(start, end);
  const right = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).slice(start, end);
  return { left, right };
}

/**
 * Single-track player for the bottom bar: load / play / pause / seek and a
 * master volume. Position comes from the AudioContext clock only.
 * Emits 'change' when the track, play state or position jumps.
 */
export class Player extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.master = null;
    this.buffer = null;
    this.meta = null;
    this.source = null;
    this.offset = 0; // seconds into the buffer when paused
    this.startedAt = 0; // ctx time matching offset 0 while playing
    this._volume = 0.9;
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get playing() {
    return this.source !== null;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  get position() {
    if (!this.playing) return this.offset;
    return Math.min(this.duration, Math.max(0, this.ctx.currentTime - this.startedAt));
  }

  get volume() {
    return this._volume;
  }

  set volume(v) {
    this._volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /**
   * Replace the track. keepPosition keeps the playhead (for A/B between stems
   * of the same excerpt); the play state is kept either way.
   */
  load(left, right, meta, { keepPosition = false } = {}) {
    const ctx = this._ensureCtx();
    const wasPlaying = this.playing;
    const pos = keepPosition ? this.position : 0;
    this._stopSource();
    const buf = ctx.createBuffer(2, left.length, SAMPLE_RATE);
    buf.copyToChannel(left, 0);
    buf.copyToChannel(right, 1);
    this.buffer = buf;
    this.meta = meta;
    this.offset = Math.min(pos, buf.duration);
    if (wasPlaying) this._startSource();
    this._emit();
  }

  play() {
    if (!this.buffer || this.playing) return;
    this._ensureCtx();
    if (this.offset >= this.duration) this.offset = 0;
    this._startSource();
    this._emit();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this._stopSource();
    this._emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(sec) {
    if (!this.buffer) return;
    const wasPlaying = this.playing;
    this._stopSource();
    this.offset = Math.min(Math.max(0, sec), this.duration);
    if (wasPlaying) this._startSource();
    this._emit();
  }

  /** Stop and rewind. */
  stop() {
    this._stopSource();
    this.offset = 0;
    this._emit();
  }

  _startSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.master);
    const when = this.ctx.currentTime + 0.02;
    src.start(when, this.offset);
    this.startedAt = when - this.offset;
    src.onended = () => {
      // Only natural end reaches here: _stopSource clears onended first.
      if (this.source !== src) return;
      this.source = null;
      this.offset = 0;
      this._emit();
    };
    this.source = src;
  }

  _stopSource() {
    const src = this.source;
    if (!src) return;
    this.source = null;
    src.onended = null;
    src.stop();
    src.disconnect();
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }
}

/** Element-wise sum of several stereo signals. */
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
