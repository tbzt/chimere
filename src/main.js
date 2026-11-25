import '@fontsource-variable/inter';
import './style.css';
import { MODEL, MODEL_CACHE, STEM_LABELS } from './config.js';
import { decodeFile, extract, Player, mix } from './audio.js';
import { startRouter } from './router.js';

const $ = (id) => document.getElementById(id);
const fmtMs = (ms) => (ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const player = new Player();
// Exposed for debugging from the console.
window.chimerePlayer = player;
let worker = null;
let ready = false;
let decoded = null;
let fileName = '';
let extractDur = 0;

function log(text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}\n`;
  $('log').textContent += line;
  $('log').scrollTop = $('log').scrollHeight;
  console.log(text);
}

function updateRunButton() {
  $('run').disabled = !(ready && decoded);
}

// --- Environment (main thread view; the worker confirms its own) ---
async function showEnv() {
  $('env-coi').textContent = self.crossOriginIsolated
    ? 'oui (SharedArrayBuffer disponible)'
    : 'non — WASM limité à 1 thread';
  if (!('gpu' in navigator)) {
    $('env-webgpu').textContent = 'non disponible dans ce navigateur';
  } else {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    $('env-webgpu').textContent = adapter ? 'disponible' : 'API présente, aucun adaptateur GPU';
  }
  $('env-threads').textContent = '1 (plus avec ?threads=N)';

  const cached = await isModelCached();
  $('model-status').textContent = cached
    ? 'Modèle déjà en cache : le chargement sera rapide.'
    : `Le modèle (${(MODEL.sizeBytes / 1e6).toFixed(0)} Mo) sera téléchargé une seule fois.`;
  await showCacheStatus();
}

const isModelCached = () =>
  caches.open(MODEL_CACHE).then((c) => c.match(MODEL.url)).then(Boolean).catch(() => false);

async function showCacheStatus() {
  const cached = await isModelCached();
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const parts = [
    cached ? `Modèle en cache (${(MODEL.sizeBytes / 1e6).toFixed(0)} Mo).` : 'Modèle absent du cache.',
  ];
  if (est?.usage != null) parts.push(`Espace utilisé par Chimère : ${(est.usage / 1e6).toFixed(0)} Mo.`);
  parts.push(persisted ? 'Stockage persistant accordé.' : 'Stockage non persistant : le navigateur peut le vider.');
  $('cache-status').textContent = parts.join(' ');
  $('clear-cache').disabled = !cached;
}

// --- Worker ---
let watchdog = null;
const WATCHDOG_MS = 45000;

function startWorker(threadsOverride) {
  clearTimeout(watchdog);
  worker?.terminate();
  ready = false;
  updateRunButton();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'chimere-separator' });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', (e) => log(`Erreur du worker : ${e.message}`));
  // ?threads=N asks for multithreaded WASM (hangs in a Worker on some browsers).
  const threads = threadsOverride ?? (Number(new URLSearchParams(location.search).get('threads')) || 1);
  worker.postMessage({ type: 'init', forceWasm: $('force-wasm').checked, threads });
}

function onWorkerMessage({ data: msg }) {
  switch (msg.type) {
    case 'log':
      log(msg.text);
      break;
    case 'download': {
      const p = $('dl');
      p.hidden = false;
      p.max = msg.total;
      p.value = msg.loaded;
      if (!msg.cached) {
        $('model-status').textContent = `Téléchargement : ${(msg.loaded / 1e6).toFixed(0)} / ${(msg.total / 1e6).toFixed(0)} Mo`;
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
      const gpu = msg.backend === 'webgpu';
      $('env-backend').textContent = gpu ? 'WebGPU' : `WASM, ${msg.threads} thread(s) — mode lent`;
      const pill = $('backend-pill');
      pill.textContent = gpu ? 'WebGPU' : 'WASM · mode lent';
      pill.className = `pill ${gpu ? 'fast' : 'slow'}`;
      pill.title = gpu ? '' : 'Sans WebGPU, la séparation prend plusieurs fois la durée du morceau.';
      break;
    }
    case 'ready':
      clearTimeout(watchdog);
      ready = true;
      $('model-status').textContent = `Modèle prêt (${fmtMs(msg.loadMs)}).`;
      $('load').textContent = 'Recharger le modèle';
      $('load').disabled = false;
      updateRunButton();
      showCacheStatus();
      break;
    case 'progress':
      $('sep').max = msg.total;
      $('sep').value = msg.done;
      $('sep-status').textContent = `Fenêtre ${msg.done} / ${msg.total}`;
      break;
    case 'result':
      onResult(msg);
      break;
    case 'error':
      log(`Erreur : ${msg.text}`);
      $('sep-status').textContent = `Erreur : ${msg.text}`;
      $('load').disabled = false;
      $('run').disabled = !ready || !decoded;
      break;
  }
}

// --- Results ---

function onResult({ stems, backend, ms }) {
  $('run').disabled = false;
  $('sep-status').textContent = 'Séparation terminée.';
  $('results').hidden = false;

  const ratio = ms / 1000 / extractDur;
  $('stats').innerHTML = '';
  const rows = [
    ['Morceau', fileName],
    ['Extrait', `${extractDur.toFixed(1)} s`],
    ['Backend', backend === 'webgpu' ? 'WebGPU' : 'WASM'],
    ['Temps de calcul', fmtMs(ms)],
    ['Rapport au temps réel', `×${ratio.toFixed(2)} (${ratio < 1 ? 'plus rapide' : 'plus lent'} que la lecture)`],
    ['Estimation pour 4 min', fmtMs(ratio * 240 * 1000)],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    $('stats').append(dt, dd);
  }
  log(`Séparation : ${fmtMs(ms)} en ${backend}, ×${ratio.toFixed(2)} temps réel.`);

  const original = extract(decoded, Number($('start').value), extractDur);
  // Exposed for debugging from the console.
  window.chimereLast = { stems, original };
  excerptId++;
  const tracks = [
    ['vocals', STEM_LABELS.vocals, stems.vocals, '--stem-vocals'],
    ['original', 'Original', [original.left, original.right], '--muted'],
    ['instrumental', 'Instrumental', mix([stems.drums, stems.bass, stems.other]), '--accent'],
    ['drums', STEM_LABELS.drums, stems.drums, '--stem-drums'],
    ['bass', STEM_LABELS.bass, stems.bass, '--stem-bass'],
    ['other', STEM_LABELS.other, stems.other, '--stem-other'],
  ];
  const box = $('players');
  box.innerHTML = '';
  for (const [id, label, [l, r], color] of tracks) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.track = id;
    b.style.setProperty('--c', `var(${color})`);
    b.addEventListener('click', () => {
      const same = player.meta?.excerpt === excerptId;
      player.load(l, r, { id, label, color, excerpt: excerptId, sub: fileName }, { keepPosition: same });
      player.play();
    });
    box.append(b);
  }
  // Step 1 goal: play the vocals alone right away.
  box.firstElementChild.click();
}

// --- Bottom player ---
let excerptId = 0;
let raf = 0;

function renderPlayer() {
  const bar = $('player');
  const has = Boolean(player.buffer);
  bar.classList.toggle('playing', player.playing);
  $('play').disabled = !has;
  $('play').setAttribute('aria-label', player.playing ? 'Pause' : 'Lecture');
  $('seek').disabled = !has;
  $('seek').max = String(player.duration || 1);
  $('time-dur').textContent = fmtTime(player.duration);
  if (has) {
    $('now-title').textContent = player.meta.label;
    $('now-sub').textContent = player.meta.sub;
    $('now-dot').style.setProperty('--c', `var(${player.meta.color})`);
  }
  $('players').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('playing', player.playing && player.meta?.excerpt === excerptId && b.dataset.track === player.meta.id);
  });
  renderPosition();
  cancelAnimationFrame(raf);
  if (player.playing) raf = requestAnimationFrame(tick);
}

let seeking = false;
function renderPosition() {
  if (seeking) return;
  $('seek').value = String(player.position);
  $('time-pos').textContent = fmtTime(player.position);
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
  if (e.code !== 'Space' || !player.buffer) return;
  if (e.target.closest('input, button, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  player.toggle();
});

// --- File input ---
async function loadFile(file) {
  if (!file) return;
  player.stop();
  $('drop-text').textContent = `Décodage de « ${file.name} »…`;
  try {
    decoded = await decodeFile(file);
    fileName = file.name;
    $('drop-text').textContent = `${file.name} — ${decoded.duration.toFixed(1)} s, ${decoded.numberOfChannels} canal(aux), rééchantillonné à 44,1 kHz`;
    if (Number($('start').value) >= decoded.duration) $('start').value = '0';
  } catch (e) {
    decoded = null;
    $('drop-text').textContent = `Impossible de décoder ce fichier (${e.message || e}).`;
  }
  updateRunButton();
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

// --- Buttons ---
$('load').addEventListener('click', () => {
  $('load').disabled = true;
  // Ask the browser not to evict the cached model under storage pressure.
  navigator.storage?.persist?.().then((granted) => log(`Stockage persistant : ${granted ? 'accordé' : 'refusé'}.`));
  startWorker();
});

$('force-wasm').addEventListener('change', () => {
  if (worker) {
    log('Changement de backend : rechargement de la session.');
    $('load').disabled = true;
    startWorker();
  }
});

$('run').addEventListener('click', () => {
  player.stop();
  const start = Number($('start').value) || 0;
  const dur = Number($('dur').value) || 30;
  const { left, right } = extract(decoded, start, dur);
  if (left.length === 0) {
    $('sep-status').textContent = "L'extrait est vide : vérifiez le début.";
    return;
  }
  extractDur = left.length / decoded.sampleRate;
  $('run').disabled = true;
  $('sep').hidden = false;
  $('sep').value = 0;
  $('sep-status').textContent = 'Séparation en cours…';
  worker.postMessage({ type: 'separate', left, right }, [left.buffer, right.buffer]);
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
});

log(`Modèle : ${MODEL.repo}/${MODEL.file} @ ${MODEL.revision.slice(0, 8)}`);
showEnv();
