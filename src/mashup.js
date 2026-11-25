// Mashup view: sources from the library, timeline with lanes and clips,
// clip inspector, autosave. Audio goes through the shared Player.
import { STEM_LABELS } from './config.js';
import { channels } from './audio.js';
import { computePeaks } from './wav.js';
import { keyName, camelot } from './analysis.js';
import { listSongs, getSong, loadTrack, saveProject, loadProject } from './library.js';
import {
  newProject,
  newLane,
  newClip,
  beatToSec,
  secToBeat,
  projectDuration,
  snapBeat,
  findClip,
  moveClipToLane,
  removeClip,
  sourcesOf,
} from './project.js';

const $ = (id) => document.getElementById(id);

export const SOURCE_STEMS = [
  { id: 'vocals', label: STEM_LABELS.vocals, color: '--stem-vocals' },
  { id: 'drums', label: STEM_LABELS.drums, color: '--stem-drums' },
  { id: 'bass', label: STEM_LABELS.bass, color: '--stem-bass' },
  { id: 'other', label: STEM_LABELS.other, color: '--stem-other' },
  { id: 'instrumental', label: 'Instrumental', color: '--accent' },
];
const stemInfo = (id) => SOURCE_STEMS.find((s) => s.id === id) ?? { label: id, color: '--muted' };
const HEAD_W = 170; // px, lane header column
const PEAK_BUCKETS = 4000;
const CURRENT_KEY = 'chimere-current-project';

/**
 * @param {object} deps
 * @param {import('./audio.js').Player} deps.player
 * @param {(type: string, payload: object, transfer?: Transferable[]) => Promise<any>} deps.encode
 * @param {(text: string) => void} deps.log
 */
export function initMashup({ player, encode, log }) {
  let project = null;
  let songs = new Map(); // songId → meta
  const sources = new Map(); // "songId:stem" → Promise<{ buffer, peaks }>
  let selected = null; // clip id
  let pxPerBeat = 12;
  let saveTimer = 0;

  // --- Sources: library tracks decoded on demand, kept in memory ---
  function getSource(songId, stem) {
    const key = `${songId}:${stem}`;
    if (!sources.has(key)) {
      const p = (async () => {
        const names = stem === 'instrumental' ? ['drums', 'bass', 'other'] : [stem];
        const pcm = {};
        for (const n of names) pcm[n] = await loadTrack(songId, n);
        const floats = await encode('float', { tracks: pcm }, Object.values(pcm).map((a) => a.buffer));
        let [l, r] = floats[names[0]];
        if (names.length > 1) {
          l = l.slice();
          r = r.slice();
          for (const n of names.slice(1)) {
            const [nl, nr] = floats[n];
            for (let i = 0; i < l.length; i++) {
              l[i] += nl[i];
              r[i] += nr[i];
            }
          }
        }
        const buffer = player.makeBuffer(l, r);
        return { buffer, peaks: computePeaks(l, r, PEAK_BUCKETS) };
      })();
      p.catch(() => sources.delete(key));
      sources.set(key, p);
    }
    return sources.get(key);
  }

  // --- Persistence (debounced autosave; timers are UI only, not audio) ---
  function changed({ audio = true } = {}) {
    project.updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveProject(project).catch((e) => log(`Mashup : sauvegarde impossible (${e.message}).`));
    }, 400);
    if (audio && player.meta?.kind === 'mashup') loadIntoPlayer({ keepPosition: true });
  }

  async function openProject(p) {
    project = p;
    selected = null;
    try {
      localStorage.setItem(CURRENT_KEY, p.id);
    } catch {
      // storage unavailable
    }
    render();
    // Decode the sources in the background so playback starts fast.
    for (const key of sourcesOf(project)) {
      const [songId, stem] = key.split(':');
      getSource(songId, stem).then(renderClipsOnly, () => {});
    }
  }

  async function restore() {
    let id = null;
    try {
      id = localStorage.getItem(CURRENT_KEY);
    } catch {
      // storage unavailable
    }
    const p = id ? await loadProject(id).catch(() => null) : null;
    await openProject(p ?? newProject());
  }

  // --- Playback ---
  async function loadIntoPlayer({ keepPosition = false } = {}) {
    const lanes = [];
    for (const lane of project.lanes) {
      const clips = [];
      for (const c of lane.clips) {
        let src;
        try {
          src = await getSource(c.songId, c.stem);
        } catch {
          continue; // missing source: skipped
        }
        clips.push({
          buffer: src.buffer,
          at: beatToSec(project, c.start),
          offset: c.offset,
          length: c.length,
          gain: c.gain,
          pan: c.pan,
          fadeIn: c.fadeIn,
          fadeOut: c.fadeOut,
        });
      }
      lanes.push({ id: lane.id, label: lane.name, volume: lane.volume, muted: lane.muted, solo: lane.solo, clips });
    }
    player.load(
      lanes,
      { kind: 'mashup', id: project.id, title: project.name, sub: 'Mashup', color: '--accent' },
      { keepPosition },
    );
  }

  $('mx-play').addEventListener('click', async () => {
    if (player.meta?.kind === 'mashup' && player.meta.id === project.id) {
      player.toggle();
      return;
    }
    if (!project.lanes.some((l) => l.clips.length)) return;
    $('mx-play').disabled = true;
    try {
      await loadIntoPlayer();
      player.play();
    } finally {
      $('mx-play').disabled = false;
    }
  });

  // --- Source list ---
  async function renderSources() {
    let list = [];
    try {
      list = await listSongs();
    } catch (e) {
      log(`Mashup : bibliothèque illisible (${e.message}).`);
    }
    songs = new Map(list.map((m) => [m.id, m]));
    const ul = $('mx-sources');
    ul.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = 'Séparez d\'abord un morceau : il apparaîtra ici.';
      ul.append(li);
    }
    for (const meta of list) {
      const li = document.createElement('li');
      li.className = 'source';
      const a = meta.analysis;
      li.innerHTML = '<strong class="source-name"></strong><span class="muted small tabular source-sub"></span><div class="source-stems"></div>';
      li.querySelector('.source-name').textContent = meta.name;
      li.querySelector('.source-sub').textContent = a
        ? `${a.bpm} BPM · ${keyName(a.tonic, a.mode)} · ${camelot(a.tonic, a.mode)}`
        : 'non analysé';
      for (const s of SOURCE_STEMS) {
        const chip = document.createElement('button');
        chip.className = 'stem-chip';
        chip.draggable = true;
        chip.textContent = s.label;
        chip.style.setProperty('--c', `var(${s.color})`);
        chip.title = `Ajouter « ${s.label} » de ${meta.name}`;
        chip.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-chimere-source', JSON.stringify({ songId: meta.id, stem: s.id }));
          e.dataTransfer.effectAllowed = 'copy';
        });
        chip.addEventListener('click', () => addClip(meta.id, s.id, null, secToBeat(project, playheadSec())));
        li.querySelector('.source-stems').append(chip);
      }
      ul.append(li);
    }
    renderClipsOnly();
  }

  function playheadSec() {
    return player.meta?.kind === 'mashup' && player.meta.id === project.id ? player.position : 0;
  }

  // --- Editing ---
  async function addClip(songId, stem, laneId, beat) {
    const meta = songs.get(songId) ?? (await getSong(songId));
    if (!meta) return;
    // The first clip sets the project tempo to its song's tempo.
    if (!project.lanes.some((l) => l.clips.length) && meta.analysis?.bpm) project.bpm = meta.analysis.bpm;
    let lane = project.lanes.find((l) => l.id === laneId);
    if (!lane) {
      lane = newLane(`${stemInfo(stem).label} · ${meta.name}`);
      project.lanes.push(lane);
    }
    const clip = newClip({ songId, stem, start: snapBeat(beat, $('mx-snap').value, project.beatsPerBar), length: meta.duration });
    lane.clips.push(clip);
    selected = clip.id;
    render();
    changed();
    getSource(songId, stem).then(renderClipsOnly, (e) => log(`Mashup : piste illisible (${e.message}).`));
  }

  function deleteSelected() {
    if (!selected) return;
    removeClip(project, selected);
    selected = null;
    render();
    changed();
  }

  // --- Rendering ---
  const totalBeats = () =>
    Math.max(64, Math.ceil((secToBeat(project, projectDuration(project)) + 32) / project.beatsPerBar) * project.beatsPerBar);

  function render() {
    $('mx-name').value = project.name;
    if (document.activeElement !== $('mx-bpm')) $('mx-bpm').value = String(project.bpm);
    const tl = $('mx-timeline');
    const width = totalBeats() * pxPerBeat;
    tl.style.setProperty('--head-w', `${HEAD_W}px`);
    tl.style.width = `${HEAD_W + width}px`;
    tl.innerHTML = '';

    // Ruler: bar numbers, click to seek.
    const ruler = document.createElement('div');
    ruler.className = 'tl-row tl-ruler';
    ruler.innerHTML = '<div class="tl-head muted small">Mesures</div><div class="tl-body"></div>';
    const rb = ruler.querySelector('.tl-body');
    const barPx = project.beatsPerBar * pxPerBeat;
    const every = barPx < 24 ? 8 : barPx < 48 ? 4 : 1;
    for (let bar = 0; bar * project.beatsPerBar < totalBeats(); bar += every) {
      const m = document.createElement('span');
      m.className = 'bar-num';
      m.style.left = `${bar * barPx}px`;
      m.textContent = String(bar + 1);
      rb.append(m);
    }
    rb.addEventListener('click', async (e) => {
      const beat = (e.clientX - rb.getBoundingClientRect().left) / pxPerBeat;
      if (player.meta?.kind !== 'mashup' || player.meta.id !== project.id) await loadIntoPlayer();
      player.seek(beatToSec(project, Math.max(0, beat)));
    });
    tl.append(ruler);

    for (const lane of project.lanes) tl.append(renderLane(lane));

    // Drop zone for a new lane.
    const add = document.createElement('div');
    add.className = 'tl-row tl-new';
    add.innerHTML = '<div class="tl-head muted small">Nouvelle ligne</div><div class="tl-body drop-hint">Déposez une piste ici pour créer une ligne</div>';
    wireDrop(add.querySelector('.tl-body'), null);
    tl.append(add);

    const ph = document.createElement('div');
    ph.className = 'tl-ph';
    ph.id = 'mx-ph';
    tl.append(ph);
    tl.style.setProperty('--beat-px', `${pxPerBeat}px`);
    tl.style.setProperty('--bar-px', `${barPx}px`);

    renderClipsOnly();
    renderInspector();
    renderPlayhead();
  }

  function renderLane(lane) {
    const row = document.createElement('div');
    row.className = 'tl-row tl-lane';
    row.dataset.lane = lane.id;
    row.innerHTML = `
      <div class="tl-head">
        <input class="lane-name" aria-label="Nom de la ligne" />
        <div class="lane-ctrl">
          <button class="tbtn" data-act="solo" aria-pressed="false" title="Solo">S</button>
          <button class="tbtn" data-act="mute" aria-pressed="false" title="Muet">M</button>
          <input class="tvol" type="range" min="0" max="1.5" step="0.01" aria-label="Volume de la ligne" />
          <button class="tbtn" data-act="remove" title="Supprimer la ligne" aria-label="Supprimer la ligne">×</button>
        </div>
      </div>
      <div class="tl-body"></div>`;
    const name = row.querySelector('.lane-name');
    name.value = lane.name;
    name.addEventListener('change', () => {
      lane.name = name.value.trim() || lane.name;
      changed({ audio: false });
    });
    row.querySelector('[data-act="solo"]').setAttribute('aria-pressed', String(lane.solo));
    row.querySelector('[data-act="mute"]').setAttribute('aria-pressed', String(lane.muted));
    const vol = row.querySelector('.tvol');
    vol.value = String(lane.volume);
    vol.addEventListener('input', () => {
      lane.volume = Number(vol.value);
      player.setTrack(lane.id, { volume: lane.volume });
      changed({ audio: false });
    });
    row.querySelector('.lane-ctrl').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'solo' || act === 'mute') {
        const key = act === 'solo' ? 'solo' : 'muted';
        lane[key] = !lane[key];
        e.target.setAttribute('aria-pressed', String(lane[key]));
        player.setTrack(lane.id, { [key]: lane[key] });
        changed({ audio: false });
        renderClipsOnly();
      } else if (act === 'remove') {
        if (lane.clips.length && !confirm(`Supprimer la ligne « ${lane.name} » et ses ${lane.clips.length} clip(s) ?`)) return;
        project.lanes = project.lanes.filter((l) => l !== lane);
        render();
        changed();
      }
    });
    wireDrop(row.querySelector('.tl-body'), lane.id);
    return row;
  }

  function wireDrop(body, laneId) {
    body.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-chimere-source')) return;
      e.preventDefault();
      body.classList.add('over');
    });
    body.addEventListener('dragleave', () => body.classList.remove('over'));
    body.addEventListener('drop', (e) => {
      body.classList.remove('over');
      const data = e.dataTransfer.getData('application/x-chimere-source');
      if (!data) return;
      e.preventDefault();
      const { songId, stem } = JSON.parse(data);
      const beat = (e.clientX - body.getBoundingClientRect().left) / pxPerBeat;
      addClip(songId, stem, laneId, e.altKey ? Math.max(0, beat) : beat);
    });
  }

  /** (Re)draw the clips of every lane without rebuilding the rows. */
  function renderClipsOnly() {
    if (!project) return;
    const anySolo = project.lanes.some((l) => l.solo);
    for (const lane of project.lanes) {
      const body = document.querySelector(`.tl-lane[data-lane="${lane.id}"] .tl-body`);
      if (!body) continue;
      body.querySelectorAll('.clip').forEach((n) => n.remove());
      const heard = anySolo ? lane.solo : !lane.muted;
      for (const clip of lane.clips) body.append(renderClip(clip, heard));
    }
  }

  function renderClip(clip, heard) {
    const info = stemInfo(clip.stem);
    const meta = songs.get(clip.songId);
    const el = document.createElement('div');
    el.className = 'clip';
    el.dataset.clip = clip.id;
    el.classList.toggle('selected', clip.id === selected);
    el.classList.toggle('off', !heard);
    el.classList.toggle('missing', !meta);
    el.style.setProperty('--c', `var(${info.color})`);
    el.style.left = `${clip.start * pxPerBeat}px`;
    el.style.width = `${Math.max(4, secToBeat(project, clip.length) * pxPerBeat)}px`;
    el.innerHTML = '<canvas></canvas><span class="clip-label"></span>';
    const songBpm = meta?.analysis?.bpm;
    const mismatch = songBpm && Math.abs(songBpm - project.bpm) > 0.5;
    el.querySelector('.clip-label').textContent =
      `${info.label} · ${meta?.name ?? 'source manquante'}` + (mismatch ? ` · ${songBpm} BPM ≠ ${project.bpm}` : '');
    if (mismatch) el.classList.add('mismatch');
    wireClipDrag(el, clip);
    // Mini waveform once the source is decoded.
    const src = sources.get(`${clip.songId}:${clip.stem}`);
    src?.then((s) => drawClipWave(el.querySelector('canvas'), s.peaks, clip, s.buffer.duration), () => {});
    return el;
  }

  function drawClipWave(canvas, peaks, clip, sourceDuration) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(8000, Math.round(canvas.clientWidth * dpr)));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    const a0 = (clip.offset / sourceDuration) * peaks.length;
    const span = (clip.length / sourceDuration) * peaks.length;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(a0 + (x * span) / w);
      const b = Math.max(a + 1, Math.floor(a0 + ((x + 1) * span) / w));
      let m = 0;
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const bar = Math.max(0.5, Math.min(1, m) * mid);
      ctx.fillRect(x, mid - bar, 1, 2 * bar);
    }
  }

  // Drag a clip: horizontal move snapped to the grid (Alt = free), vertical
  // move to another lane. A click without movement selects the clip.
  function wireClipDrag(el, clip) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // synthetic or already released pointer
      }
      const x0 = e.clientX;
      const start0 = clip.start;
      let moved = false;
      let targetLane = null;
      const onMove = (ev) => {
        const dx = ev.clientX - x0;
        if (!moved && Math.abs(dx) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
        moved = true;
        const raw = start0 + dx / pxPerBeat;
        clip.start = ev.altKey ? Math.max(0, raw) : snapBeat(raw, $('mx-snap').value, project.beatsPerBar);
        el.style.left = `${clip.start * pxPerBeat}px`;
        const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList?.contains('tl-lane'));
        targetLane = under?.dataset.lane ?? null;
        document.querySelectorAll('.tl-lane.target').forEach((n) => n.classList.remove('target'));
        under?.classList.add('target');
      };
      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        document.querySelectorAll('.tl-lane.target').forEach((n) => n.classList.remove('target'));
        selected = clip.id;
        if (moved) {
          if (targetLane) moveClipToLane(project, clip.id, targetLane);
          renderClipsOnly();
          changed();
        } else {
          renderClipsOnly();
        }
        renderInspector();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  // --- Inspector ---
  function renderInspector() {
    const found = selected && findClip(project, selected);
    $('mx-inspector').hidden = !found;
    if (!found) return;
    const { clip } = found;
    const meta = songs.get(clip.songId);
    $('mx-clip-title').textContent = `${stemInfo(clip.stem).label} · ${meta?.name ?? 'source manquante'}`;
    const at = beatToSec(project, clip.start);
    $('mx-clip-info').textContent =
      `mesure ${(clip.start / project.beatsPerBar + 1).toFixed(2)} · ${at.toFixed(2)} s · durée ${clip.length.toFixed(1)} s`;
    $('mx-gain').value = String(clip.gain);
    $('mx-pan').value = String(clip.pan);
    $('mx-fadein').value = String(clip.fadeIn);
    $('mx-fadeout').value = String(clip.fadeOut);
  }

  const selectedClip = () => (selected ? findClip(project, selected)?.clip : null);
  const bindNumber = (id, key, { min = -Infinity, max = Infinity, live = false } = {}) => {
    $(id).addEventListener(live ? 'input' : 'change', () => {
      const clip = selectedClip();
      if (!clip) return;
      const v = Number($(id).value);
      if (!Number.isFinite(v)) return;
      clip[key] = Math.min(max, Math.max(min, v));
      changed();
    });
  };
  bindNumber('mx-gain', 'gain', { min: 0, max: 1.5 });
  bindNumber('mx-pan', 'pan', { min: -1, max: 1 });
  bindNumber('mx-fadein', 'fadeIn', { min: 0 });
  bindNumber('mx-fadeout', 'fadeOut', { min: 0 });
  const nudge = (ms) => {
    const clip = selectedClip();
    if (!clip) return;
    clip.start = Math.max(0, clip.start + secToBeat(project, ms / 1000));
    renderClipsOnly();
    renderInspector();
    changed();
  };
  $('mx-nudge-l').addEventListener('click', () => nudge(-10));
  $('mx-nudge-r').addEventListener('click', () => nudge(10));
  $('mx-delete').addEventListener('click', deleteSelected);
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'Delete' && e.key !== 'Backspace') || !selected) return;
    if ($('mx-inspector').hidden || document.querySelector('[data-view="mashups"]').hidden) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    deleteSelected();
  });

  // --- Header controls ---
  $('mx-name').addEventListener('change', () => {
    project.name = $('mx-name').value.trim() || 'Sans titre';
    if (player.meta?.kind === 'mashup' && player.meta.id === project.id) player.meta.title = project.name;
    changed({ audio: false });
  });
  $('mx-bpm').addEventListener('change', () => {
    const v = Number($('mx-bpm').value);
    if (!(v >= 40 && v <= 250)) {
      $('mx-bpm').value = String(project.bpm);
      return;
    }
    // Clips keep their bar/beat position; their seconds change with the tempo.
    project.bpm = Math.round(v * 10) / 10;
    render();
    changed();
  });
  $('mx-zoom-in').addEventListener('click', () => {
    pxPerBeat = Math.min(96, pxPerBeat * 1.5);
    render();
  });
  $('mx-zoom-out').addEventListener('click', () => {
    pxPerBeat = Math.max(2, pxPerBeat / 1.5);
    render();
  });
  $('mx-new').addEventListener('click', async () => {
    if (project.lanes.length && !confirm('Commencer un nouveau mashup ? Le mashup actuel reste enregistré sur cette machine.')) return;
    if (player.meta?.kind === 'mashup') player.unload();
    const p = newProject();
    await saveProject(p);
    openProject(p);
  });

  // --- Playhead (display only; audio runs on the AudioContext clock) ---
  let raf = 0;
  function renderPlayhead() {
    const ph = $('mx-ph');
    if (!ph) return;
    const on = player.meta?.kind === 'mashup' && player.meta.id === project?.id;
    ph.hidden = !on;
    if (on) ph.style.left = `${HEAD_W + secToBeat(project, player.position) * pxPerBeat}px`;
    $('mx-play').textContent = on && player.playing ? 'Pause' : 'Écouter';
  }
  function tick() {
    renderPlayhead();
    raf = requestAnimationFrame(tick);
  }
  player.addEventListener('change', () => {
    cancelAnimationFrame(raf);
    renderPlayhead();
    if (player.playing && player.meta?.kind === 'mashup') raf = requestAnimationFrame(tick);
  });

  restore().catch((e) => log(`Mashup : ouverture impossible (${e.message}).`));
  return {
    /** Refresh the source list (after a separation or a library change). */
    refresh: renderSources,
  };
}
