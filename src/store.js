// Persistence: everything lives in this browser's IndexedDB.
//   meta      one small record per document (title, dates, revision, star, trash, image refs) — the list
//   content   the document body (ProseMirror JSON) and its settings
//   text      the plain text, for searching across documents
//   blobs     images, as binary Blobs keyed by content hash (shared between documents and versions)
//   versions  snapshots for the version history (gzip-compressed JSON when the browser can)
// If IndexedDB cannot be opened (some private modes), the same API works from memory and the app
// warns that nothing is kept.

const DB_NAME = 'editer';
const DB_VERSION = 2;
const STORES = ['meta', 'content', 'text', 'blobs', 'versions'];

export const storeInfo = { persistent: true };

export class ConflictError extends Error {
  constructor(current) { super('conflict'); this.name = 'ConflictError'; this.current = current; }
}

// ---------- opening, reconnecting ----------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { storeInfo.persistent = false; resolve(null); return; }
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const old = e.oldVersion;
      if (old < 1) {
        db.createObjectStore('meta', { keyPath: 'id' });
        db.createObjectStore('content', { keyPath: 'id' });
      }
      if (old < 2) {
        db.createObjectStore('text', { keyPath: 'id' });
        db.createObjectStore('blobs', { keyPath: 'hash' });
        const v = db.createObjectStore('versions', { keyPath: 'vid', autoIncrement: true });
        v.createIndex('docId', 'docId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab with a newer version of the app wants to upgrade: let it, and reconnect later
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { storeInfo.persistent = false; resolve(null); };
    // an old tab still has the database open; this resolves once it lets go
    req.onblocked = () => {
      if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('editer:notice', { detail: '古いタブがデータを使っています。editer を開いている他のタブを閉じてください' }));
    };
  });
  return dbPromise;
}

export async function ready() {
  await openDb();
  return storeInfo.persistent;
}

// ---------- a small promise layer over transactions (the same API backed by memory) ----------

const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const finished = (t) => new Promise((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = () => reject(t.error);
  t.onabort = () => reject(t.error || new DOMException('aborted', 'AbortError'));
});

function idbStore(s) {
  return {
    get: (k) => request(s.get(k)),
    put: (v) => request(s.put(v)),
    delete: (k) => request(s.delete(k)),
    getAll: () => request(s.getAll()),
    getAllKeys: () => request(s.getAllKeys()),
    byIndex: (index, key) => request(s.index(index).getAll(key)),
  };
}

const memory = Object.fromEntries(STORES.map((n) => [n, new Map()]));
let memSeq = 1;
const KEY = { meta: 'id', content: 'id', text: 'id', blobs: 'hash', versions: 'vid' };
function memStore(name) {
  const m = memory[name];
  return {
    get: async (k) => m.get(k),
    put: async (v) => { if (name === 'versions' && v.vid == null) v = { ...v, vid: memSeq++ }; m.set(v[KEY[name]], v); return v[KEY[name]]; },
    delete: async (k) => { m.delete(k); },
    getAll: async () => Array.from(m.values()),
    getAllKeys: async () => Array.from(m.keys()),
    byIndex: async (index, key) => Array.from(m.values()).filter((v) => v[index] === key),
  };
}

// Runs fn with the named stores inside one transaction. fn may only await store calls (anything
// else would let the transaction commit early). Retries once if the connection was closed under us.
async function tx(names, mode, fn, retried = false) {
  const db = await openDb();
  if (!db) return fn(Object.fromEntries(names.map((n) => [n, memStore(n)])));
  let t;
  try { t = db.transaction(names, mode); }
  catch (err) {
    if (!retried && err && err.name === 'InvalidStateError') { dbPromise = null; return tx(names, mode, fn, true); }
    throw err;
  }
  const done = finished(t);
  try {
    const result = await fn(Object.fromEntries(names.map((n) => [n, idbStore(t.objectStore(n))])));
    await done;
    return result;
  } catch (err) {
    try { t.abort(); } catch { /* already finished */ }
    done.catch(() => {});
    throw err;
  }
}

// ---------- documents ----------

export function newId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

// All documents' list records (trashed ones included), newest first.
export async function listDocs() {
  const list = await tx(['meta'], 'readonly', (s) => s.meta.getAll());
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getMeta(id) {
  return tx(['meta'], 'readonly', (s) => s.meta.get(id));
}

export async function getDoc(id) {
  return tx(['meta', 'content'], 'readonly', async (s) => {
    const [m, c] = await Promise.all([s.meta.get(id), s.content.get(id)]);
    return m && c ? { ...m, content: c.content, settings: c.settings } : null;
  });
}

const META_FIELDS = ['id', 'title', 'preview', 'chars', 'createdAt', 'updatedAt', 'starred', 'trashedAt', 'images', 'bytes', 'lastVersionAt'];

// Writes a document if nobody else changed it since `baseRev` (the revision this tab loaded or last
// saved). Returns the new revision; throws ConflictError (with the stored record) otherwise.
// Pass force to overwrite anyway.
export async function saveDoc(rec, baseRev, { force = false } = {}) {
  return tx(['meta', 'content', 'text'], 'readwrite', async (s) => {
    const existing = await s.meta.get(rec.id);
    const rev = existing ? existing.rev || 0 : 0;
    if (existing && rev !== baseRev && !force) throw new ConflictError(existing);
    const meta = {};
    for (const f of META_FIELDS) if (rec[f] !== undefined) meta[f] = rec[f];
    // things this tab doesn't manage are kept as they are
    if (existing) for (const f of ['starred', 'trashedAt', 'lastVersionAt']) if (rec[f] === undefined && existing[f] !== undefined) meta[f] = existing[f];
    meta.rev = rev + 1;
    await s.meta.put(meta);
    await s.content.put({ id: rec.id, v: 2, content: rec.content, settings: rec.settings });
    await s.text.put({ id: rec.id, text: rec.text || '' });
    return meta.rev;
  });
}

// Small changes to the list record only (star, trash, restore). Bumps nothing the editor relies on.
export async function patchMeta(id, patch) {
  return tx(['meta'], 'readwrite', async (s) => {
    const m = await s.meta.get(id);
    if (!m) return null;
    const next = { ...m, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    await s.meta.put(next);
    return next;
  });
}

// Removes a document for good, with its search text and versions.
export async function purgeDoc(id) {
  return tx(['meta', 'content', 'text', 'versions'], 'readwrite', async (s) => {
    const versions = await s.versions.byIndex('docId', id);
    await Promise.all([s.meta.delete(id), s.content.delete(id), s.text.delete(id), ...versions.map((v) => s.versions.delete(v.vid))]);
  });
}

// Plain-text search across documents. Returns Map(id -> { index, text }) of the first hit.
export async function searchText(query) {
  const q = query.toLowerCase();
  const rows = await tx(['text'], 'readonly', (s) => s.text.getAll());
  const hits = new Map();
  for (const r of rows) {
    const t = r.text || '';
    const i = t.toLowerCase().indexOf(q);
    if (i >= 0) hits.set(r.id, { index: i, text: t });
  }
  return hits;
}

// ---------- images ----------

export async function hasBlob(hash) {
  return tx(['blobs'], 'readonly', async (s) => !!(await s.blobs.get(hash)));
}

export async function putBlob(hash, blob) {
  return tx(['blobs'], 'readwrite', async (s) => {
    if (await s.blobs.get(hash)) return false;
    await s.blobs.put({ hash, blob, type: blob.type, size: blob.size, createdAt: Date.now() });
    return true;
  });
}

export async function getBlob(hash) {
  const r = await tx(['blobs'], 'readonly', (s) => s.blobs.get(hash));
  return r ? r.blob : null;
}

// Deletes images no document, trashed document or version refers to. Only images older than
// minAge go, so one inserted a moment ago and not yet saved is safe.
export async function collectGarbage(minAge = 24 * 3600e3) {
  return tx(['meta', 'versions', 'blobs'], 'readwrite', async (s) => {
    const [metas, versions, blobs] = await Promise.all([s.meta.getAll(), s.versions.getAll(), s.blobs.getAll()]);
    const used = new Set();
    for (const m of metas) for (const h of m.images || []) used.add(h);
    for (const v of versions) for (const h of v.images || []) used.add(h);
    const cutoff = Date.now() - minAge;
    const gone = blobs.filter((b) => !used.has(b.hash) && (b.createdAt || 0) < cutoff);
    await Promise.all(gone.map((b) => s.blobs.delete(b.hash)));
    return gone.length;
  });
}

// ---------- versions ----------

const canGzip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function pack(json) {
  const text = JSON.stringify(json);
  if (!canGzip) return { text };
  try {
    const blob = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    return { gz: blob, size: text.length };
  } catch { return { text }; }
}

async function unpack(v) {
  if (v.text != null) return JSON.parse(v.text);
  const text = await new Response(v.gz.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}

// v: { docId, time, title, chars, images, name?, content }
export async function addVersion(v) {
  const packed = await pack(v.content);
  const rec = { docId: v.docId, time: v.time || Date.now(), title: v.title || '', chars: v.chars || 0, images: v.images || [], name: v.name || '', kind: v.kind || 'auto', ...packed };
  return tx(['versions'], 'readwrite', (s) => s.versions.put(rec));
}

// Newest first, without bodies.
export async function listVersions(docId) {
  const all = await tx(['versions'], 'readonly', (s) => s.versions.byIndex('docId', docId));
  return all.map(({ gz, text, ...rest }) => rest).sort((a, b) => b.time - a.time);
}

export async function getVersionContent(vid) {
  const v = await tx(['versions'], 'readonly', (s) => s.versions.get(vid));
  return v ? unpack(v) : null;
}

export async function renameVersion(vid, name) {
  return tx(['versions'], 'readwrite', async (s) => {
    const v = await s.versions.get(vid);
    if (!v) return;
    v.name = name;
    if (name) v.kind = 'named';
    await s.versions.put(v);
  });
}

// Keeps every named version and the newest `keep` others; older automatic ones are thinned to one
// per day, for at most `days` days.
export async function pruneVersions(docId, keep = 40, days = 60) {
  return tx(['versions'], 'readwrite', async (s) => {
    const auto = (await s.versions.byIndex('docId', docId)).filter((v) => !v.name).sort((a, b) => b.time - a.time);
    const drop = [];
    const seen = new Set();
    auto.forEach((v, i) => {
      if (i < keep) return;
      const day = new Date(v.time).toDateString();
      if (seen.has(day) || seen.size >= days) drop.push(v.vid); else seen.add(day);
    });
    await Promise.all(drop.map((vid) => s.versions.delete(vid)));
    return drop.length;
  });
}

// ---------- storage health ----------

export async function storageEstimate() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}
export async function isPersisted() {
  try { return navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch { return false; }
}
// Asks the browser not to clear our data under storage pressure (Safari also stops its 7-day rule).
export async function requestPersist() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

// ---------- small per-browser preferences ----------

export function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem('editer/' + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function writePref(key, value) {
  try { localStorage.setItem('editer/' + key, JSON.stringify(value)); } catch { /* not kept */ }
}

// ---------- other tabs ----------

let channel = null;
try { channel = new BroadcastChannel('editer'); } catch { channel = null; }
export const tabId = newId();

export function announce(msg) {
  if (channel) channel.postMessage({ ...msg, from: tabId });
}

export function onAnnounce(fn) {
  if (channel) channel.addEventListener('message', (e) => { if (e.data && e.data.from !== tabId) fn(e.data); });
}
