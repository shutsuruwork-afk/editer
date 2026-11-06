// Images are kept once, as binary Blobs keyed by their content hash, and documents refer to them
// as "idb:<hash>". That keeps document saves small (no base64 inside the JSON), lets copies and
// versions share images, and makes the same picture pasted twice cost nothing.
import * as store from '../store.js';
import { schema } from '../editor/schema.js';
import { prepareImage, imageSize } from '../util/image.js';

const PREFIX = 'idb:';
const urls = new Map(); // hash -> object URL
const loading = new Map(); // hash -> Promise<string|null>

export const isLocal = (src) => typeof src === 'string' && src.startsWith(PREFIX);
const hashOf = (src) => src.slice(PREFIX.length);

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 64-bit-ish fallback when SubtleCrypto is unavailable (not a secure context).
function fallbackHash(bytes) {
  let h1 = 0xdeadbeef ^ bytes.length, h2 = 0x41c6ce57 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'f' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + bytes.length.toString(16);
}

async function hashBytes(buf) {
  if (globalThis.crypto && crypto.subtle) {
    try { return hex(await crypto.subtle.digest('SHA-256', buf)).slice(0, 40); } catch { /* fall through */ }
  }
  return fallbackHash(new Uint8Array(buf));
}

// Stores a Blob and returns the src to put in the document.
export async function storeBlob(blob) {
  const hash = await hashBytes(await blob.arrayBuffer());
  await store.putBlob(hash, blob);
  if (!urls.has(hash)) urls.set(hash, URL.createObjectURL(blob));
  return PREFIX + hash;
}

export async function storeFile(file) {
  return storeBlob(await prepareImage(file));
}

export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const type = m[1] || 'application/octet-stream';
  if (m[2]) {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  return new Blob([decodeURIComponent(m[3])], { type });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// A URL the browser can show for any image src; null if a local image is missing.
export function imageUrl(src) {
  if (!isLocal(src)) return Promise.resolve(src);
  const hash = hashOf(src);
  if (urls.has(hash)) return Promise.resolve(urls.get(hash));
  if (!loading.has(hash)) {
    loading.set(hash, store.getBlob(hash).then((blob) => {
      loading.delete(hash);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      urls.set(hash, url);
      return url;
    }, () => { loading.delete(hash); return null; }));
  }
  return loading.get(hash);
}

export function cachedUrl(src) {
  return isLocal(src) ? urls.get(hashOf(src)) || null : src;
}

// The image hashes a document (or its JSON) refers to — kept in the list record so unused images
// can be found without reading every document.
export function imageRefs(doc) {
  const out = new Set();
  doc.descendants((node) => {
    if (node.type === schema.nodes.image && isLocal(node.attrs.src)) out.add(hashOf(node.attrs.src));
    return node.isBlock;
  });
  return Array.from(out);
}

// Moves images that arrived as data: URLs (pasted HTML, older documents) into the image store and
// points the document at them. The change is left out of the undo history.
export async function internalizeImages(view) {
  const found = new Set();
  view.state.doc.descendants((node) => {
    if (node.type === schema.nodes.image && node.attrs.src.startsWith('data:')) found.add(node.attrs.src);
    return node.isBlock;
  });
  if (!found.size) return false;
  const map = new Map();
  for (const src of found) {
    const blob = dataUrlToBlob(src);
    if (blob) {
      try { map.set(src, await storeBlob(blob)); } catch { /* keep it inline */ }
    }
  }
  if (!map.size) return false;
  const tr = view.state.tr;
  view.state.doc.descendants((node, pos) => {
    if (node.type === schema.nodes.image && map.has(node.attrs.src)) tr.setNodeMarkup(pos, null, { ...node.attrs, src: map.get(node.attrs.src) });
    return node.isBlock;
  });
  if (!tr.docChanged) return false;
  tr.setMeta('addToHistory', false).setMeta('internal', true);
  view.dispatch(tr);
  return true;
}

// The same document with local images turned into data: URLs (for files that leave the app).
export async function withInlineImages(doc) {
  const srcs = new Set();
  doc.descendants((node) => { if (node.type === schema.nodes.image && isLocal(node.attrs.src)) srcs.add(node.attrs.src); return node.isBlock; });
  if (!srcs.size) return doc;
  const map = new Map();
  for (const src of srcs) {
    const blob = await store.getBlob(hashOf(src));
    if (blob) map.set(src, await blobToDataUrl(blob));
  }
  const json = doc.toJSON();
  const walk = (n) => {
    if (n.type === 'image' && map.has(n.attrs.src)) n.attrs = { ...n.attrs, src: map.get(n.attrs.src) };
    if (n.content) n.content.forEach(walk);
  };
  walk(json);
  return schema.nodeFromJSON(json);
}

// Bytes and size of an image, for the Word export.
export async function loadImageBytes(src) {
  let blob = null;
  try {
    if (isLocal(src)) blob = await store.getBlob(hashOf(src));
    else if (src.startsWith('data:')) blob = dataUrlToBlob(src);
    else if (/^https:/.test(src)) blob = await (await fetch(src)).blob();
  } catch { blob = null; }
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const size = imageSize(bytes);
  return { bytes, type: blob.type || 'image/png', width: size && size.width, height: size && size.height };
}
