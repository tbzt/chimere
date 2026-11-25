import { SAMPLE_RATE } from './config.js';
import { clipEnvelope, clipGainAt } from './project.js';

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
 * Multitrack player for the bottom bar. Lanes hold clips placed on a common
 * timeline; every clip is scheduled on the AudioContext clock, so lanes stay
 * sample-aligned. Graph: source → clip gain (fades) → panner → lane gain
 * (volume, mute, solo) → master. Emits 'change' on load, state or seek.
 *
 * lane = { id, label, color, volume?, muted?, solo?, clips?, buffer? }
 * clip = { buffer, at = 0, offset = 0, length?, gain = 1, pan = 0, fadeIn = 0, fadeOut = 0 }
 * A lane with `buffer` and no `clips` is one clip covering the whole buffer.
 */
export class Player extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.master = null;
    this.tracks = []; // lanes: { ..., gain, clips: [{ ..., nodes }] }
    this.meta = null;
    this.offset = 0; // timeline seconds when paused
    this.startedAt = 0; // ctx time matching timeline 0 while playing
    this.isPlaying = false;
    this.endMarker = null;
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
    let end = 0;
    for (const t of this.tracks) for (const c of t.clips) end = Math.max(end, c.at + c.length);
    return end;
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
   * Replace all lanes. keepPosition keeps the playhead (A/B between versions,
   * or live edits of a mashup); the play state is kept either way.
   */
  load(lanes, meta, { keepPosition = false } = {}) {
    const ctx = this._ensureCtx();
    const wasPlaying = this.isPlaying;
    const pos = keepPosition ? this.position : 0;
    this._stopSources();
    for (const t of this.tracks) t.gain.disconnect();
    this.tracks = lanes.map((lane) => {
      const gain = ctx.createGain();
      gain.connect(this.master);
      const clips = (lane.clips ?? [{ buffer: lane.buffer }]).map((c) => {
        const offset = c.offset ?? 0;
        return {
          at: 0,
          gain: 1,
          pan: 0,
          fadeIn: 0,
          fadeOut: 0,
          ...c,
          offset,
          length: Math.min(c.length ?? Infinity, c.buffer.duration - offset),
          nodes: null,
        };
      });
      return { volume: 1, muted: false, solo: false, ...lane, clips, gain };
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

  /** A lane is heard if it is soloed, or if nothing is soloed and it isn't muted. */
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

  /** Stop and forget the lanes (frees the audio memory). */
  unload() {
    this._stopSources();
    for (const t of this.tracks) t.gain.disconnect();
    this.tracks = [];
    this.meta = null;
    this.offset = 0;
    this._emit();
  }

  _startSources() {
    const ctx = this.ctx;
    const when = ctx.currentTime + 0.03;
    const pos = this.offset;
    this.startedAt = when - pos;
    for (const t of this.tracks) {
      for (const c of t.clips) {
        const end = c.at + c.length;
        if (end <= pos) continue;
        const into = Math.max(0, pos - c.at); // seconds already played of this clip
        const startAt = when + Math.max(0, c.at - pos);
        const src = ctx.createBufferSource();
        src.buffer = c.buffer;
        const g = ctx.createGain();
        scheduleEnvelope(g.gain, c, into, startAt);
        let out = g;
        if (c.pan) {
          const p = ctx.createStereoPanner();
          p.pan.value = c.pan;
          g.connect(p);
          out = p;
        }
        src.connect(g);
        out.connect(t.gain);
        src.start(startAt, c.offset + into, c.length - into);
        c.nodes = { src, g, out };
      }
    }
    // End of the timeline, detected on the audio clock.
    const marker = ctx.createConstantSource();
    marker.offset.value = 0;
    marker.connect(this.master);
    marker.start(when);
    marker.stop(when + Math.max(0, this.duration - pos));
    marker.onended = () => {
      if (this.endMarker !== marker) return;
      this._stopSources();
      this.offset = 0;
      this._emit();
    };
    this.endMarker = marker;
    this.isPlaying = true;
  }

  _stopSources() {
    for (const t of this.tracks) {
      for (const c of t.clips) {
        if (!c.nodes) continue;
        const { src, g, out } = c.nodes;
        c.nodes = null;
        try {
          src.stop();
        } catch {
          // not started yet
        }
        src.disconnect();
        g.disconnect();
        out.disconnect();
      }
    }
    if (this.endMarker) {
      const m = this.endMarker;
      this.endMarker = null;
      m.onended = null;
      try {
        m.stop();
      } catch {
        // already stopped
      }
      m.disconnect();
    }
    this.isPlaying = false;
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }
}

/**
 * Program a clip's gain (level and linear fades) on an AudioParam, for a
 * playback that starts `into` seconds into the clip at context time `startAt`.
 */
export function scheduleEnvelope(param, clip, into, startAt) {
  const pts = clipEnvelope(clip);
  param.setValueAtTime(clipGainAt(clip, into), startAt);
  for (const [t, g] of pts) {
    if (t <= into) continue;
    param.linearRampToValueAtTime(g, startAt + (t - into));
  }
}
