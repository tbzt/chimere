# CLAUDE.md — Chimère (`chimere`)

Static web app (GitHub Pages) that splits songs into stems (vocals, drums, bass, other)
and, later, mixes stems from several songs into bootlegs. Everything runs in the browser.
The spec is `docs/fiche-projet.md` (French); read it before any feature work.

## Hard constraints

- Vanilla JavaScript, ES modules, Vite. No UI framework, no TypeScript build step.
- No server. Audio files and stems never leave the user's machine.
- No third-party trackers, analytics, CDN scripts or remote fonts. The only remote fetch
  allowed is the model from Hugging Face, pinned to a commit hash (see `src/config.js`).
- Heavy work (inference, time-stretch, encoding) runs in Web Workers, never on the main thread.
- Audio timing uses the `AudioContext` clock only, never `setTimeout`/`setInterval`.
- Never commit copyrighted audio. Test files go in `samples/` (git-ignored); demo audio
  must be Creative Commons.
- Any new dependency: check its license is AGPL-3.0 compatible and note it in
  the technical table of `docs/fiche-projet.md`.

## Model facts (HTDemucs, `timcsy/demucs-web-onnx`)

- File `htdemucs_embedded.onnx`, 181 MB, fp32, pinned in `src/config.js`.
- Inputs: `input` float32 `[1, 2, 343980]` (44.1 kHz stereo, 7.8 s) and `x` float32
  `[1, 4, 2048, 336]` (STFT real/imag per channel). Outputs: time branch `[1, 4, 2, 343980]`
  and frequency branch `[1, 4, 4, 2048, 336]`; stem order **drums, bass, other, vocals**.
- STFT / iSTFT are done in JS by the `demucs-web` package (`prepareModelInput`,
  `standaloneMask`, `standaloneIspec`); stem = time branch + iSTFT(freq branch).
- Longer audio = overlap-add in `src/separate.js`, a port of Demucs `apply_model` (25 % overlap,
  triangular window, offsets `range(0, length, stride)`, short last chunk centred on real audio).
  Checked 25 nov. 2026 against native Demucs 4.1 (`htdemucs`, shifts=0) on a 30 s excerpt:
  ≥ 58 dB SDR on every stem, so remaining artefacts are the model's, not the pipeline's.
- Cached in the Cache API under `chimere-model-v1`; bump the cache name when changing the model.
- `StemSplitio/htdemucs-onnx` (waveform-only graph) fails in onnxruntime-web 1.31 with
  `std::bad_alloc` (fp16 and fp32). Don't switch back without re-testing.

## Known runtime pitfalls

- Multithreaded WASM hangs at session creation when ORT runs inside a Worker (Chromium 156,
  also with `ort.env.wasm.proxy`). The worker uses 1 thread by default; `?threads=N` opts in,
  with a 45 s watchdog in `main.js` that restarts in 1 thread. On the main thread 8 threads are
  ~2x faster but freeze the UI, so don't move inference there.
- WebGPU can silently return all-zero stems (no error) on a misconfigured browser: seen with
  Chrome launched with `--use-angle=vulkan --ozone-platform=wayland` (GTX 1060, Ubuntu). A clean
  Chrome matches WASM within 1 %. Every chunk goes through `checkChunk` (stems must add up to
  the input); on WebGPU a failure re-runs the whole separation in WASM. Réglages → *Diagnostic
  WebGPU* compares both backends and logs device limits and uncaptured WebGPU errors. The graph's
  normalisation prologue (`CPU_NODES`) is pinned to CPU as `monteslu/htdemucs-web-onnx` advises;
  not proven necessary here (`?cpunodes=0` disables it).
- Vite resolves `onnxruntime-web` with the `onnxruntime-web-use-extern-wasm` condition so the
  Emscripten glue `.mjs` stays a separate file (see `vite.config.js`).

## Layout

- `index.html`, `src/main.js`, `src/style.css` — UI shell (sidebar, views, bottom player; main thread)
- `src/router.js` — hash router (`#/bibliotheque`, `#/separer`, `#/mashups`, `#/reglages`)
- `src/worker.js` — model download/cache, ONNX session, per-chunk STFT + inference + iSTFT
- `src/separate.js` — pure chunking / overlap-add logic (no DOM, no ORT)
- `src/audio.js` — decoding, resampling, multitrack `Player` (all sources started on one
  AudioContext time; per-track gain for volume/mute/solo; master gain)
- `src/wav.js` — pure PCM helpers (int16, WAV, mix, peaks); `src/encoder.worker.js` runs them
- `src/library.js` — IndexedDB library (idb-keyval): `meta:<id>` + `pcm:<id>:<track>` int16;
  id = SHA-256 of the file bytes + model revision
- `src/config.js` — model URL, constants
- `public/coi-serviceworker.min.js` — copied from node_modules by `npm run prepare-static`
  (git-ignored); provides COOP/COEP on GitHub Pages
- `.github/workflows/deploy.yml` — build and deploy to Pages

## Commands

- `npm install`
- `npm run dev` — dev server with COOP/COEP headers set by Vite
- `npm run build` / `npm run preview`
- `npm test` — Node unit tests (`src/separate.js`, `src/router.js`, `src/wav.js`)
- npm/node live in `~/.local/bin` (not on the default PATH of tool shells)

## Conventions

- UI text in French; code, identifiers and comments in English.
- Work by the plan steps in the spec; each step ships and is tested by ear before the next.
- Keep `separate.js` free of browser APIs so it can be unit-tested under Node.
