// The open document's life: loading (with repair), autosaving, versions, trash and other tabs.
import { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { fixTables } from 'prosemirror-tables';
import * as store from '../store.js';
import { schema } from '../editor/schema.js';
import { fromGenkocho } from '../editor/convert.js';
import { ctx, emit, UNTITLED } from './ctx.js';
import { stats, plainText, firstLine } from './text.js';
import { imageRefs, internalizeImages } from './images.js';
import { toast } from '../ui/toast.js';

const SAVE_DELAY = 800; // after the last keystroke
const SAVE_MAX_WAIT = 5000; // even while typing without a pause
const VERSION_EVERY = 10 * 60e3;
const TRASH_DAYS = 30;

export const session = { current: null, dirty: false, saving: false, error: '' };

export function emptyDoc() { return schema.node('doc', null, [schema.node('paragraph')]); }
export function displayTitle(meta) { return (meta && (meta.title || meta.preview)) || UNTITLED; }

// ---------- reading stored documents, repairing what doesn't fit ----------

function jsonText(n) {
  if (!n || typeof n !== 'object') return '';
  if (n.type === 'text') return String(n.text || '');
  return (n.content || []).map(jsonText).join(n.type === 'paragraph' || n.type === 'heading' ? '' : '\n');
}

// Returns { doc, repaired }. Unknown nodes/marks (e.g. from a newer version of the app) are
// unwrapped, blocks that still don't fit become plain paragraphs, and tables are normalized.
export function parseContent(json) {
  try {
    const d = PMNode.fromJSON(schema, json);
    d.check();
    return { doc: d, repaired: false };
  } catch { /* repair below */ }
  const clean = (n) => {
    if (!n || typeof n !== 'object') return [];
    if (n.type === 'text') {
      return typeof n.text === 'string' && n.text ? [{ type: 'text', text: n.text, marks: (n.marks || []).filter((m) => m && schema.marks[m.type]) }] : [];
    }
    const kids = (n.content || []).flatMap(clean);
    if (!schema.nodes[n.type]) return kids;
    const out = { type: n.type, attrs: n.attrs, marks: (n.marks || []).filter((m) => m && schema.marks[m.type]) };
    if (kids.length) out.content = kids;
    return [out];
  };
  const blocks = [];
  let inline = [];
  const flush = () => {
    if (inline.length) { try { blocks.push(schema.node('paragraph', null, inline)); } catch { /* dropped */ } inline = []; }
  };
  for (const b of ((json && json.content) || []).flatMap(clean)) {
    let node = null;
    try { node = schema.nodeFromJSON(b); node.check(); } catch { node = null; }
    if (node && node.isInline) { inline.push(node); continue; }
    flush();
    if (node && node.isBlock) blocks.push(node);
    else {
      for (const line of jsonText(b).split('\n')) blocks.push(schema.node('paragraph', null, line ? [schema.text(line)] : []));
    }
  }
  flush();
  let doc = schema.node('doc', null, blocks.length ? blocks : [schema.node('paragraph')]);
  const fix = fixTables(EditorState.create({ doc }));
  if (fix) doc = fix.doc;
  return { doc, repaired: true };
}

// ---------- the editor's document ----------

function setDocument(rec, { focus = false, keepSelection = false } = {}) {
  const view = ctx.view;
  const parsed = rec.doc ? { doc: rec.doc, repaired: false } : parseContent(rec.content);
  const doc = parsed.doc;
  const prevSel = view.state.selection;
  let state = ctx.makeState(doc);
  if (keepSelection) {
    const max = doc.content.size;
    try { state = state.apply(state.tr.setSelection(TextSelection.create(doc, Math.min(prevSel.from, max), Math.min(prevSel.to, max)))); } catch { /* start of the document */ }
  }
  view.updateState(state);
  session.current = {
    id: rec.id,
    title: rec.title || '',
    createdAt: rec.createdAt || Date.now(),
    updatedAt: rec.updatedAt || 0,
    rev: rec.rev || 0,
    settings: rec.settings || { writingMode: 'horizontal-tb' },
    persisted: !!rec.persisted,
    starred: !!rec.starred,
    trashedAt: rec.trashedAt || null,
    lastVersionAt: rec.lastVersionAt || 0,
    loaded: doc, // what was stored when opened, for the first version of this visit
    loadedSnapshotted: false,
    createdHere: !!rec.createdHere,
  };
  session.dirty = false;
  session.error = '';
  if (parsed.repaired) toast('この文書の一部が読み込めなかったため、修復して開きました', 6000);
  emit('doc:opened', { focus, keepSelection });
  emit('save-state', store.storeInfo.persistent ? 'ok' : 'memory');
}

export function setHash(id) {
  const h = '#/d/' + id;
  if (location.hash !== h) history.replaceState(null, '', h);
  store.writePref('last', id);
}

export function setTitle(title) {
  if (!session.current) return;
  session.current.title = title;
  markDirty();
}

// ---------- saving ----------

let saveTimer = null, maxTimer = null, again = false, retryTimer = null, retryDelay = 2000;
let saving = null;

export function markDirty() {
  if (!session.current) return;
  session.dirty = true;
  emit('save-state', 'busy');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY);
  if (!maxTimer) maxTimer = setTimeout(save, SAVE_MAX_WAIT);
}

// Saves now if there is anything to save; resolves when the document on screen is stored.
export function save(opts = {}) {
  if (saving) { again = true; return saving.then(() => (session.dirty ? save(opts) : undefined)); }
  saving = doSave(opts).finally(() => {
    saving = null;
    if (again) { again = false; if (session.dirty) save(); }
  });
  return saving;
}

function record(cur, doc, now) {
  return {
    id: cur.id,
    title: cur.title,
    preview: firstLine(doc),
    chars: stats(doc).noSpace,
    createdAt: cur.createdAt,
    updatedAt: now,
    images: imageRefs(doc),
    content: doc.toJSON(),
    settings: cur.settings,
    text: plainText(doc),
  };
}

async function doSave({ manual = false } = {}) {
  clearTimeout(saveTimer); clearTimeout(maxTimer); clearTimeout(retryTimer);
  saveTimer = maxTimer = retryTimer = null;
  const cur = session.current;
  if (!cur || !session.dirty) {
    if (manual) toast(store.storeInfo.persistent ? '保存済みです' : 'このブラウザでは保存できません。書き出して保管してください');
    return;
  }
  session.saving = true;
  session.dirty = false;
  try {
    await internalizeImages(ctx.view);
    if (session.current !== cur) return;
    // the state when this visit started goes into the history before it is overwritten
    if (cur.persisted && !cur.loadedSnapshotted && cur.updatedAt > (cur.lastVersionAt || 0)) {
      cur.loadedSnapshotted = true;
      await snapshot(cur, cur.loaded, { time: cur.updatedAt, title: cur.title });
    }
    cur.loadedSnapshotted = true;
    const now = Date.now();
    const doc = ctx.view.state.doc;
    const rec = record(cur, doc, now);
    let rev;
    try {
      rev = await store.saveDoc(rec, cur.rev);
    } catch (err) {
      if (!(err instanceof store.ConflictError)) throw err;
      rev = await resolveConflict(cur, rec);
    }
    cur.rev = rev;
    cur.updatedAt = now;
    cur.persisted = true;
    session.error = '';
    retryDelay = 2000;
    store.announce({ type: 'saved', id: cur.id, rev });
    emit('saved', cur);
    if (!session.dirty) emit('save-state', store.storeInfo.persistent ? 'ok' : 'memory');
    if (manual) toast('保存しました');
    if (now - (cur.lastVersionAt || cur.createdAt) >= VERSION_EVERY) await snapshot(cur, doc, { time: now, title: cur.title }).catch(() => {});
    askPersistence();
  } catch (err) {
    session.dirty = true;
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message)));
    session.error = quota
      ? '保存できません：ブラウザの保存容量がいっぱいです。不要な文書や大きな画像を削除するか、書き出して保管してください'
      : '保存できませんでした。自動でやり直します';
    emit('save-state', 'error');
    toast(session.error, 6000);
    retryTimer = setTimeout(save, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60000);
  } finally {
    session.saving = false;
  }
}

// Another tab saved this document since we loaded it: keep what is on this screen, and put the
// other tab's version into the history so nothing is lost.
async function resolveConflict(cur, rec) {
  for (let i = 0; i < 3; i++) {
    const other = await store.getDoc(cur.id);
    if (other) {
      await store.addVersion({ docId: cur.id, content: other.content, title: other.title, chars: other.chars, images: other.images, name: '別のタブで保存された内容', kind: 'conflict', time: other.updatedAt });
    }
    try {
      const rev = await store.saveDoc(rec, other ? other.rev || 0 : 0);
      toast('別のタブでも同じ文書が編集されていました。そちらの内容は変更履歴に残し、この画面の内容で保存しました', 7000);
      return rev;
    } catch (err) {
      if (!(err instanceof store.ConflictError)) throw err;
    }
  }
  return store.saveDoc(rec, 0, { force: true });
}

let persistAsked = store.readPref('persistAsked', false);
function askPersistence() {
  if (persistAsked || !store.storeInfo.persistent) return;
  persistAsked = true;
  store.writePref('persistAsked', true);
  // Firefox asks the user with a prompt; there it is left to the settings dialog
  if (!/Firefox\//.test(navigator.userAgent)) store.requestPersist();
}

// ---------- versions ----------

async function snapshot(cur, doc, { time, title, name = '', kind = 'auto' }) {
  await store.addVersion({ docId: cur.id, content: doc.toJSON(), title, chars: stats(doc).noSpace, images: imageRefs(doc), time, name, kind });
  if (kind === 'auto' || time >= (cur.lastVersionAt || 0)) {
    cur.lastVersionAt = Math.max(cur.lastVersionAt || 0, time);
    await store.patchMeta(cur.id, { lastVersionAt: cur.lastVersionAt });
  }
  store.pruneVersions(cur.id).catch(() => {});
}

export async function listVersions() {
  return session.current ? store.listVersions(session.current.id) : [];
}

export async function versionDoc(vid) {
  const json = await store.getVersionContent(vid);
  return json ? parseContent(json).doc : null;
}

// Saves the current state as a named version (Docs: 「現在の版に名前を付ける」).
export async function nameCurrentVersion(name) {
  const cur = session.current;
  if (!cur) return;
  if (session.dirty || !cur.persisted) { session.dirty = true; await save(); }
  await snapshot(cur, ctx.view.state.doc, { time: Date.now(), title: cur.title, name, kind: 'named' });
}

export async function renameVersion(vid, name) { await store.renameVersion(vid, name); }

// Puts an old version back as an ordinary (undoable) edit, after keeping the current state.
export async function restoreVersion(vid) {
  const cur = session.current;
  const doc = await versionDoc(vid);
  if (!cur || !doc) return false;
  if (session.dirty) await save();
  await snapshot(cur, ctx.view.state.doc, { time: Date.now(), title: cur.title, name: '復元する前の内容', kind: 'named' });
  const view = ctx.view;
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
  tr.setSelection(TextSelection.atStart(tr.doc));
  view.dispatch(tr.scrollIntoView());
  await save();
  return true;
}

// ---------- opening, creating, trash ----------

let queue = Promise.resolve();
// Document switches run one at a time, so quick taps can't interleave two of them.
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

function isUntouched() {
  const cur = session.current;
  const doc = ctx.view.state.doc;
  return cur && cur.createdHere && !cur.title && doc.childCount === 1 && doc.firstChild.isTextblock && doc.firstChild.content.size === 0;
}

// Flushes the current document; drops it if it was created in this visit and left empty.
async function leaveCurrent() {
  const cur = session.current;
  if (!cur) return;
  if (session.dirty || saving) await save();
  if (cur.persisted && isUntouched()) {
    await store.purgeDoc(cur.id).catch(() => {});
    store.announce({ type: 'purged', id: cur.id });
  }
}

export function openDoc(id, { focus = false } = {}) {
  return serial(async () => {
    if (session.current && session.current.id === id) return true;
    const rec = await store.getDoc(id);
    if (!rec) return false;
    await leaveCurrent();
    setDocument({ ...rec, persisted: true }, { focus });
    setHash(id);
    emit('docs:changed');
    return true;
  });
}

export function newDoc({ doc = null, title = '', focus = true } = {}) {
  return serial(async () => {
    await leaveCurrent();
    const now = Date.now();
    const rec = { id: store.newId(), title, createdAt: now, updatedAt: 0, rev: 0, doc: doc || emptyDoc(), settings: { writingMode: 'horizontal-tb' }, persisted: false, createdHere: true };
    setDocument(rec, { focus });
    setHash(rec.id);
    if (doc || title) { session.dirty = true; await save(); }
    emit('docs:changed');
    return rec.id;
  });
}

export async function duplicateDoc(id) {
  const rec = await store.getDoc(id);
  if (!rec) return null;
  const { doc } = parseContent(rec.content);
  const newId = await newDoc({ doc, title: displayTitle(rec) + ' のコピー', focus: false });
  toast('コピーを作りました');
  return newId;
}

async function openSomethingElse(exceptId) {
  const list = (await store.listDocs()).filter((m) => m.id !== exceptId && !m.trashedAt);
  session.current = null;
  session.dirty = false;
  if (list.length) await openDocNow(list[0].id);
  else await newDocNow();
}
// (versions of openDoc/newDoc for use inside serial())
async function openDocNow(id) {
  const rec = await store.getDoc(id);
  if (!rec) return false;
  setDocument({ ...rec, persisted: true }, { focus: false });
  setHash(id);
  return true;
}
async function newDocNow() {
  const now = Date.now();
  const rec = { id: store.newId(), title: '', createdAt: now, updatedAt: 0, rev: 0, doc: emptyDoc(), settings: { writingMode: 'horizontal-tb' }, persisted: false, createdHere: true };
  setDocument(rec, { focus: false });
  setHash(rec.id);
}

export function trashDoc(id) {
  return serial(async () => {
    const cur = session.current;
    const isCurrent = cur && cur.id === id;
    if (isCurrent) {
      if (session.dirty || saving) await save();
      if (!cur.persisted) { await openSomethingElse(id); emit('docs:changed'); return; }
    }
    const meta = await store.patchMeta(id, { trashedAt: Date.now() });
    store.announce({ type: 'meta', id });
    if (isCurrent) await openSomethingElse(id);
    emit('docs:changed');
    toast(`「${displayTitle(meta)}」をゴミ箱に移動しました`, { action: { label: '元に戻す', run: () => restoreDoc(id, { open: true }) } });
  });
}

export async function restoreDoc(id, { open = false } = {}) {
  await store.patchMeta(id, { trashedAt: undefined });
  store.announce({ type: 'meta', id });
  if (session.current && session.current.id === id) { session.current.trashedAt = null; emit('doc:meta', session.current); }
  emit('docs:changed');
  if (open) await openDoc(id);
}

export function purgeDoc(id) {
  return serial(async () => {
    await store.purgeDoc(id);
    store.announce({ type: 'purged', id });
    if (session.current && session.current.id === id) await openSomethingElse(id);
    emit('docs:changed');
  });
}

export async function emptyTrash() {
  const trashed = (await store.listDocs()).filter((m) => m.trashedAt);
  for (const m of trashed) await purgeDoc(m.id);
  return trashed.length;
}

export async function toggleStar(id) {
  const m = await store.getMeta(id);
  if (!m) {
    // a new document that isn't stored yet: store it first
    if (session.current && session.current.id === id) { session.dirty = true; await save(); return toggleStar(id); }
    return;
  }
  const next = await store.patchMeta(id, { starred: !m.starred });
  if (session.current && session.current.id === id) { session.current.starred = !!next.starred; emit('doc:meta', session.current); }
  store.announce({ type: 'meta', id });
  emit('docs:changed');
}

// ---------- other tabs ----------

store.onAnnounce(async (msg) => {
  emit('docs:changed');
  const cur = session.current;
  if (!cur || msg.id !== cur.id) return;
  if (msg.type === 'saved') {
    if (session.dirty || session.saving) return; // our next save notices the newer revision
    const rec = await store.getDoc(cur.id);
    if (rec && (rec.rev || 0) > (cur.rev || 0) && !session.dirty) {
      setDocument({ ...rec, persisted: true }, { keepSelection: true, focus: ctx.view.hasFocus() });
    }
  } else if (msg.type === 'meta') {
    const m = await store.getMeta(cur.id);
    if (m) { cur.starred = !!m.starred; cur.trashedAt = m.trashedAt || null; emit('doc:meta', cur); }
  } else if (msg.type === 'purged') {
    cur.persisted = false;
    cur.rev = 0;
    toast('この文書は別のタブで完全に削除されました。書き続けると新しく保存されます', 6000);
  }
});

// ---------- housekeeping ----------

// Old trash goes for good; unused images are cleared once a day. Runs when the browser is idle.
export async function housekeeping() {
  const now = Date.now();
  const list = await store.listDocs();
  for (const m of list) {
    if (m.trashedAt && now - m.trashedAt > TRASH_DAYS * 864e5 && !(session.current && session.current.id === m.id)) {
      await store.purgeDoc(m.id).catch(() => {});
    }
  }
  if (now - store.readPref('lastGc', 0) > 864e5) {
    store.writePref('lastGc', now);
    await store.collectGarbage().catch(() => {});
  }
}

// The previous app's manuscript, brought over once.
export async function migrateGenkocho() {
  if (store.readPref('migratedGenkocho', false)) return null;
  let md = '', title = '';
  try {
    const v2 = JSON.parse(localStorage.getItem('genkocho/v2') || 'null');
    if (v2 && typeof v2.md === 'string' && !v2.pristine) { md = v2.md; title = v2.title || ''; }
    else {
      const v1 = JSON.parse(localStorage.getItem('genkocho/v1') || 'null');
      if (v1 && Array.isArray(v1.chapters) && !v1.pristine) {
        title = v1.title || '';
        md = v1.chapters.map((c) => ['# ' + (String(c.title || '').replace(/\n/g, ' ') || '無題'), ...String(c.body || '').split('\n')].join('\n')).join('\n');
      }
    }
  } catch { /* nothing to bring over */ }
  store.writePref('migratedGenkocho', true);
  if (!md.trim()) return null;
  const now = Date.now();
  const doc = fromGenkocho(md);
  const rec = { id: store.newId(), title: title || '原稿帳の原稿', preview: firstLine(doc), chars: stats(doc).noSpace, createdAt: now, updatedAt: now, images: [], content: doc.toJSON(), settings: { writingMode: 'horizontal-tb' }, text: plainText(doc) };
  await store.saveDoc(rec, 0);
  return rec;
}
