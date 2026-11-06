// The side drawer: the document list (all / starred / trash, sort, search through titles and text)
// and the outline of the open document.
import { TextSelection } from 'prosemirror-state';
import * as store from '../store.js';
import { ctx, on, $, el, fmt } from '../app/ctx.js';
import { session, displayTitle, openDoc, newDoc, duplicateDoc, trashDoc, restoreDoc, purgeDoc, emptyTrash, toggleStar } from '../app/docs.js';
import { firstLine } from '../app/text.js';
import { headingsOf } from '../editor/plugins.js';
import { icon } from './icons.js';
import { openPop, closePop, menuItem } from './pop.js';
import { confirmBox } from './dialogs.js';
import { toast } from './toast.js';

let drawer, scrim;
let listView = store.readPref('docsView', 'all');
let sortBy = store.readPref('docsSort', 'updated');
let outlineItems = [];

export const isDrawerOpen = () => drawer && !drawer.hidden;

export function openDrawer(tab) {
  closePop();
  drawer.hidden = false;
  scrim.hidden = false;
  $('#btnDrawer').setAttribute('aria-expanded', 'true');
  showTab(tab || store.readPref('drawerTab', 'docs'));
  refreshDocs();
}

export function closeDrawer() {
  if (!isDrawerOpen()) return false;
  drawer.hidden = true;
  scrim.hidden = true;
  $('#btnDrawer').setAttribute('aria-expanded', 'false');
  return true;
}

function showTab(tab) {
  const docsTab = tab !== 'outline';
  $('#tabDocs').setAttribute('aria-selected', String(docsTab));
  $('#tabOutline').setAttribute('aria-selected', String(!docsTab));
  $('#paneDocs').hidden = !docsTab;
  $('#paneOutline').hidden = docsTab;
  store.writePref('drawerTab', docsTab ? 'docs' : 'outline');
  if (!docsTab) renderOutline();
}

const timeFmt = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
export function when(t) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return d.getFullYear() === now.getFullYear() ? timeFmt.format(d) : dayFmt.format(d);
}

let refreshTimer = null;
export function refreshDocsSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshDocs, 120);
}

let refreshSeq = 0;
export async function refreshDocs() {
  if (!isDrawerOpen() || $('#paneDocs').hidden) return;
  const seq = ++refreshSeq;
  let list = await store.listDocs();
  const cur = session.current;
  if (cur && !cur.persisted && !list.some((m) => m.id === cur.id)) {
    list.unshift({ id: cur.id, title: cur.title, preview: firstLine(ctx.view.state.doc), updatedAt: Date.now(), createdAt: cur.createdAt, chars: 0, unsaved: true });
  }
  const q = $('#docsFilter').value.trim();
  const hits = q ? await store.searchText(q) : null;
  if (seq !== refreshSeq) return; // a newer refresh is on its way
  list = list.filter((m) => (listView === 'trash' ? m.trashedAt : !m.trashedAt && (listView !== 'starred' || m.starred)));
  if (q) {
    const ql = q.toLowerCase();
    list = list.filter((m) => displayTitle(m).toLowerCase().includes(ql) || hits.has(m.id));
  }
  if (sortBy === 'title') list.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b), 'ja'));
  else if (sortBy === 'created') list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const ul = $('#docsList');
  ul.innerHTML = '';
  for (const m of list) ul.append(item(m, q, hits));
  if (!list.length) {
    ul.append(el('li', { class: 'muted empty', text: q ? '見つかりません' : listView === 'trash' ? 'ゴミ箱は空です' : listView === 'starred' ? 'スター付きの文書はありません' : '文書はまだありません' }));
  }
  $('#trashFoot').hidden = listView !== 'trash' || !list.length;
}

function item(m, q, hits) {
  const name = displayTitle(m);
  const li = el('li', { class: 'doc-item' + (session.current && m.id === session.current.id ? ' current' : '') });
  const open = el('button', { type: 'button', class: 'doc-open' });
  const nm = el('span', { class: 'doc-name' + (m.title ? '' : ' untitled') });
  if (m.starred) nm.append(el('span', { class: 'doc-star', html: icon('star'), 'aria-label': 'スター付き' }));
  nm.append(document.createTextNode(name));
  const meta = el('span', { class: 'doc-meta' });
  const hit = hits && hits.get(m.id);
  if (hit && !name.toLowerCase().includes(q.toLowerCase())) {
    const start = Math.max(0, hit.index - 16);
    const t = hit.text.slice(start, hit.index + q.length + 40).replace(/\s+/g, ' ');
    const at = hit.index - start;
    meta.append(document.createTextNode((start ? '…' : '') + t.slice(0, at)), el('mark', { text: t.slice(at, at + q.length) }), document.createTextNode(t.slice(at + q.length)));
  } else if (m.trashedAt) {
    meta.textContent = `${when(m.trashedAt)} に削除`;
  } else {
    meta.textContent = m.unsaved ? '新しい文書' : `${when(m.updatedAt)} ・ ${fmt(m.chars || 0)} 字`;
  }
  open.append(nm, meta);
  open.addEventListener('click', async () => {
    if (m.trashedAt) { toast('ゴミ箱の文書は、復元すると開けます'); return; }
    closeDrawer();
    if (!(session.current && session.current.id === m.id)) await openDoc(m.id, { focus: !ctx.touch.matches });
  });
  const more = el('button', { type: 'button', class: 'icon sm', 'aria-label': name + ' の操作', 'aria-haspopup': 'menu', html: icon('more') });
  more.addEventListener('click', () => openPop(more, (p) => {
    if (m.trashedAt) {
      p.append(menuItem({ icon: 'restore', label: '復元', onClick: () => restoreDoc(m.id) }));
      p.append(menuItem({ icon: 'trash', label: '完全に削除', danger: true, onClick: async () => {
        if (await confirmBox('完全に削除', `「${name}」を完全に削除します。変更履歴も消え、元に戻せません。`, '完全に削除')) purgeDoc(m.id);
      } }));
      return;
    }
    p.append(menuItem({ icon: 'star', label: m.starred ? 'スターを外す' : 'スターを付ける', onClick: () => toggleStar(m.id) }));
    p.append(menuItem({ icon: 'copy', label: 'コピーを作成', onClick: () => duplicateDoc(m.id) }));
    p.append(menuItem({ icon: 'trash', label: 'ゴミ箱に移動', danger: true, onClick: () => trashDoc(m.id) }));
  }, { align: 'end' }));
  li.append(open, more);
  return li;
}

// ---------- outline ----------

export function renderOutline() {
  if (!isDrawerOpen() || $('#paneOutline').hidden) return;
  const ul = $('#outlineList');
  ul.innerHTML = '';
  outlineItems = headingsOf(ctx.view.state.doc).map((h) => {
    const b = el('button', { type: 'button', class: 'outline-item l' + h.level, text: h.text || '（空の見出し）' });
    b.addEventListener('click', () => goToPos(h.pos));
    ul.append(el('li', {}, b));
    return { pos: h.pos, el: b };
  });
  $('#outlineEmpty').hidden = outlineItems.length > 0;
  updateOutlineCurrent();
}

export function updateOutlineCurrent() {
  if (!outlineItems.length || !isDrawerOpen()) return;
  const at = ctx.view.state.selection.from;
  let cur = null;
  for (const it of outlineItems) if (it.pos <= at) cur = it;
  for (const it of outlineItems) it.el.classList.toggle('current', it === cur);
}

export function goToPos(pos) {
  closeDrawer();
  const view = ctx.view;
  const p = Math.min(pos + 1, view.state.doc.content.size);
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(p))));
  const dom = view.nodeDOM(pos);
  if (dom && dom.scrollIntoView) {
    dom.scrollIntoView({ block: 'start' });
    $('#scroller').scrollTop = Math.max(0, $('#scroller').scrollTop - 16);
  }
  if (!ctx.touch.matches) view.focus();
}

export function initDrawer() {
  drawer = $('#drawer');
  scrim = $('#scrim');
  $('#btnDrawer').addEventListener('click', () => (isDrawerOpen() ? closeDrawer() : openDrawer()));
  $('#drawerClose').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  $('#tabDocs').addEventListener('click', () => { showTab('docs'); refreshDocs(); });
  $('#tabOutline').addEventListener('click', () => showTab('outline'));
  $('#btnNewDoc').addEventListener('click', async () => { closeDrawer(); await newDoc({ focus: !ctx.touch.matches }); });
  let t = null;
  $('#docsFilter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(refreshDocs, 150); });
  for (const c of document.querySelectorAll('.chips .chip')) {
    c.setAttribute('aria-pressed', String(c.dataset.view === listView));
    c.addEventListener('click', () => {
      listView = c.dataset.view;
      store.writePref('docsView', listView);
      for (const x of document.querySelectorAll('.chips .chip')) x.setAttribute('aria-pressed', String(x === c));
      refreshDocs();
    });
  }
  const sortSel = $('#docsSort');
  sortSel.value = sortBy;
  sortSel.addEventListener('change', () => { sortBy = sortSel.value; store.writePref('docsSort', sortBy); refreshDocs(); });
  $('#btnEmptyTrash').addEventListener('click', async () => {
    if (!(await confirmBox('ゴミ箱を空にする', 'ゴミ箱の文書をすべて完全に削除します。元に戻せません。', '空にする'))) return;
    const n = await emptyTrash();
    toast(`${fmt(n)} 件の文書を完全に削除しました`);
  });
  // swipe left to close
  let x0 = null, y0 = 0;
  drawer.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
  drawer.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const tt = e.changedTouches[0];
    if (x0 - tt.clientX > 60 && Math.abs(tt.clientY - y0) < 50) closeDrawer();
    x0 = null;
  }, { passive: true });
  on('docs:changed', refreshDocsSoon);
  on('saved', refreshDocsSoon);
  on('doc:opened', () => { renderOutline(); refreshDocsSoon(); });
}
