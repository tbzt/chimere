import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newProject,
  newLane,
  newClip,
  beatToSec,
  secToBeat,
  clipSpan,
  projectDuration,
  snapBeat,
  clipGainAt,
  clipEnvelope,
  laneAudible,
  sourcesOf,
  moveClipToLane,
  removeClip,
  findClip,
  cloneProject,
} from '../src/project.js';

function sample() {
  const p = newProject('Test', 120);
  const a = newLane('A');
  const b = newLane('B');
  a.clips.push(newClip({ songId: 's1', stem: 'vocals', start: 4, length: 10 }));
  b.clips.push(newClip({ songId: 's2', stem: 'instrumental', start: 0, length: 30 }));
  b.clips.push(newClip({ songId: 's1', stem: 'vocals', start: 64, length: 5 }));
  p.lanes.push(a, b);
  return p;
}

test('beats and seconds at the project tempo', () => {
  const p = newProject('x', 120);
  assert.equal(beatToSec(p, 4), 2);
  assert.equal(secToBeat(p, 3), 6);
});

test('clip span and project duration', () => {
  const p = sample();
  assert.deepEqual(clipSpan(p, p.lanes[0].clips[0]), { at: 2, end: 12 });
  // Last clip: start 64 beats = 32 s, length 5 → 37 s.
  assert.equal(projectDuration(p), 37);
  assert.equal(projectDuration(newProject()), 0);
});

test('snapping to bars, beats, or not at all', () => {
  assert.equal(snapBeat(5.4, 'bar'), 4);
  assert.equal(snapBeat(6.1, 'bar'), 8);
  assert.equal(snapBeat(5.4, 'beat'), 5);
  assert.equal(snapBeat(5.4, 'off'), 5.4);
  assert.equal(snapBeat(-1.2, 'beat'), 0);
  assert.equal(snapBeat(5, 'bar', 3), 6);
});

test('clip gain follows linear fades', () => {
  const c = { gain: 0.8, length: 10, fadeIn: 2, fadeOut: 4 };
  assert.equal(clipGainAt(c, 0), 0);
  assert.ok(Math.abs(clipGainAt(c, 1) - 0.4) < 1e-9);
  assert.equal(clipGainAt(c, 5), 0.8);
  assert.ok(Math.abs(clipGainAt(c, 8) - 0.4) < 1e-9);
  assert.equal(clipGainAt(c, 10), 0);
  assert.equal(clipGainAt(c, 11), 0);
});

test('fades longer than the clip are scaled down to fit', () => {
  const c = { gain: 1, length: 4, fadeIn: 4, fadeOut: 4 };
  assert.equal(clipGainAt(c, 2), 1);
  assert.deepEqual(clipEnvelope(c), [
    [0, 0],
    [2, 1],
    [4, 0],
  ]);
});

test('envelope without fades is flat', () => {
  assert.deepEqual(clipEnvelope({ gain: 0.5, length: 3, fadeIn: 0, fadeOut: 0 }), [
    [0, 0.5],
    [3, 0.5],
  ]);
});

test('solo overrides mute', () => {
  const p = sample();
  const [a, b] = p.lanes;
  assert.ok(laneAudible(p, a) && laneAudible(p, b));
  a.muted = true;
  assert.ok(!laneAudible(p, a));
  b.solo = true;
  assert.ok(!laneAudible(p, a) && laneAudible(p, b));
  a.solo = true;
  assert.ok(laneAudible(p, a));
});

test('sources are listed once', () => {
  assert.deepEqual(sourcesOf(sample()).sort(), ['s1:vocals', 's2:instrumental']);
});

test('moving and removing clips', () => {
  const p = sample();
  const id = p.lanes[0].clips[0].id;
  moveClipToLane(p, id, p.lanes[1].id);
  assert.equal(p.lanes[0].clips.length, 0);
  assert.equal(findClip(p, id).lane, p.lanes[1]);
  removeClip(p, id);
  assert.equal(findClip(p, id), null);
  assert.equal(p.lanes[1].clips.length, 2);
});

test('projects survive a JSON round trip', () => {
  const p = sample();
  assert.deepEqual(cloneProject(p), p);
});
