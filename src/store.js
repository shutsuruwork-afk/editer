// Documents live in this browser's IndexedDB: a small "meta" record per document for the list,
// and a "content" record with the body (which can be large because images are stored inline).
// If IndexedDB cannot be opened (some private modes), documents are kept in memory only and the
// app says so.

const DB_NAME = 'editer';
const DB_VERSION = 1;

let dbPromise = null;
const memory = { meta: new Map(), content: new Map() };
export const storeInfo = { persistent: true };

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { storeInfo.persistent = false; resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('content')) db.createObjectStore('content', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => { storeInfo.persistent = false; resolve(null); };
    req.onblocked = () => { /* another tab holds an older version; wait */ };
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}
const result = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export function newId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

export async function listDocs() {
  const db = await openDb();
  let list;
  if (!db) list = Array.from(memory.meta.values());
  else list = await result(db.transaction('meta').objectStore('meta').getAll());
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id) {
  const db = await openDb();
  if (!db) {
    const m = memory.meta.get(id), c = memory.content.get(id);
    return m && c ? { ...m, ...c } : null;
  }
  const tx = db.transaction(['meta', 'content']);
  const [m, c] = await Promise.all([result(tx.objectStore('meta').get(id)), result(tx.objectStore('content').get(id))]);
  return m && c ? { ...m, ...c } : null;
}

// doc: { id, title, preview, chars, createdAt, updatedAt, content, settings }
export async function putDoc(doc) {
  const meta = { id: doc.id, title: doc.title, preview: doc.preview, chars: doc.chars, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
  const content = { id: doc.id, v: 1, content: doc.content, settings: doc.settings };
  const db = await openDb();
  if (!db) { memory.meta.set(doc.id, meta); memory.content.set(doc.id, content); return; }
  const tx = db.transaction(['meta', 'content'], 'readwrite');
  tx.objectStore('meta').put(meta);
  tx.objectStore('content').put(content);
  await done(tx);
}

export async function deleteDoc(id) {
  const db = await openDb();
  if (!db) { memory.meta.delete(id); memory.content.delete(id); return; }
  const tx = db.transaction(['meta', 'content'], 'readwrite');
  tx.objectStore('meta').delete(id);
  tx.objectStore('content').delete(id);
  await done(tx);
}

export async function ready() {
  await openDb();
  return storeInfo.persistent;
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
