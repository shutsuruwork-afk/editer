import { EditorState, TextSelection, Selection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from './editor/schema.js';
import { buildPlugins, nodeViews, footnotesOf } from './editor/plugins.js';
import * as C from './editor/commands.js';
import { toMarkdown, fromMarkdown, toHtml, fromHtml } from './editor/convert.js';
import * as store from './store.js';
import { ctx, on, run, $, fmt, UNTITLED } from './app/ctx.js';
import { settings, applySettings } from './app/settings.js';
import * as docs from './app/docs.js';
import { stats, countText, selectionText, firstLine, plainText } from './app/text.js';
import { storeFile, withInlineImages } from './app/images.js';
import { toast } from './ui/toast.js';
import { icon } from './ui/icons.js';
import { closePop } from './ui/pop.js';
import { initToolbar, updateToolbar } from './ui/toolbar.js';
import { initBubble, updateBubble } from './ui/bubble.js';
import { initFind, openFind, closeFind, isFindOpen, updateFindCount, pushQuery } from './ui/find.js';
import { initDrawer, closeDrawer, updateOutlineCurrent, goToPos, renderOutline } from './ui/drawer.js';
import { initDialogs, openLinkDialog, openCounts, openSettings, openShortcuts, openFootnote, insertFootnote, imageFromUrl, editAlt, promptBox } from './ui/dialogs.js';
import { initHistory, openHistory } from './ui/history.js';
import { initMenu, saveFile } from './ui/menu.js';
import { stopPaint, copyFormat, pasteFormat, initPaint } from './ui/paint.js';

for (const e of document.querySelectorAll('[data-icon]')) e.innerHTML = icon(e.dataset.icon);
document.addEventListener('editer:notice', (e) => toast(e.detail));

// ---------- the editor ----------

let readOnly = false;

const app = {
  onEscape: () => closeTransient(),
  openLinkEditor: () => openLinkDialog(),
  openFind: (replace) => openFind(replace),
  saveNow: () => docs.save({ manual: true }),
  showCounts: () => openCounts(),
  insertFootnote: () => insertFootnote(),
  copyFormat,
  pasteFormat,
  showShortcuts: () => openShortcuts(),
  openHistory: () => openHistory(),
};
const plugins = buildPlugins(app);
ctx.makeState = (doc) => EditorState.create({ doc, plugins });

const view = new EditorView($('#editor'), {
  state: ctx.makeState(docs.emptyDoc()),
  nodeViews,
  editable: () => !readOnly,
  attributes: { spellcheck: 'false', autocapitalize: 'off', 'aria-label': '本文', role: 'textbox', 'aria-multiline': 'true', translate: 'no' },
  dispatchTransaction(tr) {
    view.updateState(view.state.apply(tr));
    if (tr.docChanged && !tr.getMeta('internal')) docs.markDirty();
    scheduleUi();
  },
  handleDOMEvents: {
    focus: () => { scheduleUi(); return false; },
    blur: () => { setTimeout(scheduleUi, 0); return false; },
  },
  handleClickOn(v, pos, node, nodePos, event, direct) {
    if (node.type === schema.nodes.footnote && direct) {
      if (readOnly) toast(node.attrs.text || '（空の脚注）', 6000);
      else setTimeout(() => openFootnote(nodePos), 0);
      return false;
    }
    // Ctrl/⌘-click opens links, like Docs
    const a = event.target.closest && event.target.closest('a[href]');
    if (a && (event.metaKey || event.ctrlKey || readOnly)) {
      window.open(a.href, '_blank', 'noopener');
      return true;
    }
    return false;
  },
});
ctx.view = view;
view.dom.spellcheck = !!settings.spellcheck;

// Clicking the margins or below the text puts the caret on the nearest line, like on paper.
$('#scroller').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || (e.target !== e.currentTarget && e.target !== $('#page'))) return;
  e.preventDefault();
  const r = view.dom.getBoundingClientRect();
  let sel;
  if (e.clientY >= r.bottom) sel = Selection.atEnd(view.state.doc);
  else {
    const hit = view.posAtCoords({ left: Math.min(Math.max(e.clientX, r.left + 2), r.right - 2), top: Math.max(e.clientY, r.top + 2) });
    sel = hit ? TextSelection.near(view.state.doc.resolve(hit.pos)) : Selection.atEnd(view.state.doc);
  }
  view.dispatch(view.state.tr.setSelection(sel));
  view.focus();
});

// links from the table of contents block, and footnotes listed at the end
view.dom.addEventListener('editer:goto', (e) => goToPos(e.detail));
view.dom.addEventListener('editer:footnote', (e) => {
  const f = footnotesOf(view.state.doc)[e.detail.index];
  if (!f) return;
  if (readOnly) toast(f.text || '（空の脚注）', 6000); else openFootnote(f.pos);
});

let uiQueued = false;
function scheduleUi() {
  if (uiQueued) return;
  uiQueued = true;
  requestAnimationFrame(() => {
    uiQueued = false;
    updateToolbar();
    updateBubble();
    updateCount();
    updateFindCount();
    updateOutlineCurrent();
  });
}

function updateCount() {
  const pill = $('#countPill');
  if (!settings.showCount) { pill.textContent = ''; return; }
  const s = view.state;
  const total = stats(s.doc).noSpace;
  if (!s.selection.empty && s.selection.from !== s.selection.to && !s.selection.node) {
    pill.textContent = `選択 ${fmt(countText(selectionText(s)).noSpace)} / ${fmt(total)} 字`;
  } else pill.textContent = `${fmt(total)} 字`;
}
$('#countPill').addEventListener('click', openCounts);
on('settings', () => { updateCount(); view.dom.spellcheck = !!settings.spellcheck; });

// ---------- actions used by the toolbar, menus and dialogs ----------

async function insertImageFiles(files) {
  for (const f of files) {
    try {
      const src = await storeFile(f);
      if (!run(C.insertImage(src, f.name.replace(/\.[^.]+$/, '')))) toast('ここには画像を挿入できません');
    } catch { toast('画像を読み込めませんでした（' + f.name + '）'); }
  }
}
$('#fileImage').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  insertImageFiles(files);
});

const actions = {
  openLink: () => openLinkDialog(),
  pickImage: () => $('#fileImage').click(),
  imageFromUrl: () => imageFromUrl(),
  insertFootnote: () => insertFootnote(),
  insertDate: () => run(C.insertText(new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }))),
  listStart: async () => {
    const l = C.currentList(view.state);
    if (!l || l.node.type !== schema.nodes.ordered_list) return;
    const v = await promptBox('開始番号', 'このリストの最初の番号', String(l.node.attrs.order), { inputmode: 'numeric' });
    const n = parseInt(v, 10);
    if (n >= 0) run(C.setNodeAttrs(l.pos, { order: n }));
  },
  editAlt: (pos) => editAlt(pos),
  openHistory: () => openHistory(),
  openCounts: () => openCounts(),
  openSettings: () => openSettings(),
  openShortcuts: () => openShortcuts(),
  setReadOnly: (on) => setReadOnly(on),
  saveFile: (name, data, mime) => saveFile(name, data, mime),
};

initToolbar(actions);
initBubble(actions);
initFind();
initDrawer();
initDialogs(actions);
initHistory();
initMenu(actions);
initPaint();

// ---------- the open document: title, star, banner, save state ----------

const titleInput = $('#docTitle');

function pageTitle() {
  const cur = docs.session.current;
  document.title = ((cur && cur.title) || firstLine(view.state.doc) || UNTITLED) + ' - editer';
}

function updateBanner() {
  const cur = docs.session.current;
  const banner = $('#banner');
  if (cur && cur.trashedAt) {
    $('#bannerText').textContent = 'この文書はゴミ箱にあります。';
    $('#bannerAction').textContent = '復元';
    $('#bannerAction').onclick = () => docs.restoreDoc(cur.id);
    banner.hidden = false;
  } else if (readOnly) {
    $('#bannerText').textContent = '閲覧モードです（編集できません）。';
    $('#bannerAction').textContent = '編集する';
    $('#bannerAction').onclick = () => setReadOnly(false);
    banner.hidden = false;
  } else banner.hidden = true;
}

function updateStar() {
  const cur = docs.session.current;
  const b = $('#btnStar');
  const on = !!(cur && cur.starred);
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'スターを外す' : 'スターを付ける');
  b.title = on ? 'スター付き' : 'スターを付ける';
}

function setReadOnly(on) {
  readOnly = !!on;
  document.documentElement.toggleAttribute('data-readonly', readOnly);
  view.setProps({ editable: () => !readOnly });
  if (readOnly) { closePop(); stopPaint(); view.dom.blur(); }
  updateBanner();
  scheduleUi();
}

on('doc:opened', ({ focus, keepSelection }) => {
  const cur = docs.session.current;
  titleInput.value = cur.title;
  pageTitle();
  updateStar();
  updateBanner();
  if (isFindOpen()) pushQuery();
  if (!keepSelection) $('#scroller').scrollTop = 0;
  if (focus && !readOnly) view.focus();
  renderOutline();
  scheduleUi();
});
on('doc:meta', () => { updateStar(); updateBanner(); });
on('saved', pageTitle);

const SAVE_TEXT = { ok: ['', '保存済み'], busy: ['busy', '保存中…'], error: ['warn', '保存エラー'], memory: ['warn', '一時保存のみ'] };
on('save-state', (kind) => {
  const [cls, text] = SAVE_TEXT[kind] || SAVE_TEXT.ok;
  const el = $('#saveState');
  el.className = 'save' + (cls ? ' ' + cls : '');
  $('#saveText').textContent = text;
  el.title = kind === 'error' ? docs.session.error
    : kind === 'memory' ? 'このブラウザでは保存できません。書き出して保管してください'
    : 'このブラウザに自動保存しています';
});

titleInput.addEventListener('input', () => { docs.setTitle(titleInput.value.trim()); pageTitle(); });
titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); view.focus(); } });
$('#btnStar').addEventListener('click', () => { if (docs.session.current) docs.toggleStar(docs.session.current.id); });
$('#btnHistory').addEventListener('click', () => openHistory());

// ---------- closing things, global keys ----------

function closeTransient() {
  return stopPaint() || closePop() || closeFind() || closeDrawer();
}

const isMacKey = (e) => (/Mac|iP(hone|[oa]d)/.test(navigator.platform) ? e.metaKey : e.ctrlKey);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
    if (stopPaint() || closePop() || closeDrawer()) e.preventDefault();
    return;
  }
  if (view.hasFocus()) return; // the editor's own keymap handles these
  const mod = isMacKey(e);
  const k = e.key.toLowerCase();
  if (mod && !e.altKey && k === 'f') { e.preventDefault(); openFind(false); }
  else if (mod && !e.altKey && k === 'h') { e.preventDefault(); openFind(true); }
  else if (mod && !e.altKey && k === 's') { e.preventDefault(); docs.save({ manual: true }); }
  else if (mod && k === '/') { e.preventDefault(); openShortcuts(); }
  else if (mod && e.altKey && e.shiftKey && k === 'h') { e.preventDefault(); openHistory(); }
});

// ---------- phones: keep the page above the keyboard ----------

const vv = window.visualViewport;
function fitViewport() {
  const r = document.documentElement.style;
  r.setProperty('--app-h', vv.height + 'px');
  r.setProperty('--app-top', vv.offsetTop + 'px');
  if (view.hasFocus()) requestAnimationFrame(() => view.dispatch(view.state.tr.scrollIntoView()));
}
if (vv && ctx.touch.matches) {
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
  window.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });
}

// ---------- never lose what was typed ----------

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && docs.session.dirty) docs.save(); });
window.addEventListener('pagehide', () => { if (docs.session.dirty) docs.save(); });
window.addEventListener('beforeunload', (e) => { if (docs.session.dirty) { docs.save(); e.preventDefault(); } });
window.addEventListener('error', (e) => console.error(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error(e.reason));

window.addEventListener('hashchange', () => {
  const m = /^#\/d\/([\w-]+)$/.exec(location.hash);
  const cur = docs.session.current;
  if (m && (!cur || cur.id !== m[1])) docs.openDoc(m[1]).then((ok) => { if (!ok) toast('この文書は見つかりません'); });
});

// ---------- start ----------

applySettings();
(async () => {
  await store.ready();
  if (!store.storeInfo.persistent) toast('このブラウザでは文書を保存できません（プライベートブラウズなど）。書き出して保管してください', 7000);
  let migrated = null;
  try { migrated = await docs.migrateGenkocho(); } catch { migrated = null; }
  const hash = /^#\/d\/([\w-]+)$/.exec(location.hash);
  const list = (await store.listDocs()).filter((m) => !m.trashedAt);
  const focus = !ctx.touch.matches;
  let opened = false;
  if (hash) opened = await docs.openDoc(hash[1], { focus });
  if (!opened && migrated) opened = await docs.openDoc(migrated.id, { focus });
  if (!opened) { const last = store.readPref('last', null); if (last && list.some((m) => m.id === last)) opened = await docs.openDoc(last, { focus }); }
  if (!opened && list.length) opened = await docs.openDoc(list[0].id, { focus });
  if (!opened) await docs.newDoc({ focus });
  if (migrated) toast(`以前の原稿帳の原稿を「${migrated.title}」として取り込みました`, 6000);
  scheduleUi();
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 2000));
  idle(() => docs.housekeeping().catch(() => {}));
})();

// for tests and debugging
window.editer = {
  view, schema, store, docs, toMarkdown, fromMarkdown, toHtml, fromHtml, footnotesOf,
  pm: { TextSelection, Selection, EditorState },
  text: { stats, plainText },
  makeState: (doc) => ctx.makeState(doc),
  exportHtml: async () => toHtml(await withInlineImages(view.state.doc), 'export'),
};
