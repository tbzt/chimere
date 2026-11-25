import { defineConfig, defaultClientConditions } from 'vite';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Relative base so the build works under https://<user>.github.io/<repo>/
  base: './',
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  // Use the onnxruntime-web build that loads its Emscripten glue (.mjs) from a
  // separate file. Multithreaded WASM spawns pthread workers from that glue's
  // URL; with the self-contained build they would re-run our bundled worker
  // chunk instead and never initialise (session creation hangs).
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
