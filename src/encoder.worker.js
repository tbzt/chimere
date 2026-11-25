// Encoding worker: float ↔ int16 conversions and WAV files, off the main thread.
// Request: { id, type, ... } — reply: { id, result } or { id, error }.
import { toInt16Interleaved, fromInt16Interleaved, encodeWav, mix } from './wav.js';

self.addEventListener('message', ({ data: msg }) => {
  try {
    if (msg.type === 'int16') {
      // { tracks: { name: [l, r] } } → { name: Int16Array }
      const result = {};
      const transfer = [];
      for (const [name, [l, r]] of Object.entries(msg.tracks)) {
        result[name] = toInt16Interleaved(l, r);
        transfer.push(result[name].buffer);
      }
      self.postMessage({ id: msg.id, result }, transfer);
    } else if (msg.type === 'float') {
      // { tracks: { name: Int16Array } } → { name: [l, r] }
      const result = {};
      const transfer = [];
      for (const [name, pcm] of Object.entries(msg.tracks)) {
        result[name] = fromInt16Interleaved(pcm);
        transfer.push(result[name][0].buffer, result[name][1].buffer);
      }
      self.postMessage({ id: msg.id, result }, transfer);
    } else if (msg.type === 'wav') {
      // { signals: [[l, r], …], sampleRate } → WAV ArrayBuffer of their sum
      const [l, r] = msg.signals.length === 1 ? msg.signals[0] : mix(msg.signals);
      const wav = encodeWav(toInt16Interleaved(l, r), msg.sampleRate);
      self.postMessage({ id: msg.id, result: wav }, [wav]);
    } else {
      throw new Error(`type inconnu : ${msg.type}`);
    }
  } catch (e) {
    self.postMessage({ id: msg.id, error: e?.message || String(e) });
  }
});
