// Separation worker: downloads/caches the model, runs ONNX Runtime Web
// (WebGPU first, WASM fallback) and does chunked overlap-add.
import * as ort from 'onnxruntime-web';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import { MODEL, MODEL_CACHE, SEGMENT, OVERLAP, STEMS } from './config.js';
import { separate, hasNaN } from './separate.js';
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

async function createSession(bytes, wanted) {
  // Memory-lean options: the 32-bit WASM heap is limited to 4 GB.
  const options = {
    graphOptimizationLevel: 'basic',
    enableCpuMemArena: false,
    enableMemPattern: false,
  };
  log(`Création de la session ONNX (${wanted})…`);
  if (wanted === 'webgpu') {
    session = await ort.InferenceSession.create(bytes, { ...options, executionProviders: ['webgpu'] });
  } else {
    session = await ort.InferenceSession.create(bytes, { ...options, executionProviders: ['wasm'] });
  }
  backend = wanted;
  const threads = wanted === 'wasm' ? ort.env.wasm.numThreads : null;
  post({ type: 'backend', backend, threads });
  log(`Session ONNX prête (${wanted}${threads ? `, ${threads} thread(s)` : ''}).`);
}

async function init({ forceWasm, threads }) {
  const t0 = performance.now();
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
async function runChunk(input) {
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

  let firstChecked = false;
  const checkedRun = async (input) => {
    const data = await runChunk(input);
    if (!firstChecked) {
      firstChecked = true;
      if (hasNaN(data)) throw new Error('NaN');
    }
    return data;
  };

  let result;
  try {
    result = await separate(left, right, { ...opts, runChunk: checkedRun });
  } catch (e) {
    if (backend !== 'webgpu') throw e;
    log(`Échec en WebGPU (${e.message}). Nouvel essai en WASM.`);
    await session.release();
    const cache = await caches.open(MODEL_CACHE);
    const bytes = new Uint8Array(await (await cache.match(MODEL.url)).arrayBuffer());
    await createSession(bytes, 'wasm');
    result = await separate(left, right, { ...opts, runChunk });
  }

  const stems = {};
  const transfer = [];
  STEMS.forEach((name, i) => {
    stems[name] = result[i];
    transfer.push(result[i][0].buffer, result[i][1].buffer);
  });
  post({ type: 'result', stems, backend, ms: performance.now() - t0 }, transfer);
}

{
  self.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== 'string') return;
    try {
      if (msg.type === 'init') await init(msg);
      else if (msg.type === 'separate') await doSeparate(msg);
    } catch (e) {
      post({ type: 'error', text: e?.message || String(e) });
    }
  });
}
