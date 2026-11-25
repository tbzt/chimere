// Local library of separated songs, in IndexedDB (idb-keyval).
// Keys: "meta:<id>" → song metadata, "pcm:<id>:<track>" → interleaved int16.
// The id is a hash of the file bytes plus the model revision, so the same
// file is never separated twice with the same model.
import { createStore, get, set, del, keys, getMany } from 'idb-keyval';
import { MODEL } from './config.js';

const store = createStore('chimere-library', 'songs');

/** SHA-256 of the file bytes (hex, 32 chars) + model revision. */
export async function songId(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 32)}-${MODEL.revision.slice(0, 8)}`;
}

/** @returns {Promise<object[]>} metadata of every song, newest first */
export async function listSongs() {
  const metaKeys = (await keys(store)).filter((k) => String(k).startsWith('meta:'));
  const metas = await getMany(metaKeys, store);
  return metas.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

export const getSong = (id) => get(`meta:${id}`, store);

/** @param {object} meta  must contain id and tracks (names) */
export async function saveSong(meta, pcm) {
  for (const name of meta.tracks) await set(`pcm:${meta.id}:${name}`, pcm[name], store);
  // Metadata last: a song is listed only once all its tracks are stored.
  await set(`meta:${meta.id}`, meta, store);
}

/** Rewrite the metadata only (e.g. after analysis or a manual correction). */
export const updateMeta = (meta) => set(`meta:${meta.id}`, meta, store);

/** @returns {Promise<Record<string, Int16Array>>} */
export async function loadTracks(meta) {
  const values = await getMany(meta.tracks.map((n) => `pcm:${meta.id}:${n}`), store);
  const out = {};
  meta.tracks.forEach((n, i) => {
    if (!values[i]) throw new Error(`Piste manquante dans le cache : ${n}`);
    out[n] = values[i];
  });
  return out;
}

/** One track of a song (interleaved int16). */
export async function loadTrack(id, name) {
  const pcm = await get(`pcm:${id}:${name}`, store);
  if (!pcm) throw new Error(`Piste manquante dans le cache : ${name}`);
  return pcm;
}

// --- Mashup projects: "project:<id>" → project object (see src/project.js) ---
export const saveProject = (project) => set(`project:${project.id}`, project, store);
export const loadProject = (id) => get(`project:${id}`, store);
export const deleteProject = (id) => del(`project:${id}`, store);
export async function listProjects() {
  const projectKeys = (await keys(store)).filter((k) => String(k).startsWith('project:'));
  const projects = await getMany(projectKeys, store);
  return projects.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSong(id) {
  const meta = await getSong(id);
  await del(`meta:${id}`, store);
  for (const name of meta?.tracks ?? []) await del(`pcm:${id}:${name}`, store);
}
