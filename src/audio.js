import { SAMPLE_RATE } from './config.js';

/**
 * Read a file, hash-ready bytes first (decodeAudioData detaches the buffer),
 * then decode and resample to 44.1 kHz.
 * @returns {Promise<{ audio: AudioBuffer, bytes: ArrayBuffer }>}
 */
export async function decodeFile(file) {
  const data = await file.arrayBuffer();
  const bytes = data.slice(0);
  // decodeAudioData on an OfflineAudioContext resamples to the context rate.
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const audio = await ctx.decodeAudioData(data);
  return { audio, bytes };
}

/** Copy [startSec, startSec + durSec) of an AudioBuffer as two Float32Arrays. */
export function extract(buffer, startSec, durSec) {
  const start = Math.max(0, Math.min(buffer.length, Math.round(startSec * buffer.sampleRate)));
  const end = Math.min(buffer.length, start + Math.round(durSec * buffer.sampleRate));
  const left = buffer.getChannelData(0).slice(start, end);
  const right = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).slice(start, end);
  return { left, right };
}

/** Stereo view of an AudioBuffer (a mono buffer gives the same array twice). */
export function channels(buffer) {
  const l = buffer.getChannelData(0);
  return [l, buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l];
}

/**
 * Multitrack player for the bottom bar. All tracks start on the same
 * AudioContext time, so they stay sample-aligned; each has its own gain
 * (volume, mute, solo) before a master gain. Position comes from the
 * AudioContext clock only. Emits 'change' on track, state or position jumps.
 */
export class Player extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.master = null;
    this.tracks = []; // { id, label, color, buffer, volume, muted, solo, gain, source }
    this.meta = null;
    this.offset = 0; // seconds into the tracks when paused
    this.startedAt = 0; // ctx time matching offset 0 while playing
    this.isPlaying = false;
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

  /** AudioBuffer from two Float32Arrays (copied). */
  makeBuffer(left, right) {
    const buf = this._ensureCtx().createBuffer(2, left.length, SAMPLE_RATE);
    buf.copyToChannel(left, 0);
    buf.copyToChannel(right, 1);
    return buf;
  }

  get playing() {
    return this.isPlaying;
  }

  get duration() {
    return this.tracks.reduce((m, t) => Math.max(m, t.buffer.duration), 0);
  }

  get position() {
    if (!this.isPlaying) return this.offset;
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
   * Replace all tracks. Each track: { id, label, color, buffer, volume?, muted?, solo? }.
   * keepPosition keeps the playhead (A/B between versions of the same audio);
   * the play state is kept either way.
   */
  load(tracks, meta, { keepPosition = false } = {}) {
    const ctx = this._ensureCtx();
    const wasPlaying = this.isPlaying;
    const pos = keepPosition ? this.position : 0;
    this._stopSources();
    for (const t of this.tracks) t.gain.disconnect();
    this.tracks = tracks.map((t) => {
      const gain = ctx.createGain();
      gain.connect(this.master);
      return { volume: 1, muted: false, solo: false, ...t, gain, source: null };
    });
    this.meta = meta;
    this._applyGains(true);
    this.offset = Math.min(pos, this.duration);
    if (wasPlaying) this._startSources();
    this._emit();
  }

  track(id) {
    return this.tracks.find((t) => t.id === id);
  }

  setTrack(id, changes) {
    const t = this.track(id);
    if (!t) return;
    Object.assign(t, changes);
    this._applyGains();
    this._emit();
  }

  /** A track is heard if it is soloed, or if nothing is soloed and it isn't muted. */
  audible(t) {
    const anySolo = this.tracks.some((x) => x.solo);
    return anySolo ? t.solo : !t.muted;
  }

  _applyGains(immediate = false) {
    for (const t of this.tracks) {
      const g = this.audible(t) ? t.volume : 0;
      if (immediate) t.gain.gain.value = g;
      else t.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    }
  }

  play() {
    if (!this.tracks.length || this.isPlaying) return;
    this._ensureCtx();
    if (this.offset >= this.duration) this.offset = 0;
    this._startSources();
    this._emit();
  }

  pause() {
    if (!this.isPlaying) return;
    this.offset = this.position;
    this._stopSources();
    this._emit();
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  seek(sec) {
    if (!this.tracks.length) return;
    const wasPlaying = this.isPlaying;
    this._stopSources();
    this.offset = Math.min(Math.max(0, sec), this.duration);
    if (wasPlaying) this._startSources();
    this._emit();
  }

  /** Stop and forget the tracks (frees the audio memory). */
  unload() {
    this._stopSources();
    for (const t of this.tracks) t.gain.disconnect();
    this.tracks = [];
    this.meta = null;
    this.offset = 0;
    this._emit();
  }

  _startSources() {
    const when = this.ctx.currentTime + 0.03;
    this.startedAt = when - this.offset;
    const longest = this.tracks.reduce((a, t) => (t.buffer.duration > a.buffer.duration ? t : a));
    for (const t of this.tracks) {
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gain);
      if (this.offset < t.buffer.duration) src.start(when, this.offset);
      t.source = src;
      if (t === longest) {
        src.onended = () => {
          // Only a natural end reaches here: _stopSources clears onended first.
          if (t.source !== src) return;
          this._stopSources();
          this.offset = 0;
          this._emit();
        };
      }
    }
    this.isPlaying = true;
  }

  _stopSources() {
    for (const t of this.tracks) {
      const src = t.source;
      if (!src) continue;
      t.source = null;
      src.onended = null;
      try {
        src.stop();
      } catch {
        // never started (offset past this track's end)
      }
      src.disconnect();
    }
    this.isPlaying = false;
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }
}
