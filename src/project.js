// Mashup project model. Pure functions (no DOM, no Web Audio), unit-tested.
//
// project = {
//   id, name, bpm, beatsPerBar, createdAt, updatedAt,
//   lanes: [{ id, name, volume, muted, solo, clips: [clip] }],
// }
// clip = {
//   id, songId, stem,         // source: a track of a song in the library
//   start,                    // position on the timeline, in beats (project grid)
//   offset, length,           // part of the source used, in source seconds
//   gain, pan, fadeIn, fadeOut,
// }
// Until time-stretching exists, a clip plays at its original speed: its
// length on the timeline in seconds is its source length.

export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other', 'instrumental', 'original'];

let counter = 0;
export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function newProject(name = 'Nouveau mashup', bpm = 120) {
  const now = Date.now();
  return { id: newId('p'), name, bpm, beatsPerBar: 4, createdAt: now, updatedAt: now, lanes: [] };
}

export function newLane(name) {
  return { id: newId('l'), name, volume: 1, muted: false, solo: false, clips: [] };
}

export function newClip({ songId, stem, start = 0, length, offset = 0 }) {
  return { id: newId('c'), songId, stem, start, offset, length, gain: 1, pan: 0, fadeIn: 0, fadeOut: 0 };
}

export const secPerBeat = (project) => 60 / project.bpm;
export const beatToSec = (project, beat) => beat * secPerBeat(project);
export const secToBeat = (project, sec) => sec / secPerBeat(project);

/** Clip span on the timeline, in seconds. */
export function clipSpan(project, clip) {
  const at = beatToSec(project, clip.start);
  return { at, end: at + clip.length };
}

/** End of the last clip, in seconds. */
export function projectDuration(project) {
  let end = 0;
  for (const lane of project.lanes) for (const c of lane.clips) end = Math.max(end, clipSpan(project, c).end);
  return end;
}

/**
 * Snap a position in beats to the grid: 'bar', 'beat', or 'off'.
 * Never returns a negative position.
 */
export function snapBeat(beat, grid, beatsPerBar = 4) {
  const step = grid === 'bar' ? beatsPerBar : grid === 'beat' ? 1 : 0;
  const b = step ? Math.round(beat / step) * step : beat;
  return Math.max(0, b);
}

/**
 * Gain of a clip at `t` seconds into the clip (fades are linear, and are
 * shortened to fit when fadeIn + fadeOut exceeds the clip length).
 */
export function clipGainAt(clip, t) {
  const L = clip.length;
  if (t < 0 || t > L) return 0;
  let fi = Math.max(0, clip.fadeIn);
  let fo = Math.max(0, clip.fadeOut);
  if (fi + fo > L) {
    const k = L / (fi + fo);
    fi *= k;
    fo *= k;
  }
  let g = clip.gain;
  if (fi > 0 && t < fi) g *= t / fi;
  if (fo > 0 && t > L - fo) g *= (L - t) / fo;
  return g;
}

/** Fade breakpoints of a clip, in seconds into the clip: [[t, gain], …]. */
export function clipEnvelope(clip) {
  const L = clip.length;
  const pts = new Set([0, L]);
  let fi = Math.max(0, clip.fadeIn);
  let fo = Math.max(0, clip.fadeOut);
  if (fi + fo > L) {
    const k = L / (fi + fo);
    fi *= k;
    fo *= k;
  }
  if (fi > 0) pts.add(fi);
  if (fo > 0) pts.add(L - fo);
  return [...pts].sort((a, b) => a - b).map((t) => [t, clipGainAt(clip, t)]);
}

/** Is a lane heard, given solo/mute of all lanes? */
export function laneAudible(project, lane) {
  const anySolo = project.lanes.some((l) => l.solo);
  return anySolo ? lane.solo : !lane.muted;
}

/** Source keys "songId:stem" used by the project. */
export function sourcesOf(project) {
  const keys = new Set();
  for (const lane of project.lanes) for (const c of lane.clips) keys.add(`${c.songId}:${c.stem}`);
  return [...keys];
}

/** Find a clip and its lane. */
export function findClip(project, clipId) {
  for (const lane of project.lanes) {
    const clip = lane.clips.find((c) => c.id === clipId);
    if (clip) return { lane, clip };
  }
  return null;
}

/** Move a clip to another lane (same position). */
export function moveClipToLane(project, clipId, laneId) {
  const found = findClip(project, clipId);
  const target = project.lanes.find((l) => l.id === laneId);
  if (!found || !target || found.lane === target) return;
  found.lane.clips = found.lane.clips.filter((c) => c.id !== clipId);
  target.clips.push(found.clip);
}

/** Remove a clip; drop its lane if it became empty and has no name change. */
export function removeClip(project, clipId) {
  const found = findClip(project, clipId);
  if (!found) return;
  found.lane.clips = found.lane.clips.filter((c) => c.id !== clipId);
}

/** Sanity: plain JSON round trip (projects are stored as JSON-like objects). */
export const cloneProject = (p) => JSON.parse(JSON.stringify(p));
