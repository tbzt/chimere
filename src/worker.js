// Separation worker: downloads/caches the model, runs ONNX Runtime Web
// (WebGPU first, WASM fallback) and does chunked overlap-add.
import * as ort from 'onnxruntime-web';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import { MODEL, MODEL_CACHE, SEGMENT, OVERLAP, STEMS, CPU_NODES } from './config.js';
import { separate, checkChunk, mixStats, relativeError } from './separate.js';
import { prepareModelInput, standaloneMask, standaloneIspec } from 'demucs-web/processor';

ort.env.wasm.wasmPaths = {
  mjs: new URL(mjsUrl, self.location.href).href,
  wasm: new URL(wasmUrl, self.location.href).href,
};
// Multithreaded WASM hangs at session creation when ORT runs inside a Worker
// (seen on Chromium 156, also with ORT's own proxy worker). Default to one
// thread; the page can request more with ?threads=N and has a watchdog.
ort.env.wasm.numThreads = 1;

let session = null;
let backend = null;

const post = (msg, transfer) => self.postMessage(msg, transfer);
const log = (text) => post({ type: 'log', text });

async function getModelBytes() {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(MODEL.url);
  if (hit) {
    log('Modèle trouvé dans le cache local.');
    post({ type: 'download', loaded: MODEL.sizeBytes, total: MODEL.sizeBytes, cached: true });
    return new Uint8Array(await hit.arrayBuffer());
  }

  log(`Téléchargement du modèle depuis Hugging Face (${(MODEL.sizeBytes / 1e6).toFixed(0)} Mo)…`);
  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`Téléchargement du modèle : HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || MODEL.sizeBytes;
  const reader = res.body.getReader();
  const bytes = new Uint8Array(total);
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, loaded);
    loaded += value.length;
    const now = performance.now();
    if (now - lastPost > 100) {
      post({ type: 'download', loaded, total });
      lastPost = now;
    }
  }
  if (loaded !== total) throw new Error(`Modèle incomplet (${loaded} / ${total} octets)`);
  post({ type: 'download', loaded, total });

  await cache.put(
    MODEL.url,
    new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
  );
  log('Modèle mis en cache.');
  return bytes;
}

async function webgpuAvailable() {
  if (!('gpu' in navigator)) return { ok: false, reason: 'navigator.gpu absent' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'aucun adaptateur GPU' };
    const info = adapter.info || {};
    return { ok: true, description: [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

let pinCpuNodes = true;
let gpuErrors = 0;

/**
 * Log the device limits and surface WebGPU validation / out-of-memory errors.
 * ORT does not report them: a failed dispatch just leaves zeros in the output.
 */
async function watchGpuDevice() {
  const device = await ort.env.webgpu.device;
  if (!device || device.__chimereWatched) return;
  device.__chimereWatched = true;
  const mb = (x) => `${Math.round(x / 2 ** 20)} Mo`;
  const l = device.limits;
  log(
    `WebGPU : tampon max ${mb(l.maxBufferSize)}, liaison max ${mb(l.maxStorageBufferBindingSize)}, ` +
      `shader-f16 ${device.features.has('shader-f16') ? 'oui' : 'non'}.`,
  );
  device.addEventListener('uncapturederror', (e) => {
    gpuErrors++;
    if (gpuErrors <= 5) log(`Erreur WebGPU (${e.error?.constructor?.name}) : ${e.error?.message?.slice(0, 400)}`);
    else if (gpuErrors === 6) log('Erreurs WebGPU suivantes masquées.');
  });
  device.lost.then((info) => log(`Carte graphique perdue : ${info.reason} ${info.message}`));
}

async function createSession(bytes, wanted) {
  // Memory-lean options: the 32-bit WASM heap is limited to 4 GB.
  const options = {
    graphOptimizationLevel: 'basic',
    enableCpuMemArena: false,
    enableMemPattern: false,
  };
  log(`Création de la session ONNX (${wanted})…`);
  if (wanted === 'webgpu') {
    // ?cpunodes=0 disables the CPU pinning (to re-test plain WebGPU).
    const pin = pinCpuNodes;
    const ep = pin ? { name: 'webgpu', forceCpuNodeNames: CPU_NODES } : 'webgpu';
    session = await ort.InferenceSession.create(bytes, { ...options, executionProviders: [ep] });
    log(`WebGPU : prologue de normalisation ${pin ? 'sur CPU' : 'sur GPU (?cpunodes=0)'}.`);
    await watchGpuDevice();
  } else {
    session = await ort.InferenceSession.create(bytes, { ...options, executionProviders: ['wasm'] });
  }
  backend = wanted;
  const threads = wanted === 'wasm' ? ort.env.wasm.numThreads : null;
  post({ type: 'backend', backend, threads });
  log(`Session ONNX prête (${wanted}${threads ? `, ${threads} thread(s)` : ''}).`);
}

async function init({ forceWasm, threads, cpuNodes = true }) {
  const t0 = performance.now();
  pinCpuNodes = cpuNodes;
  if (threads > 1 && self.crossOriginIsolated) ort.env.wasm.numThreads = threads;
  const bytes = await getModelBytes();
  const gpu = await webgpuAvailable();
  post({ type: 'env', webgpu: gpu, crossOriginIsolated: self.crossOriginIsolated, threads: ort.env.wasm.numThreads });

  if (!forceWasm && gpu.ok) {
    try {
      await createSession(bytes, 'webgpu');
    } catch (e) {
      log(`WebGPU indisponible pour ce modèle (${e.message}). Repli sur WASM.`);
      await createSession(bytes, 'wasm');
    }
  } else {
    if (!forceWasm) log(`WebGPU indisponible (${gpu.reason}). Mode WASM, nettement plus lent.`);
    await createSession(bytes, 'wasm');
  }
  post({ type: 'ready', backend, loadMs: performance.now() - t0 });
}

/** One model call on [2 * SEGMENT] samples; returns [4 stems * 2 ch * SEGMENT]. */
async function runChunk(input, parts) {
  const left = input.subarray(0, SEGMENT);
  const right = input.subarray(SEGMENT);
  const prep = prepareModelInput(left, right);
  const [waveName, specName] = session.inputNames;
  const out = await session.run({
    [waveName]: new ort.Tensor('float32', prep.waveform, [1, 2, SEGMENT]),
    [specName]: new ort.Tensor('float32', prep.magSpec, [1, 4, prep.numBins, prep.numFrames]),
  });

  let time = null;
  let freq = null;
  for (const name of session.outputNames) {
    const t = out[name];
    if (t.dims.length === 4) time = t.data; // [1, 4, 2, SEGMENT]
    else if (t.dims.length === 5) freq = t.data; // [1, 4, 4, bins, frames]
  }
  if (!time || !freq) throw new Error('Sorties du modèle inattendues');
  if (parts) {
    parts.time = Float32Array.from(time);
    parts.freq = Float32Array.from(freq);
  }

  const specs = standaloneMask(freq);
  const result = new Float32Array(STEMS.length * 2 * SEGMENT);
  for (let s = 0; s < STEMS.length; s++) {
    const f = standaloneIspec(specs[s], SEGMENT);
    const l0 = (s * 2) * SEGMENT;
    const r0 = (s * 2 + 1) * SEGMENT;
    for (let i = 0; i < SEGMENT; i++) {
      result[l0 + i] = time[l0 + i] + f.left[i];
      result[r0 + i] = time[r0 + i] + f.right[i];
    }
  }
  for (const name of session.outputNames) out[name].dispose?.();
  return result;
}

async function doSeparate({ left, right }) {
  const t0 = performance.now();
  const opts = {
    segment: SEGMENT,
    overlap: OVERLAP,
    stemCount: STEMS.length,
    onProgress: (done, total) => post({ type: 'progress', done, total }),
  };

  // Every chunk is checked: a broken backend can return plausible-looking
  // zeros instead of NaN. WebGPU errors fall back to WASM below.
  const checkedRun = async (input) => {
    const data = await runChunk(input);
    const check = checkChunk(input, data, SEGMENT, STEMS.length);
    if (!check.ok) {
      if (backend === 'webgpu') throw new Error(`résultat WebGPU incohérent : ${check.reason}`);
      log(`Attention : fenêtre suspecte en WASM (${check.reason}).`);
    }
    return data;
  };

  let result;
  try {
    result = await separate(left, right, { ...opts, runChunk: checkedRun });
  } catch (e) {
    if (backend !== 'webgpu') throw e;
    log(`Échec en WebGPU (${e.message}). Nouvel essai en WASM.`);
    post({ type: 'fallback', reason: e.message });
    await session.release();
    const cache = await caches.open(MODEL_CACHE);
    const bytes = new Uint8Array(await (await cache.match(MODEL.url)).arrayBuffer());
    await createSession(bytes, 'wasm');
    result = await separate(left, right, { ...opts, runChunk: checkedRun });
  }

  const stems = {};
  const transfer = [];
  STEMS.forEach((name, i) => {
    stems[name] = result[i];
    transfer.push(result[i][0].buffer, result[i][1].buffer);
  });
  post({ type: 'result', stems, backend, ms: performance.now() - t0 }, transfer);
}

/**
 * Diagnostic: run the same window through the WebGPU session and a fresh WASM
 * session, and report how far apart the outputs are (per stem and branch).
 */
async function compareBackends({ left, right }) {
  if (backend !== 'webgpu') throw new Error('La session active n\'est pas en WebGPU : rien à comparer.');
  const { mean, std } = mixStats(left, right);
  const input = new Float32Array(2 * SEGMENT);
  const n = Math.min(SEGMENT, left.length);
  for (let i = 0; i < n; i++) {
    input[i] = (left[i] - mean) / std;
    input[SEGMENT + i] = (right[i] - mean) / std;
  }

  log('Comparaison : fenêtre en WebGPU…');
  const gpuParts = {};
  const errorsBefore = gpuErrors;
  const gpu = await runChunk(input, gpuParts);
  const device = await ort.env.webgpu.device;
  await device.queue.onSubmittedWorkDone();
  log(`Comparaison : ${gpuErrors - errorsBefore} erreur(s) WebGPU pendant la fenêtre.`);

  log('Comparaison : même fenêtre en WASM (1 thread, environ 30 s)…');
  const gpuSession = session;
  const cache = await caches.open(MODEL_CACHE);
  const bytes = new Uint8Array(await (await cache.match(MODEL.url)).arrayBuffer());
  session = await ort.InferenceSession.create(bytes, {
    graphOptimizationLevel: 'basic',
    enableCpuMemArena: false,
    enableMemPattern: false,
    executionProviders: ['wasm'],
  });
  const cpuParts = {};
  let cpu;
  try {
    cpu = await runChunk(input, cpuParts);
  } finally {
    await session.release();
    session = gpuSession;
  }

  const per = (a, b, stride) =>
    STEMS.map((name, s) => ({
      name,
      ...relativeError(a.subarray(s * stride, (s + 1) * stride), b.subarray(s * stride, (s + 1) * stride)),
    }));
  const rows = {
    combined: per(gpu, cpu, 2 * SEGMENT),
    time: per(gpuParts.time, cpuParts.time, 2 * SEGMENT),
    freq: per(gpuParts.freq, cpuParts.freq, gpuParts.freq.length / STEMS.length),
  };
  const v = STEMS.indexOf('vocals');
  const pick = (data) => {
    const l = data.slice(v * 2 * SEGMENT, v * 2 * SEGMENT + n);
    const r = data.slice((v * 2 + 1) * SEGMENT, (v * 2 + 1) * SEGMENT + n);
    for (let i = 0; i < n; i++) {
      l[i] = l[i] * std + mean;
      r[i] = r[i] * std + mean;
    }
    return [l, r];
  };
  const vocalsGpu = pick(gpu);
  const vocalsCpu = pick(cpu);
  post({ type: 'compare', rows, vocalsGpu, vocalsCpu }, [
    vocalsGpu[0].buffer, vocalsGpu[1].buffer, vocalsCpu[0].buffer, vocalsCpu[1].buffer,
  ]);
}

{
  self.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== 'string') return;
    try {
      if (msg.type === 'init') await init(msg);
      else if (msg.type === 'separate') await doSeparate(msg);
      else if (msg.type === 'compare') await compareBackends(msg);
    } catch (e) {
      post({ type: 'error', text: e?.message || String(e) });
    }
  });
}
