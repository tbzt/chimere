// Analysis worker: tempo and key from separated stems (src/analysis.js).
// Request: { id, rhythm: [[l, r]…], harmonic: [[l, r]…] } → { id, result } or { id, error }.
import { analyze } from './analysis.js';

self.addEventListener('message', ({ data: msg }) => {
  try {
    const t0 = performance.now();
    const result = analyze(msg.rhythm, msg.harmonic);
    result.ms = performance.now() - t0;
    self.postMessage({ id: msg.id, result });
  } catch (e) {
    self.postMessage({ id: msg.id, error: e?.message || String(e) });
  }
});
