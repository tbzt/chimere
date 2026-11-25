import '@fontsource-variable/inter';
import './style.css';
import { MODEL, MODEL_CACHE, SAMPLE_RATE, STEM_LABELS } from './config.js';
import { decodeFile, extract, channels, Player } from './audio.js';
import { computePeaks } from './wav.js';
import { songId, getSong, saveSong, updateMeta, loadTracks, listSongs, deleteSong } from './library.js';
import { keyName, keyNameFr, camelot } from './analysis.js';
import { initMashup } from './mashup.js';
import { startRouter } from './router.js';

const $ = (id) => document.getElementById(id);
const fmtMs = (ms) => (ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDuration = (sec) => (sec < 90 ? `${Math.max(1, Math.round(sec))} s` : `${Math.round(sec / 60)} min`);
const fmtMb = (bytes) => `${Math.round(bytes / 1e6)} Mo`;

// Display order of the tracks; the original is muted by default (A/B reference).
const TRACKS = [
  { id: 'vocals', label: STEM_LABELS.vocals, color: '--stem-vocals' },
  { id: 'drums', label: STEM_LABELS.drums, color: '--stem-drums' },
  { id: 'bass', label: STEM_LABELS.bass, color: '--stem-bass' },
  { id: 'other', label: STEM_LABELS.other, color: '--stem-other' },
  { id: 'original', label: 'Original', color: '--muted', muted: true },
];
const STEM_IDS = ['drums', 'bass', 'other', 'vocals'];
const LONG_SONG_SEC = 10 * 60;

const player = new Player();
// Exposed for debugging from the console.
window.chimerePlayer = player;

let worker = null;
let ready = false;
let backend = null;
let readyWaiters = [];
let gpuLikely = false;

/** File currently in the Séparer card: { name, audio, id } */
let current = null;
/** Song shown in the track view: { meta, buffers: {id: AudioBuffer}, state: {id: {...}}, peaks } */
let song = null;
let sepStart = 0;
/** File being separated (current may change meanwhile). */
let sepSource = null;

function log(text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}\n`;
  $('log').textContent += line;
  $('log').scrollTop = $('log').scrollHeight;
  console.log(text);
}

// --- Speed estimate (per-viewer convenience, so localStorage is fine) ---
const DEFAULT_RATIO = { webgpu: 0.5, wasm: 3.7 };
function speedRatio(b) {
  try {
    const v = Number(localStorage.getItem(`chimere-ratio-${b}`));
    if (v > 0) return v;
  } catch {
    // storage unavailable
  }
  return DEFAULT_RATIO[b];
}
function rememberRatio(b, ratio) {
  try {
    localStorage.setItem(`chimere-ratio-${b}`, String(ratio));
  } catch {
    // storage unavailable
  }
}

// --- Helper workers: encoding (int16, WAV) and analysis (tempo, key) ---
/** Request/response wrapper around a worker that replies { id, result | error }. */
// Workers are created inline (new Worker(new URL(…))) so Vite bundles them.
function jobWorker(w) {
  const jobs = new Map();
  let seq = 0;
  w.addEventListener('message', ({ data }) => {
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.result);
  });
  return (payload, transfer = []) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      jobs.set(id, { resolve, reject });
      w.postMessage({ id, ...payload }, transfer);
    });
  };
}
const encoderJob = jobWorker(
  new Worker(new URL('./encoder.worker.js', import.meta.url), { type: 'module', name: 'chimere-encoder' }),
);
const encode = (type, payload, transfer) => encoderJob({ type, ...payload }, transfer);
let mashup = null; // set once the helpers below exist
const analysisJob = jobWorker(
  new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module', name: 'chimere-analysis' }),
);

mashup = initMashup({ player, encode, log: (t) => log(t) });

// --- Environment (main thread view; the worker confirms its own) ---
async function showEnv() {
  $('env-coi').textContent = self.crossOriginIsolated
    ? 'oui (SharedArrayBuffer disponible)'
    : 'non — WASM limité à 1 thread';
  if (!('gpu' in navigator)) {
    $('env-webgpu').textContent = 'non disponible dans ce navigateur';
  } else {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    gpuLikely = Boolean(adapter);
    $('env-webgpu').textContent = adapter ? 'disponible' : 'API présente, aucun adaptateur GPU';
  }
  $('env-threads').textContent = '1 (plus avec ?threads=N)';
  if (!gpuLikely) setPill(false);
  await showCacheStatus();
}

const isModelCached = () =>
  caches.open(MODEL_CACHE).then((c) => c.match(MODEL.url)).then(Boolean).catch(() => false);

async function showCacheStatus() {
  const cached = await isModelCached();
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const parts = [
    cached ? `Modèle en cache (${fmtMb(MODEL.sizeBytes)}).` : 'Modèle absent du cache.',
  ];
  if (est?.usage != null) parts.push(`Espace utilisé par Chimère (modèle et bibliothèque) : ${fmtMb(est.usage)}.`);
  parts.push(persisted ? 'Stockage persistant accordé.' : 'Stockage non persistant : le navigateur peut le vider.');
  $('cache-status').textContent = parts.join(' ');
  $('clear-cache').disabled = !cached;
}

function setPill(gpu) {
  const pill = $('backend-pill');
  pill.textContent = gpu ? 'WebGPU' : 'WASM · mode lent';
  pill.className = `pill ${gpu ? 'fast' : 'slow'}`;
  pill.title = gpu ? '' : 'Sans WebGPU, la séparation prend plusieurs fois la durée du morceau.';
}

// --- Separation worker ---
let watchdog = null;
const WATCHDOG_MS = 45000;

function startWorker(threadsOverride) {
  clearTimeout(watchdog);
  worker?.terminate();
  ready = false;
  backend = null;
  updateButtons();
  // Ask the browser not to evict the model and the library under storage pressure.
  navigator.storage?.persist?.().then((granted) => log(`Stockage persistant : ${granted ? 'accordé' : 'refusé'}.`));
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'chimere-separator' });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', (e) => log(`Erreur du worker : ${e.message}`));
  // ?threads=N asks for multithreaded WASM (hangs in a Worker on some browsers).
  const threads = threadsOverride ?? (Number(new URLSearchParams(location.search).get('threads')) || 1);
  const cpuNodes = new URLSearchParams(location.search).get('cpunodes') !== '0';
  worker.postMessage({ type: 'init', forceWasm: $('force-wasm').checked, threads, cpuNodes });
  $('model-status').textContent = 'Chargement du modèle…';
}

/** Resolves once the model session is ready (starting the worker if needed). */
function whenReady() {
  if (ready) return Promise.resolve();
  if (!worker) startWorker();
  return new Promise((resolve, reject) => readyWaiters.push({ resolve, reject }));
}

function stopWorker() {
  clearTimeout(watchdog);
  worker?.terminate();
  worker = null;
  ready = false;
  for (const w of readyWaiters) w.reject(new Error('annulé'));
  readyWaiters = [];
}

function onWorkerMessage({ data: msg }) {
  switch (msg.type) {
    case 'log':
      log(msg.text);
      break;
    case 'download': {
      const p = $('dl');
      p.hidden = msg.cached || msg.loaded >= msg.total;
      p.max = msg.total;
      p.value = msg.loaded;
      if (!msg.cached) {
        $('model-status').textContent = `Téléchargement du modèle : ${fmtMb(msg.loaded)} / ${fmtMb(msg.total)} (une seule fois)`;
      }
      break;
    }
    case 'env':
      $('env-webgpu').textContent = msg.webgpu.ok
        ? `disponible${msg.webgpu.description ? ` (${msg.webgpu.description})` : ''}`
        : `non (${msg.webgpu.reason})`;
      $('env-threads').textContent = String(msg.threads);
      if (msg.threads > 1) {
        // Watchdog only for diagnostics; audio timing never uses setTimeout.
        watchdog = setTimeout(() => {
          log(`Session bloquée après ${WATCHDOG_MS / 1000} s avec ${msg.threads} threads : redémarrage en 1 thread.`);
          startWorker(1);
        }, WATCHDOG_MS);
      }
      break;
    case 'backend': {
      backend = msg.backend;
      const gpu = backend === 'webgpu';
      $('env-backend').textContent = gpu ? 'WebGPU' : `WASM, ${msg.threads} thread(s) — mode lent`;
      setPill(gpu);
      showFileInfo();
      break;
    }
    case 'ready':
      clearTimeout(watchdog);
      ready = true;
      $('dl').hidden = true;
      $('model-status').textContent = `Modèle prêt (${fmtMs(msg.loadMs)}).`;
      for (const w of readyWaiters) w.resolve();
      readyWaiters = [];
      updateButtons();
      showCacheStatus();
      break;
    case 'progress':
      onProgress(msg);
      break;
    case 'result':
      onResult(msg).catch((e) => {
        log(`Erreur après la séparation : ${e.message}`);
        $('sep-status').textContent = `Erreur : ${e.message}`;
      });
      break;
    case 'fallback':
      $('sep-status').textContent =
        'WebGPU donne un résultat faux sur ce navigateur : nouvelle séparation en WASM, plus lente…';
      sepStart = performance.now();
      break;
    case 'compare':
      onCompare(msg);
      break;
    case 'error':
      log(`Erreur : ${msg.text}`);
      if (!ready) {
        for (const w of readyWaiters) w.reject(new Error(msg.text));
        readyWaiters = [];
        $('model-status').textContent = `Erreur : ${msg.text}`;
      }
      $('sep-status').textContent = `Erreur : ${msg.text}`;
      $('compare-status').textContent = '';
      endSeparationUi();
      break;
  }
}

// --- File input ---
async function loadFile(file) {
  if (!file) return;
  $('drop-text').textContent = `Décodage de « ${file.name} »…`;
  $('file-info').textContent = '';
  current = null;
  updateButtons();
  try {
    const { audio, bytes } = await decodeFile(file);
    const id = await songId(bytes);
    current = { name: file.name.replace(/\.[^.]+$/, ''), audio, id };
    $('drop-text').textContent = file.name;
    const known = await getSong(id).catch(() => null);
    if (known) {
      $('file-info').textContent = 'Déjà séparé : ouverture depuis la bibliothèque, sans recalcul.';
      await openSong(known);
    } else {
      showFileInfo();
      // Warm the model up while the user reads the estimate.
      if (!worker) startWorker();
    }
  } catch (e) {
    current = null;
    $('drop-text').textContent = `Impossible de décoder ce fichier (${e.message || e}).`;
  }
  updateButtons();
}

function showFileInfo() {
  if (!current) return;
  const { audio } = current;
  const b = backend ?? (gpuLikely ? 'webgpu' : 'wasm');
  const eta = audio.duration * speedRatio(b);
  const parts = [
    `${fmtTime(audio.duration)}, ${audio.numberOfChannels === 1 ? 'mono' : 'stéréo'}, rééchantillonné à 44,1 kHz.`,
    b === 'webgpu'
      ? `Séparation estimée : environ ${fmtDuration(eta)} (WebGPU).`
      : `Mode lent (WASM, sans WebGPU) : environ ${fmtDuration(eta)}. Chrome ou Edge récents avec WebGPU vont bien plus vite.`,
  ];
  if (audio.duration > LONG_SONG_SEC) {
    parts.push(`Morceau long : le calcul demande environ ${fmtMb(audio.duration * SAMPLE_RATE * 2 * 4 * 6)} de mémoire.`);
  }
  $('file-info').textContent = parts.join(' ');
}

$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  loadFile(e.dataTransfer.files[0]);
});

// --- Separation ---
let separating = false;

function updateButtons() {
  $('run').disabled = !current || separating;
  $('compare').disabled = !(ready && current && backend === 'webgpu' && !separating);
}

$('run').addEventListener('click', async () => {
  if (!current) return;
  separating = true;
  updateButtons();
  $('cancel').hidden = false;
  $('sep').hidden = false;
  $('sep').value = 0;
  $('sep-status').textContent = ready ? 'Séparation…' : 'Chargement du modèle…';
  try {
    await whenReady();
  } catch (e) {
    endSeparationUi();
    return;
  }
  sepSource = current;
  const [l, r] = channels(current.audio);
  const left = l.slice();
  const right = r.slice();
  sepStart = performance.now();
  $('sep-status').textContent = 'Séparation…';
  worker.postMessage({ type: 'separate', left, right }, [left.buffer, right.buffer]);
});

$('cancel').addEventListener('click', () => {
  stopWorker();
  log('Séparation annulée.');
  $('sep-status').textContent = 'Séparation annulée.';
  $('model-status').textContent = '';
  endSeparationUi();
});

function endSeparationUi() {
  separating = false;
  $('cancel').hidden = true;
  $('sep').hidden = true;
  updateButtons();
}

function onProgress({ done, total }) {
  $('sep').max = total;
  $('sep').value = done;
  const elapsed = (performance.now() - sepStart) / 1000;
  const left = done > 0 ? (elapsed / done) * (total - done) : NaN;
  $('sep-status').textContent =
    `Fenêtre ${done} / ${total}` + (done > 0 && done < total ? ` · reste environ ${fmtDuration(left)}` : '');
}

async function onResult({ stems, backend: used, ms }) {
  endSeparationUi();
  const src = sepSource;
  const ratio = ms / 1000 / src.audio.duration;
  rememberRatio(used, ratio);
  log(`Séparation : ${fmtMs(ms)} en ${used}, ×${ratio.toFixed(2)} temps réel.`);
  $('sep-status').textContent = `Séparation terminée en ${fmtDuration(ms / 1000)} (${used === 'webgpu' ? 'WebGPU' : 'WASM'}).`;

  const buffers = { original: src.audio };
  for (const id of STEM_IDS) buffers[id] = player.makeBuffer(stems[id][0], stems[id][1]);
  const meta = {
    id: src.id,
    name: src.name,
    duration: src.audio.duration,
    createdAt: Date.now(),
    backend: used,
    ms,
    tracks: ['original', ...STEM_IDS],
  };
  let saved;
  song = null;
  const savedPromise = new Promise((resolve) => (saved = resolve));
  showSong(meta, buffers, savedPromise);
  player.play();

  // Store in the library as int16 (encoded in a worker; stems are transferred).
  $('export-status').textContent = 'Enregistrement dans la bibliothèque…';
  const [ol, or] = channels(src.audio);
  const tracks = { original: [ol.slice(), or.slice()] };
  const transfer = [tracks.original[0].buffer, tracks.original[1].buffer];
  for (const id of STEM_IDS) {
    tracks[id] = stems[id];
    transfer.push(stems[id][0].buffer, stems[id][1].buffer);
  }
  try {
    const pcm = await encode('int16', { tracks }, transfer);
    meta.bytes = Object.values(pcm).reduce((s, a) => s + a.byteLength, 0);
    await saveSong(meta, pcm);
    saved(true);
    $('export-status').textContent = `Enregistré dans la bibliothèque (${fmtMb(meta.bytes)}).`;
    renderLibrary();
    showCacheStatus();
  } catch (e) {
    saved(false);
    log(`Bibliothèque : échec de l'enregistrement (${e.message}).`);
    $('export-status').textContent = `Pas enregistré dans la bibliothèque : ${e.message}`;
  }
}

// --- Track view ---
/** @param {Promise<boolean>} saved resolves true once the song is in the library */
function showSong(meta, buffers, saved = Promise.resolve(true)) {
  const state = {};
  for (const t of TRACKS) state[t.id] = { volume: 1, muted: Boolean(t.muted), solo: false };
  const peaks = {};
  for (const t of TRACKS) {
    const [l, r] = channels(buffers[t.id]);
    peaks[t.id] = computePeaks(l, r, 2000);
  }
  song = { meta, buffers, state, peaks, saved };
  loadSongIntoPlayer();
  $('song').hidden = false;
  $('song-title').textContent = meta.name;
  $('song-meta').textContent = `${fmtTime(meta.duration)} · séparé en ${fmtDuration(meta.ms / 1000)} (${meta.backend === 'webgpu' ? 'WebGPU' : 'WASM'})`;
  $('export-status').textContent = '';
  renderTracks();
  renderAnalysis();
  if (!meta.analysis) runAnalysis(song);
}

// --- Analysis: tempo and key ---
const KEY_OPTIONS = [];
for (const mode of ['major', 'minor']) {
  for (let tonic = 0; tonic < 12; tonic++) KEY_OPTIONS.push({ tonic, mode });
}
// Sorted along the Camelot wheel (1A, 1B, 2A…), the order DJs read it in.
KEY_OPTIONS.sort((a, b) => {
  const ca = camelot(a.tonic, a.mode);
  const cb = camelot(b.tonic, b.mode);
  return parseInt(ca, 10) - parseInt(cb, 10) || ca.localeCompare(cb);
});
for (const k of KEY_OPTIONS) {
  const o = document.createElement('option');
  o.value = `${k.tonic}:${k.mode}`;
  o.textContent = `${camelot(k.tonic, k.mode)} · ${keyNameFr(k.tonic, k.mode)} (${keyName(k.tonic, k.mode)})`;
  $('key').append(o);
}

async function runAnalysis(target) {
  $('analysis-status').textContent = 'Analyse du tempo et de la tonalité…';
  try {
    const copy = (id) => channels(target.buffers[id]).map((a) => a.slice());
    const rhythm = [copy('drums')];
    const harmonic = [copy('bass'), copy('other')];
    const transfer = [...rhythm, ...harmonic].flat().map((a) => a.buffer);
    const auto = await analysisJob({ rhythm, harmonic }, transfer);
    log(
      `Analyse : ${auto.bpm} BPM (confiance ${auto.bpmConfidence.toFixed(2)}), ` +
        `${keyName(auto.tonic, auto.mode)} (score ${auto.keyScore.toFixed(2)}, écart ${auto.keyMargin.toFixed(3)}), ${fmtMs(auto.ms)}.`,
    );
    target.meta.analysis = { auto, bpm: auto.bpm, tonic: auto.tonic, mode: auto.mode };
    if (song === target) {
      $('analysis-status').textContent = '';
      renderAnalysis();
    }
    await persistMeta(target);
  } catch (e) {
    log(`Analyse impossible : ${e.message}`);
    if (song === target) $('analysis-status').textContent = `Analyse impossible : ${e.message}`;
  }
}

async function persistMeta(target) {
  if (await target.saved) {
    await updateMeta(target.meta).catch((e) => log(`Bibliothèque : ${e.message}`));
    renderLibrary();
  }
}

function renderAnalysis() {
  const a = song?.meta.analysis;
  const disabled = !a;
  for (const id of ['bpm', 'bpm-half', 'bpm-double', 'tap', 'key']) $(id).disabled = disabled;
  if (!a) {
    $('bpm').value = '';
    $('camelot').textContent = '—';
    $('analysis-reset').hidden = true;
    return;
  }
  if (document.activeElement !== $('bpm')) $('bpm').value = String(a.bpm);
  $('key').value = `${a.tonic}:${a.mode}`;
  $('camelot').textContent = camelot(a.tonic, a.mode);
  const corrected = a.bpm !== a.auto.bpm || a.tonic !== a.auto.tonic || a.mode !== a.auto.mode;
  $('analysis-reset').hidden = !corrected;
  const doubts = [];
  if (!corrected && a.auto.bpmConfidence < 0.25) doubts.push('tempo incertain');
  if (!corrected && a.auto.keyMargin < 0.02) doubts.push('tonalité incertaine');
  $('analysis-status').textContent = corrected
    ? 'Valeurs corrigées à la main.'
    : doubts.length
      ? `Détection : ${doubts.join(', ')}, à vérifier à l'oreille.`
      : 'Valeurs détectées automatiquement.';
}

function setAnalysis(changes) {
  if (!song?.meta.analysis) return;
  Object.assign(song.meta.analysis, changes);
  renderAnalysis();
  persistMeta(song);
}

const clampBpm = (v) => Math.round(Math.min(250, Math.max(40, v)) * 10) / 10;
$('bpm').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (v > 0) setAnalysis({ bpm: clampBpm(v) });
  else renderAnalysis();
});
$('bpm-half').addEventListener('click', () => setAnalysis({ bpm: clampBpm(song.meta.analysis.bpm / 2) }));
$('bpm-double').addEventListener('click', () => setAnalysis({ bpm: clampBpm(song.meta.analysis.bpm * 2) }));
$('key').addEventListener('change', (e) => {
  const [tonic, mode] = e.target.value.split(':');
  setAnalysis({ tonic: Number(tonic), mode });
});
$('analysis-reset').addEventListener('click', () => {
  const { auto } = song.meta.analysis;
  setAnalysis({ bpm: auto.bpm, tonic: auto.tonic, mode: auto.mode });
});

// Tap tempo: average of the last intervals between clicks (UI input timing,
// not audio scheduling). A pause of more than 2 s starts a new series.
let taps = [];
$('tap').addEventListener('pointerdown', (e) => {
  const t = e.timeStamp;
  if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
  taps.push(t);
  taps = taps.slice(-9);
  if (taps.length >= 4) {
    const bpm = (60000 * (taps.length - 1)) / (taps[taps.length - 1] - taps[0]);
    setAnalysis({ bpm: clampBpm(bpm) });
    $('analysis-status').textContent = `Tap tempo : ${taps.length} frappes.`;
  } else {
    $('analysis-status').textContent = `Tap tempo : continuez (${taps.length}/4)…`;
  }
});

function loadSongIntoPlayer() {
  player.load(
    TRACKS.map((t) => ({ ...t, buffer: song.buffers[t.id], ...song.state[t.id] })),
    { kind: 'song', id: song.meta.id, title: song.meta.name, sub: 'Pistes séparées', color: '--accent' },
  );
}

/** Make sure the player holds the current song (the diagnostic may have replaced it). */
function ensureSong() {
  if (song && player.meta?.id !== song.meta.id) loadSongIntoPlayer();
}

function renderTracks() {
  const box = $('tracks');
  box.innerHTML = '';
  for (const t of TRACKS) {
    const row = document.createElement('div');
    row.className = 'track';
    row.dataset.id = t.id;
    row.style.setProperty('--c', `var(${t.color})`);
    row.innerHTML = `
      <div class="track-head">
        <span class="chip"></span>
        <strong class="track-name"></strong>
        <button class="tbtn" data-act="solo" title="Solo : n'écouter que cette piste" aria-pressed="false">S</button>
        <button class="tbtn" data-act="mute" title="Muet" aria-pressed="false">M</button>
        <input class="tvol" type="range" min="0" max="1.5" step="0.01" value="1" aria-label="Volume" />
        <button class="tbtn" data-act="export" title="Exporter en WAV" aria-label="Exporter en WAV">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
        </button>
      </div>
      <div class="wave-wrap"><canvas class="wave"></canvas><div class="ph"></div></div>`;
    row.querySelector('.track-name').textContent = t.label;
    row.querySelector('.tvol').value = String(song.state[t.id].volume);
    row.querySelector('.tvol').setAttribute('aria-label', `Volume ${t.label}`);
    box.append(row);
  }
  renderTrackState();
  drawWaves();
}

function renderTrackState() {
  if (!song) return;
  const anySolo = Object.values(song.state).some((s) => s.solo);
  for (const row of $('tracks').children) {
    const st = song.state[row.dataset.id];
    const audible = anySolo ? st.solo : !st.muted;
    row.classList.toggle('off', !audible);
    row.querySelector('[data-act="solo"]').setAttribute('aria-pressed', String(st.solo));
    row.querySelector('[data-act="mute"]').setAttribute('aria-pressed', String(st.muted));
  }
}

function setTrackState(id, changes) {
  ensureSong();
  Object.assign(song.state[id], changes);
  player.setTrack(id, changes);
  renderTrackState();
}

$('tracks').addEventListener('click', (e) => {
  const row = e.target.closest('.track');
  if (!row || !song) return;
  const id = row.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'solo') setTrackState(id, { solo: !song.state[id].solo });
  else if (act === 'mute') setTrackState(id, { muted: !song.state[id].muted });
  else if (act === 'export') exportTracks([id], TRACKS.find((t) => t.id === id).label);
  else if (e.target.closest('.wave-wrap')) {
    ensureSong();
    const rect = e.target.closest('.wave-wrap').getBoundingClientRect();
    player.seek(((e.clientX - rect.left) / rect.width) * player.duration);
  }
});
$('tracks').addEventListener('input', (e) => {
  if (!e.target.classList.contains('tvol')) return;
  setTrackState(e.target.closest('.track').dataset.id, { volume: Number(e.target.value) });
});

function drawWaves() {
  if (!song) return;
  const dpr = window.devicePixelRatio || 1;
  for (const row of $('tracks').children) {
    const canvas = row.querySelector('canvas');
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(row).getPropertyValue('--c').trim() || '#888';
    const peaks = song.peaks[row.dataset.id];
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x * peaks.length) / w);
      const b = Math.max(a + 1, Math.floor(((x + 1) * peaks.length) / w));
      let m = 0;
      for (let i = a; i < b; i++) if (peaks[i] > m) m = peaks[i];
      const bar = Math.max(1, Math.min(1, m) * mid);
      ctx.fillRect(x, mid - bar, 1, 2 * bar);
    }
  }
}
new ResizeObserver(() => drawWaves()).observe($('tracks'));

// --- Export (WAV, encoded in a worker) ---
async function exportTracks(ids, label) {
  if (!song) return;
  const status = $('export-status');
  status.textContent = `Encodage de « ${label} »…`;
  try {
    const signals = ids.map((id) => channels(song.buffers[id]).map((a) => a.slice()));
    const transfer = signals.flatMap(([l, r]) => [l.buffer, r.buffer]);
    const wav = await encode('wav', { signals, sampleRate: SAMPLE_RATE }, transfer);
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${song.meta.name} - ${label}.wav`;
    document.body.append(a);
    a.click();
    a.remove();
    // Give the download time to start before freeing the blob (not audio timing).
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = `« ${a.download} » exporté (${fmtMb(wav.byteLength)}).`;
  } catch (e) {
    status.textContent = `Échec de l'export : ${e.message}`;
  }
}

$('export-inst').addEventListener('click', () => exportTracks(['drums', 'bass', 'other'], 'Instrumental'));
$('export-all').addEventListener('click', async () => {
  for (const id of STEM_IDS) await exportTracks([id], STEM_LABELS[id]);
});

// --- Library ---
async function openSong(meta) {
  $('export-status').textContent = 'Ouverture depuis la bibliothèque…';
  const pcm = await loadTracks(meta);
  const transfer = Object.values(pcm).map((a) => a.buffer);
  const floats = await encode('float', { tracks: pcm }, transfer);
  const buffers = {};
  for (const id of meta.tracks) buffers[id] = player.makeBuffer(floats[id][0], floats[id][1]);
  showSong(meta, buffers);
  if (location.hash !== '#/separer') location.hash = '#/separer';
}

async function renderLibrary() {
  let songs = [];
  try {
    songs = await listSongs();
  } catch (e) {
    log(`Bibliothèque illisible : ${e.message}`);
  }
  $('library-empty').hidden = songs.length > 0;
  mashup?.refresh();
  const list = $('library-list');
  list.innerHTML = '';
  for (const meta of songs) {
    const li = document.createElement('li');
    li.className = 'song-card';
    li.innerHTML = `
      <div class="cover"></div>
      <div class="song-text">
        <strong class="song-name"></strong>
        <span class="muted small tabular song-sub"></span>
      </div>
      <button class="primary" data-act="open">Ouvrir</button>
      <button data-act="delete">Supprimer</button>`;
    li.querySelector('.song-name').textContent = meta.name;
    const a = meta.analysis;
    li.querySelector('.song-sub').textContent = [
      fmtTime(meta.duration),
      a && `${a.bpm} BPM`,
      a && `${keyName(a.tonic, a.mode)} · ${camelot(a.tonic, a.mode)}`,
      new Date(meta.createdAt).toLocaleDateString('fr-FR'),
      fmtMb(meta.bytes ?? 0),
    ]
      .filter(Boolean)
      .join(' · ');
    li.querySelector('.cover').style.background = coverGradient(meta.id);
    li.querySelector('[data-act="open"]').addEventListener('click', () =>
      openSong(meta).catch((e) => log(`Ouverture impossible : ${e.message}`)),
    );
    li.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm(`Supprimer « ${meta.name} » de la bibliothèque ? Il faudra le séparer à nouveau.`)) return;
      if (song?.meta.id === meta.id) {
        player.unload();
        song = null;
        $('song').hidden = true;
      }
      await deleteSong(meta.id);
      renderLibrary();
      showCacheStatus();
    });
    list.append(li);
  }
}

/** Gradient "cover" derived from the song id, in the stem colours. */
function coverGradient(id) {
  const n = parseInt(id.slice(0, 6), 16) || 0;
  const colors = ['var(--stem-vocals)', 'var(--stem-drums)', 'var(--stem-bass)', 'var(--stem-other)'];
  const a = colors[n % 4];
  const b = colors[(n >> 2) % 4 === n % 4 ? (n + 1) % 4 : (n >> 2) % 4];
  return `linear-gradient(${n % 360}deg, ${a}, ${b})`;
}

// --- WebGPU / WASM diagnostic ---
function onCompare({ rows, vocalsGpu, vocalsCpu }) {
  updateButtons();
  const pct = (x) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)} %`;
  const worst = Math.max(...rows.combined.map((r) => r.rel));
  $('compare-status').textContent =
    worst < 0.02
      ? `Écart maximal ${pct(worst)} : WebGPU calcule comme WASM.`
      : `Écart maximal ${pct(worst)} : WebGPU donne un résultat différent de WASM sur ce navigateur.`;
  const t = $('compare-table');
  t.hidden = false;
  t.innerHTML = '<tr><th>Piste</th><th>Écart total</th><th>Branche temps</th><th>Branche fréquence</th><th>Niveau WebGPU / WASM</th></tr>';
  rows.combined.forEach((r, i) => {
    const tr = document.createElement('tr');
    const cells = [
      STEM_LABELS[r.name],
      pct(r.rel),
      pct(rows.time[i].rel),
      pct(rows.freq[i].rel),
      `${r.rmsA.toFixed(3)} / ${r.rmsB.toFixed(3)}`,
    ];
    cells.forEach((c, j) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (j >= 1 && j <= 3 && [r.rel, rows.time[i].rel, rows.freq[i].rel][j - 1] > 0.02) td.className = 'bad';
      tr.append(td);
    });
    t.append(tr);
  });
  log(`Comparaison WebGPU / WASM : ${rows.combined.map((r) => `${r.name} ${pct(r.rel)}`).join(', ')}.`);

  const box = $('compare-players');
  box.innerHTML = '';
  for (const [id, label, [l, r]] of [
    ['cmp-gpu', 'Voix WebGPU', vocalsGpu],
    ['cmp-cpu', 'Voix WASM', vocalsCpu],
  ]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.setProperty('--c', 'var(--stem-vocals)');
    const buffer = player.makeBuffer(l, r);
    b.addEventListener('click', () => {
      const same = player.meta?.kind === 'compare';
      player.load([{ id, label, color: '--stem-vocals', buffer }], { kind: 'compare', id, title: label, sub: 'Diagnostic, 7,8 s', color: '--stem-vocals' }, { keepPosition: same });
      player.play();
    });
    box.append(b);
  }
}

$('compare').addEventListener('click', () => {
  if (!current) return;
  player.pause();
  const start = Math.max(0, current.audio.duration / 2 - 3.9);
  const { left, right } = extract(current.audio, start, 7.8);
  $('compare').disabled = true;
  $('compare-status').textContent = 'Comparaison en cours (environ 30 s en WASM)…';
  worker.postMessage({ type: 'compare', left, right }, [left.buffer, right.buffer]);
});

// --- Bottom player ---
let raf = 0;

function renderPlayer() {
  const has = player.tracks.length > 0;
  $('player').classList.toggle('playing', player.playing);
  $('play').disabled = !has;
  $('play').setAttribute('aria-label', player.playing ? 'Pause' : 'Lecture');
  $('seek').disabled = !has;
  $('seek').max = String(player.duration || 1);
  $('time-dur').textContent = fmtTime(player.duration);
  if (has) {
    $('now-title').textContent = player.meta.title;
    $('now-sub').textContent = player.meta.sub;
    $('now-dot').style.setProperty('--c', `var(${player.meta.color})`);
  } else {
    $('now-title').textContent = 'Rien en lecture';
    $('now-sub').textContent = 'Séparez un morceau pour l\'écouter';
    $('now-dot').style.removeProperty('--c');
  }
  renderPosition();
  cancelAnimationFrame(raf);
  if (player.playing) raf = requestAnimationFrame(tick);
}

let seeking = false;
function renderPosition() {
  const pos = player.position;
  if (!seeking) {
    $('seek').value = String(pos);
    $('time-pos').textContent = fmtTime(pos);
  }
  const onSong = song && player.meta?.id === song.meta.id;
  const frac = onSong && player.duration ? pos / player.duration : 0;
  for (const ph of $('tracks').querySelectorAll('.ph')) {
    ph.style.left = `${frac * 100}%`;
    ph.hidden = !onSong;
  }
}

// Display refresh only; playback itself is scheduled on the AudioContext.
function tick() {
  renderPosition();
  raf = requestAnimationFrame(tick);
}

player.addEventListener('change', renderPlayer);
$('play').addEventListener('click', () => player.toggle());
$('seek').addEventListener('input', (e) => {
  seeking = true;
  $('time-pos').textContent = fmtTime(Number(e.target.value));
});
$('seek').addEventListener('change', (e) => {
  seeking = false;
  player.seek(Number(e.target.value));
});
$('volume').addEventListener('input', (e) => {
  player.volume = Number(e.target.value);
});
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !player.tracks.length) return;
  if (e.target.closest('input, button, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  player.toggle();
});

// --- Settings ---
$('force-wasm').addEventListener('change', () => {
  if (worker && !separating) {
    log('Changement de backend : rechargement de la session.');
    startWorker();
  }
});

$('clear-cache').addEventListener('click', async () => {
  if (!confirm('Supprimer le modèle du cache ? Il faudra le retélécharger (181 Mo).')) return;
  await caches.delete(MODEL_CACHE);
  log('Modèle supprimé du cache.');
  showEnv();
});

// --- Views ---
startRouter((name) => {
  document.querySelectorAll('[data-view]').forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.querySelector('.content').scrollTo(0, 0);
  document.title = `${document.querySelector(`.nav a[data-route="${name}"] span`).textContent} · Chimère`;
  if (name === 'bibliotheque') renderLibrary();
  if (name === 'separer') requestAnimationFrame(drawWaves);
});

log(`Modèle : ${MODEL.repo}/${MODEL.file} @ ${MODEL.revision.slice(0, 8)}`);
showEnv();
renderLibrary();
