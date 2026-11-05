import { EditorState, NodeSelection, TextSelection, Selection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Node as PMNode } from 'prosemirror-model';
import { undoDepth, redoDepth, undo, redo } from 'prosemirror-history';
import {
  addRowBefore, addRowAfter, addColumnBefore, addColumnAfter, deleteRow, deleteColumn,
  mergeCells, splitCell, toggleHeaderRow, deleteTable, setCellAttr, CellSelection,
} from 'prosemirror-tables';
import {
  SearchQuery, setSearchState, getSearchState, getMatchHighlights,
  findNext, findPrev, replaceNext, replaceAll as replaceAllCmd,
} from 'prosemirror-search';

import { schema, COLORS, safeHref } from './editor/schema.js';
import * as C from './editor/commands.js';
import { buildPlugins, nodeViews } from './editor/plugins.js';
import {
  fromMarkdown, fromHtml, fromText, fromGenkocho, decodeTextFile, toMarkdown, toHtml, toText,
} from './editor/convert.js';
import * as store from './store.js';
import { icon } from './ui/icons.js';
import { openPop, closePop, isPopOpen, menuItem, menuSep, menuLabel, keepFocus } from './ui/pop.js';

const $ = (s) => document.querySelector(s);
const N = schema.nodes;
const M = schema.marks;
const isMac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
const ALT = isMac ? '⌥' : 'Alt+';
const SHIFT = isMac ? '⇧' : 'Shift+';
const fmt = (n) => n.toLocaleString('ja-JP');
const touch = window.matchMedia('(pointer: coarse)');

for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);

// ---------- toast ----------

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
document.addEventListener('editer:notice', (e) => toast(e.detail));

// ---------- settings ----------

const DEFAULT_SETTINGS = { font: 'sans', size: 17, line: 1.75, page: 'page', theme: 'auto', showCount: true };
let settings = { ...DEFAULT_SETTINGS, ...store.readPref('settings', {}) };

function applySettings() {
  const r = document.documentElement;
  r.dataset.font = settings.font;
  r.dataset.page = settings.page;
  if (settings.theme === 'auto') delete r.dataset.theme; else r.dataset.theme = settings.theme;
  r.style.setProperty('--fs', settings.size + 'px');
  r.style.setProperty('--lh', String(settings.line));
  for (const [id, key] of [['#optFont', 'font'], ['#optSize', 'size'], ['#optLine', 'line'], ['#optPage', 'page'], ['#optTheme', 'theme']]) {
    for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(settings[key])));
  }
  $('#optShowCount').checked = settings.showCount;
  updateCount();
}
function setSetting(key, value) {
  settings[key] = value;
  store.writePref('settings', settings);
  applySettings();
}
for (const [id, key, num] of [['#optFont', 'font'], ['#optSize', 'size', true], ['#optLine', 'line', true], ['#optPage', 'page'], ['#optTheme', 'theme']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) setSetting(key, num ? +b.dataset.v : b.dataset.v);
  });
}
$('#optShowCount').addEventListener('change', (e) => setSetting('showCount', e.target.checked));

// ---------- the editor ----------

const app = {
  onEscape: () => closeTransient(),
  openLinkEditor: () => openLinkDialog(),
  openFind: (replace) => openFind(replace),
  saveNow: () => { saveNow(true); },
  showCounts: () => openCounts(),
};
const plugins = buildPlugins(app);

function emptyDoc() { return N.doc.create(null, [N.paragraph.create()]); }
function makeState(doc) { return EditorState.create({ doc, plugins }); }

const view = new EditorView($('#editor'), {
  state: makeState(emptyDoc()),
  nodeViews,
  attributes: { spellcheck: 'false', autocapitalize: 'off', 'aria-label': '本文', role: 'textbox', 'aria-multiline': 'true', translate: 'no' },
  dispatchTransaction(tr) {
    const state = view.state.apply(tr);
    view.updateState(state);
    if (tr.docChanged) markDirty();
    scheduleUi();
  },
  handleDOMEvents: {
    focus: () => { scheduleUi(); return false; },
    blur: () => { setTimeout(scheduleUi, 0); return false; },
  },
  handleClickOn(v, pos, node, nodePos, event) {
    // Ctrl/⌘-click opens links, like Docs
    if ((event.metaKey || event.ctrlKey) && event.target.closest && event.target.closest('a[href]')) {
      window.open(event.target.closest('a[href]').href, '_blank', 'noopener');
      return true;
    }
    return false;
  },
});

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

let uiQueued = false;
function scheduleUi() {
  if (uiQueued) return;
  uiQueued = true;
  requestAnimationFrame(() => { uiQueued = false; updateToolbar(); updateBubble(); updateCount(); updateFindCount(); updateOutlineCurrent(); });
}

const run = (cmd) => {
  const focused = view.hasFocus();
  const ok = cmd(view.state, view.dispatch, view);
  if (focused || !touch.matches) view.focus();
  return ok;
};

// ---------- toolbar ----------

const tb = $('#toolbar');
keepFocus(tb);
keepFocus($('#pop'));
keepFocus($('#bubble'));

const STYLES = [
  ['paragraph', '標準テキスト', `${MOD}${ALT}0`],
  ['h1', '見出し 1', `${MOD}${ALT}1`],
  ['h2', '見出し 2', `${MOD}${ALT}2`],
  ['h3', '見出し 3', `${MOD}${ALT}3`],
  ['h4', '見出し 4', `${MOD}${ALT}4`],
  ['code', 'コード', ''],
];
const ALIGN_ICON = { left: 'alignLeft', center: 'alignCenter', right: 'alignRight', justify: 'alignJustify' };
const COLOR_NAME = { gray: 'グレー', red: '赤', orange: 'オレンジ', yellow: '黄', green: '緑', blue: '青', purple: '紫' };

const buttons = {};
function addBtn(parent, key, ic, label, onClick, kbd) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon';
  b.innerHTML = icon(ic);
  b.setAttribute('aria-label', label);
  b.title = kbd ? `${label}（${kbd}）` : label;
  b.addEventListener('click', () => onClick(b));
  parent.append(b);
  if (key) buttons[key] = b;
  return b;
}
function group(cls = '') {
  const g = document.createElement('div');
  g.className = 'tb-group' + (cls ? ' ' + cls : '');
  tb.append(g);
  return g;
}
function sep(parent = tb) { const s = document.createElement('span'); s.className = 'sep'; parent.append(s); return s; }

// table tools come first so they are in view on phones
const gTable = group('table-tools');
gTable.hidden = true;
{
  const lbl = document.createElement('span');
  lbl.className = 'tb-label';
  lbl.textContent = '表';
  gTable.append(lbl);
  addBtn(gTable, 'rowAbove', 'rowAbove', '上に行を挿入', () => run(addRowBefore));
  addBtn(gTable, 'rowBelow', 'rowBelow', '下に行を挿入', () => run(addRowAfter));
  addBtn(gTable, 'colLeft', 'colLeft', '左に列を挿入', () => run(addColumnBefore));
  addBtn(gTable, 'colRight', 'colRight', '右に列を挿入', () => run(addColumnAfter));
  addBtn(gTable, 'rowDel', 'rowDelete', '行を削除', () => run(deleteRow));
  addBtn(gTable, 'colDel', 'colDelete', '列を削除', () => run(deleteColumn));
  addBtn(gTable, 'merge', 'merge', 'セルを結合', () => run(mergeCells));
  addBtn(gTable, 'split', 'split', 'セルの結合を解除', () => run(splitCell));
  addBtn(gTable, 'headerRow', 'headerRow', '見出し行の切り替え', () => run(toggleHeaderRow));
  addBtn(gTable, 'cellColor', 'cellColor', 'セルの背景色', (b) => openPalette(b, 'cell'));
  addBtn(gTable, 'tableDel', 'tableDelete', '表を削除', () => run(deleteTable));
  sep(gTable);
}

const gHist = group();
addBtn(gHist, 'undo', 'undo', '元に戻す', () => run(undo), `${MOD}Z`);
addBtn(gHist, 'redo', 'redo', 'やり直す', () => run(redo), isMac ? '⇧⌘Z' : 'Ctrl+Y');
sep();

const styleBtn = document.createElement('button');
styleBtn.type = 'button';
styleBtn.className = 'style-btn';
styleBtn.setAttribute('aria-haspopup', 'menu');
styleBtn.title = '段落のスタイル';
styleBtn.innerHTML = '<span id="styleLabel">標準テキスト</span>' + icon('chevron');
styleBtn.addEventListener('click', () => openPop(styleBtn, (p) => {
  const cur = C.blockStyle(view.state);
  for (const [v, label, kbd] of STYLES) {
    p.append(menuItem({ label, kbd, checked: cur === v, cls: 'style-item ' + v, onClick: () => run(C.setStyle(v)) }));
  }
}));
group().append(styleBtn);
sep();

const gMarks = group();
addBtn(gMarks, 'bold', 'bold', '太字', () => run(C.toggleBold), `${MOD}B`);
addBtn(gMarks, 'italic', 'italic', '斜体', () => run(C.toggleItalic), `${MOD}I`);
addBtn(gMarks, 'underline', 'underline', '下線', () => run(C.toggleUnderline), `${MOD}U`);
addBtn(gMarks, 'strike', 'strike', '取り消し線', () => run(C.toggleStrike), `${MOD}${SHIFT}X`);
const tcBtn = addBtn(gMarks, 'textColor', 'textColor', '文字の色', (b) => openPalette(b, 'text'));
tcBtn.classList.add('color-ic');
const hlBtn = addBtn(gMarks, 'highlight', 'highlight', '蛍光ペン', (b) => openPalette(b, 'highlight'));
hlBtn.classList.add('color-ic');
sep();

const gLink = group();
addBtn(gLink, 'link', 'link', 'リンク', () => openLinkDialog(), `${MOD}K`);
addBtn(gLink, 'image', 'image', '画像を挿入', () => $('#fileImage').click());
addBtn(gLink, 'table', 'table', '表を挿入', (b) => openTablePicker(b));
sep();

const gAlign = group();
addBtn(gAlign, 'align', 'alignLeft', '配置', (b) => openPop(b, (p) => {
  const cur = C.blockAlign(view.state);
  for (const [v, label, kbd] of [['left', '左揃え', 'L'], ['center', '中央揃え', 'E'], ['right', '右揃え', 'R'], ['justify', '両端揃え', 'J']]) {
    p.append(menuItem({ icon: ALIGN_ICON[v], label, kbd: `${MOD}${SHIFT}${kbd}`, checked: cur === v, onClick: () => run(C.setAlign(v)) }));
  }
}));
sep();

const gList = group();
addBtn(gList, 'bullet', 'bulletList', '箇条書き', () => run(C.toggleList('bullet_list')), `${MOD}${SHIFT}8`);
addBtn(gList, 'ordered', 'orderedList', '番号付きリスト', () => run(C.toggleList('ordered_list')), `${MOD}${SHIFT}7`);
addBtn(gList, 'checklist', 'checklist', 'チェックリスト', () => run(C.toggleList('checklist')), `${MOD}${SHIFT}9`);
addBtn(gList, 'outdent', 'outdent', 'インデントを減らす', () => run(C.outdent), `${SHIFT}Tab`);
addBtn(gList, 'indent', 'indent', 'インデントを増やす', () => run(C.indent), 'Tab');
sep();

const gBlock = group();
addBtn(gBlock, 'quote', 'quote', '引用', () => run(C.toggleQuote));
addBtn(gBlock, 'rule', 'rule', '区切り線', () => run(C.insertRule));
addBtn(gBlock, 'clear', 'clear', '書式をクリア', () => run(C.clearFormatting), `${MOD}\\`);

function setPressed(key, on) { if (buttons[key]) buttons[key].setAttribute('aria-pressed', String(!!on)); }

function updateToolbar() {
  const s = view.state;
  buttons.undo.disabled = undoDepth(s) === 0;
  buttons.redo.disabled = redoDepth(s) === 0;
  setPressed('bold', C.markActive(s, M.strong));
  setPressed('italic', C.markActive(s, M.em));
  setPressed('underline', C.markActive(s, M.underline));
  setPressed('strike', C.markActive(s, M.strike));
  setPressed('link', !!C.linkRange(s));
  const tc = C.markAttr(s, M.color, 'color');
  tcBtn.style.setProperty('--swatch', tc ? `var(--tc-${tc})` : 'var(--ink)');
  const hl = C.markAttr(s, M.highlight, 'color');
  hlBtn.style.setProperty('--swatch', hl ? `var(--hl-${hl})` : 'transparent');
  const st = C.blockStyle(s);
  const found = STYLES.find(([v]) => v === st);
  $('#styleLabel').textContent = found ? found[1] : '—';
  buttons.align.innerHTML = icon(ALIGN_ICON[C.blockAlign(s)] || 'alignLeft');
  const lt = C.listType(s);
  setPressed('bullet', lt === 'bullet_list');
  setPressed('ordered', lt === 'ordered_list');
  setPressed('checklist', lt === 'checklist');
  buttons.indent.disabled = !C.indent(s);
  buttons.outdent.disabled = !C.outdent(s);
  setPressed('quote', C.inside(s, N.blockquote));
  const inTable = C.isInTable(s);
  if (gTable.hidden === inTable) gTable.hidden = !inTable;
  if (inTable) {
    buttons.merge.disabled = !mergeCells(s);
    buttons.split.disabled = !splitCell(s);
  }
}

// ---------- palettes and pickers ----------

function openPalette(btn, kind) {
  openPop(btn, (p) => {
    const s = view.state;
    const cur = kind === 'text' ? C.markAttr(s, M.color, 'color') : kind === 'highlight' ? C.markAttr(s, M.highlight, 'color') : cellBackground(s);
    p.append(menuLabel(kind === 'text' ? '文字の色' : kind === 'highlight' ? '蛍光ペン' : 'セルの背景色'));
    const grid = document.createElement('div');
    grid.className = 'swatches';
    const apply = (color) => {
      closePop();
      if (kind === 'text') run(C.setColorMark(M.color, color));
      else if (kind === 'highlight') run(C.setColorMark(M.highlight, color));
      else run(setCellAttr('background', color));
    };
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'swatch none';
    none.textContent = 'なし';
    none.setAttribute('aria-checked', String(!cur));
    none.addEventListener('click', () => apply(null));
    grid.append(none);
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.title = COLOR_NAME[c];
      b.setAttribute('aria-label', COLOR_NAME[c]);
      b.setAttribute('aria-checked', String(cur === c));
      if (kind === 'text') { b.textContent = 'A'; b.style.color = `var(--tc-${c})`; }
      else b.style.background = `var(--${kind === 'highlight' ? 'hl' : 'bg'}-${c})`;
      b.addEventListener('click', () => apply(c));
      grid.append(b);
    }
    p.append(grid);
  }, { role: 'dialog' });
}

function cellBackground(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type === N.table_cell || n.type === N.table_header) return n.attrs.background;
  }
  return null;
}

function openTablePicker(btn) {
  openPop(btn, (p) => {
    const label = document.createElement('div');
    label.className = 'grid-label';
    label.textContent = '表の大きさを選ぶ';
    const grid = document.createElement('div');
    grid.className = 'grid-pick';
    const cells = [];
    const show = (r, c) => {
      for (const b of cells) b.classList.toggle('on', +b.dataset.r <= r && +b.dataset.c <= c);
      label.textContent = `${r} 行 × ${c} 列`;
    };
    for (let r = 1; r <= 8; r++) {
      for (let c = 1; c <= 8; c++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.r = r;
        b.dataset.c = c;
        b.setAttribute('aria-label', `${r} 行 × ${c} 列`);
        b.addEventListener('pointerenter', () => show(r, c));
        b.addEventListener('focus', () => show(r, c));
        b.addEventListener('click', () => { closePop(); run(C.insertTable(r, c)); });
        cells.push(b);
        grid.append(b);
      }
    }
    p.append(grid, label);
    show(3, 3);
  }, { role: 'dialog' });
}

// ---------- images ----------

$('#fileImage').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  const { imageFileToDataUrl } = await import('./util/image.js');
  for (const f of files) {
    try {
      const src = await imageFileToDataUrl(f);
      if (!run(C.insertImage(src, f.name.replace(/\.[^.]+$/, '')))) toast('ここには画像を挿入できません');
    } catch { toast('画像を読み込めませんでした（' + f.name + '）'); }
  }
});

// ---------- link / image bubble ----------

const bubble = $('#bubble');
let bubbleKey = '';
function hideBubble() { bubble.hidden = true; bubbleKey = ''; }
function updateBubble() {
  const s = view.state;
  const focused = view.hasFocus() || bubble.contains(document.activeElement);
  if (!focused) { hideBubble(); return; }
  const sel = s.selection;
  if (sel instanceof NodeSelection && sel.node.type === N.image) {
    const key = 'img:' + sel.from + ':' + sel.node.attrs.width;
    if (key !== bubbleKey) {
      bubbleKey = key;
      bubble.innerHTML = '';
      const w = sel.node.attrs.width;
      for (const [v, label] of [[25, '小'], [50, '中'], [75, '大'], [null, '全幅']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tbtn';
        b.textContent = label;
        b.setAttribute('aria-pressed', String(w === v));
        b.addEventListener('click', () => {
          const cur = view.state.selection;
          if (!(cur instanceof NodeSelection)) return;
          const tr = view.state.tr.setNodeMarkup(cur.from, null, { ...cur.node.attrs, width: v });
          tr.setSelection(NodeSelection.create(tr.doc, cur.from));
          view.dispatch(tr);
          view.focus();
        });
        bubble.append(b);
      }
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon sm';
      del.title = '画像を削除';
      del.setAttribute('aria-label', '画像を削除');
      del.innerHTML = icon('trash');
      del.addEventListener('click', () => { view.dispatch(view.state.tr.deleteSelection()); view.focus(); });
      bubble.append(del);
    }
    const dom = view.nodeDOM(sel.from);
    if (dom) positionBubble(dom.getBoundingClientRect());
    return;
  }
  const r = sel.empty ? C.linkRange(s) : null;
  if (r) {
    const key = 'link:' + r.from + ':' + r.href;
    if (key !== bubbleKey) {
      bubbleKey = key;
      bubble.innerHTML = '';
      const a = document.createElement('a');
      a.href = safeHref(r.href);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = r.href.replace(/^https?:\/\//, '');
      a.title = r.href;
      a.insertAdjacentHTML('beforeend', icon('external'));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'icon sm';
      edit.title = 'リンクを編集';
      edit.setAttribute('aria-label', 'リンクを編集');
      edit.innerHTML = icon('edit');
      edit.addEventListener('click', () => openLinkDialog());
      const un = document.createElement('button');
      un.type = 'button';
      un.className = 'icon sm';
      un.title = 'リンクを解除';
      un.setAttribute('aria-label', 'リンクを解除');
      un.innerHTML = icon('unlink');
      un.addEventListener('click', () => run(C.removeLink));
      bubble.append(a, edit, un);
    }
    const start = view.coordsAtPos(r.from);
    const end = view.coordsAtPos(r.to);
    positionBubble({ left: start.left, right: end.right, top: start.top, bottom: Math.max(start.bottom, end.bottom) });
    return;
  }
  hideBubble();
}
function positionBubble(rect) {
  bubble.hidden = false;
  const w = bubble.offsetWidth, h = bubble.offsetHeight;
  const area = $('#scroller').getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + h > area.bottom - 4) top = rect.top - h - 6;
  if (top < area.top || rect.bottom < area.top || rect.top > area.bottom) { bubble.hidden = true; return; }
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
}
$('#scroller').addEventListener('scroll', () => { bubbleKey = bubbleKey ? bubbleKey + ' ' : ''; if (!bubble.hidden) updateBubble(); }, { passive: true });

// ---------- link dialog ----------

const linkDlg = $('#linkDialog');
function openLinkDialog() {
  closePop();
  const s = view.state;
  const r = C.linkRange(s);
  const { from, to, empty } = s.selection;
  const text = r && empty ? s.doc.textBetween(r.from, r.to) : s.doc.textBetween(from, to, ' ');
  $('#linkText').value = text;
  $('#linkUrl').value = r ? r.href : '';
  $('#linkRemove').hidden = !r;
  $('#linkError').hidden = true;
  // the text field only makes sense inside one paragraph
  $('#linkText').closest('label').hidden = !s.selection.$from.sameParent(s.selection.$to) || s.selection instanceof NodeSelection;
  linkDlg.showModal();
  (text ? $('#linkUrl') : $('#linkText')).focus();
}
$('#linkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#linkUrl').value.trim();
  if (!safeHref(url)) { $('#linkError').hidden = false; $('#linkUrl').focus(); return; }
  const textHidden = $('#linkText').closest('label').hidden;
  linkDlg.close();
  const t = $('#linkText').value;
  view.focus();
  run(C.setLink(url, textHidden ? null : t));
});
$('#linkCancel').addEventListener('click', () => { linkDlg.close(); view.focus(); });
$('#linkRemove').addEventListener('click', () => { linkDlg.close(); view.focus(); run(C.removeLink); });

// ---------- counting ----------

function countText(text) {
  const noSpace = Array.from(text.replace(/\s/g, '')).length;
  const all = Array.from(text.replace(/\n/g, '')).length;
  const words = (text.match(/[A-Za-z0-9À-ɏ'’-]+|[^\sA-Za-z0-9À-ɏ'’\-、。，．,.!?！？「」『』（）()…・：:；;]/g) || []).length;
  return { noSpace, all, words };
}
function docText(doc, from = 0, to = doc.content.size) { return doc.textBetween(from, to, '\n', '\n'); }

function updateCount() {
  const pill = $('#countPill');
  if (!settings.showCount) { pill.textContent = ''; return; }
  const s = view.state;
  const total = countText(docText(s.doc)).noSpace;
  const { from, to, empty } = s.selection;
  if (!empty && !(s.selection instanceof NodeSelection)) {
    pill.textContent = `選択 ${fmt(countText(docText(s.doc, from, to)).noSpace)} / ${fmt(total)} 字`;
  } else pill.textContent = `${fmt(total)} 字`;
}

function openCounts() {
  const s = view.state;
  const t = countText(docText(s.doc));
  let paras = 0;
  s.doc.descendants((n) => { if (n.isTextblock && n.content.size) paras++; return !n.isTextblock; });
  const rows = [['文字数（空白を除く）', t.noSpace], ['文字数（空白を含む）', t.all], ['単語数', t.words], ['段落数', paras], ['原稿用紙換算（400字）', Math.ceil(t.noSpace / 400) + ' 枚']];
  const { from, to, empty } = s.selection;
  let html = rows.map(([k, v]) => `<tr><th>${k}</th><td>${typeof v === 'number' ? fmt(v) : v}</td></tr>`).join('');
  if (!empty && !(s.selection instanceof NodeSelection)) {
    const st = countText(docText(s.doc, from, to));
    html = `<tr><th>選択範囲（空白を除く）</th><td>${fmt(st.noSpace)}</td></tr><tr class="sub"><th>選択範囲（空白を含む）</th><td>${fmt(st.all)}</td></tr>` + html;
  }
  $('#countTable').innerHTML = html;
  $('#countDialog').showModal();
}
$('#countPill').addEventListener('click', openCounts);

// ---------- find & replace ----------

const findbar = $('#findbar');
const findInput = $('#findInput');
const replaceInput = $('#replaceInput');
let findOpts = { caseSensitive: false, regexp: false };

function currentQuery() {
  return new SearchQuery({ search: findInput.value, replace: replaceInput.value, caseSensitive: findOpts.caseSensitive, regexp: findOpts.regexp });
}
function pushQuery() {
  const q = currentQuery();
  findInput.classList.toggle('bad', !!findInput.value && !q.valid);
  view.dispatch(setSearchState(view.state.tr, q));
}
function openFind(replace) {
  closePop();
  const s = view.state;
  const { from, to, empty } = s.selection;
  if (!empty && s.selection.$from.sameParent(s.selection.$to)) {
    const t = s.doc.textBetween(from, to);
    if (t.length <= 100) findInput.value = t;
  }
  findbar.hidden = false;
  const r = !!replace || !$('#replaceRow').hidden;
  $('#replaceRow').hidden = !r;
  $('#findToggleReplace').setAttribute('aria-pressed', String(r));
  pushQuery();
  findInput.focus();
  findInput.select();
}
function closeFind(focusEditor = true) {
  if (findbar.hidden) return false;
  findbar.hidden = true;
  view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: '' })));
  if (focusEditor) view.focus();
  return true;
}
function matches() { return getMatchHighlights(view.state).find(); }
function updateFindCount() {
  if (findbar.hidden) return;
  const q = getSearchState(view.state);
  if (!q || !q.query.valid) { $('#findCount').textContent = findInput.value ? (findOpts.regexp ? '式が不正' : '') : ''; return; }
  const list = matches();
  const { from, to } = view.state.selection;
  const i = list.findIndex((d) => d.from === from && d.to === to);
  $('#findCount').textContent = list.length ? (i >= 0 ? `${i + 1} / ${list.length}` : `${list.length} 件`) : 'なし';
}
function step(back) {
  const cmd = back ? findPrev : findNext;
  cmd(view.state, (tr) => view.dispatch(tr.scrollIntoView()));
}
findInput.addEventListener('input', pushQuery);
replaceInput.addEventListener('input', pushQuery);
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); step(e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doReplace(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('#findNext').addEventListener('click', () => step(false));
$('#findPrev').addEventListener('click', () => step(true));
$('#findClose').addEventListener('click', () => closeFind());
$('#findCase').addEventListener('click', (e) => { findOpts.caseSensitive = !findOpts.caseSensitive; e.currentTarget.setAttribute('aria-pressed', String(findOpts.caseSensitive)); pushQuery(); });
$('#findRegex').addEventListener('click', (e) => { findOpts.regexp = !findOpts.regexp; e.currentTarget.setAttribute('aria-pressed', String(findOpts.regexp)); pushQuery(); });
$('#findToggleReplace').addEventListener('click', (e) => {
  const on = $('#replaceRow').hidden;
  $('#replaceRow').hidden = !on;
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on) replaceInput.focus();
});
function doReplace() {
  const n = matches().length;
  if (!n) return;
  replaceNext(view.state, (tr) => view.dispatch(tr.scrollIntoView()));
}
$('#replaceOne').addEventListener('click', doReplace);
$('#replaceAll').addEventListener('click', () => {
  const n = matches().length;
  if (!n) { toast('見つかりません'); return; }
  replaceAllCmd(view.state, view.dispatch);
  toast(`${fmt(n)} 件を置換しました`);
});
$('#btnFind').addEventListener('click', () => (findbar.hidden ? openFind(false) : closeFind()));

// ---------- documents ----------

const UNTITLED = '無題の文書';
let current = null; // { id, title, createdAt, settings, persisted }
let dirty = false, saving = false, saveAgain = false, saveTimer = null, lastError = '';

function setSaveState(kind, text) {
  const el = $('#saveState');
  el.className = 'save' + (kind === 'ok' ? '' : ' ' + kind);
  $('#saveText').textContent = text;
  el.title = kind === 'warn' ? text : store.storeInfo.persistent ? 'このブラウザに自動保存しています' : 'このブラウザでは保存できません。書き出して保管してください';
}

function derivedTitle(doc) {
  let t = '';
  doc.descendants((n) => { if (t) return false; if (n.isTextblock && n.textContent.trim()) { t = n.textContent.trim(); return false; } return true; });
  return t.slice(0, 60);
}
function displayTitle(meta) { return meta.title || meta.preview || UNTITLED; }

function record() {
  const doc = view.state.doc;
  const text = docText(doc);
  return {
    id: current.id,
    title: current.title,
    preview: derivedTitle(doc),
    chars: countText(text).noSpace,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
    content: doc.toJSON(),
    settings: current.settings,
  };
}

function markDirty() {
  if (!current) return;
  dirty = true;
  setSaveState('busy', '保存中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 700);
}

async function saveNow(manual) {
  clearTimeout(saveTimer);
  if (!current) return;
  if (!dirty) { if (manual) toast(store.storeInfo.persistent ? '保存済みです' : 'このブラウザでは保存できません。書き出して保管してください'); return; }
  if (saving) { saveAgain = true; return; }
  saving = true;
  dirty = false;
  const rec = record();
  try {
    await store.putDoc(rec);
    current.persisted = true;
    current.updatedAt = rec.updatedAt;
    lastError = '';
    store.announce({ type: 'saved', id: rec.id, updatedAt: rec.updatedAt });
    if (!dirty) setSaveState(store.storeInfo.persistent ? 'ok' : 'warn', store.storeInfo.persistent ? '保存済み' : '一時保存のみ');
    if (manual) toast('保存しました');
  } catch (err) {
    dirty = true;
    const quota = err && /quota/i.test(err.name + err.message);
    lastError = quota ? '保存できません：ブラウザの保存容量がいっぱいです。大きな画像を減らすか、不要な文書を削除してください' : '保存できませんでした。しばらくして自動でやり直します';
    setSaveState('warn', '保存エラー');
    toast(lastError, 6000);
    saveTimer = setTimeout(() => saveNow(), 5000);
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; saveNow(); }
    refreshDocsSoon();
  }
}

function docFromJSON(json) {
  try {
    const d = PMNode.fromJSON(schema, json);
    d.check();
    return d;
  } catch {
    return null;
  }
}

function setDocument(rec, { focus = false, keepSelection = false } = {}) {
  const doc = rec.content ? docFromJSON(rec.content) : rec.doc;
  if (!doc) { toast('この文書を読み込めませんでした'); return false; }
  const prevSel = view.state.selection;
  let state = makeState(doc);
  if (keepSelection) {
    const max = doc.content.size;
    try { state = state.apply(state.tr.setSelection(TextSelection.create(doc, Math.min(prevSel.from, max), Math.min(prevSel.to, max)))); } catch { /* start of the document */ }
  }
  view.updateState(state);
  current = { id: rec.id, title: rec.title || '', createdAt: rec.createdAt || Date.now(), updatedAt: rec.updatedAt || 0, settings: rec.settings || { writingMode: 'horizontal-tb' }, persisted: !!rec.persisted };
  dirty = false;
  $('#docTitle').value = current.title;
  document.title = (current.title || derivedTitle(doc) || UNTITLED) + ' - editer';
  document.documentElement.dataset.writing = current.settings.writingMode || 'horizontal-tb';
  setSaveState(store.storeInfo.persistent ? 'ok' : 'warn', store.storeInfo.persistent ? '保存済み' : '一時保存のみ');
  if (!findbar.hidden) pushQuery();
  if (!keepSelection) $('#scroller').scrollTop = 0;
  if (focus) view.focus();
  renderOutline();
  scheduleUi();
  return true;
}

function setHash(id) {
  const h = '#/d/' + id;
  if (location.hash !== h) history.replaceState(null, '', h);
  store.writePref('last', id);
}

// A new document is written once something is typed or titled; an untouched one is just dropped.
function isUntouched() {
  return current && !current.title && !dirty && view.state.doc.childCount === 1 && view.state.doc.firstChild.isTextblock && view.state.doc.firstChild.content.size === 0;
}
async function leaveCurrent() {
  if (!current) return;
  if (dirty) await saveNow();
  if (current.persisted && isUntouched()) {
    await store.deleteDoc(current.id).catch(() => {});
    store.announce({ type: 'deleted', id: current.id });
  }
}

async function openDoc(id, { focus = false } = {}) {
  if (current && current.id === id) return true;
  const rec = await store.getDoc(id);
  if (!rec) return false;
  await leaveCurrent();
  rec.persisted = true;
  setDocument(rec, { focus });
  setHash(id);
  refreshDocsSoon();
  return true;
}

async function newDoc({ doc = null, title = '', focus = true } = {}) {
  await leaveCurrent();
  const now = Date.now();
  const rec = { id: store.newId(), title, createdAt: now, updatedAt: now, doc: doc || emptyDoc(), settings: { writingMode: 'horizontal-tb' }, persisted: false };
  setDocument(rec, { focus });
  setHash(rec.id);
  if (doc || title) { dirty = true; await saveNow(); }
  refreshDocsSoon();
  return rec.id;
}

async function duplicateDoc(id) {
  const rec = await store.getDoc(id);
  if (!rec) return;
  const doc = docFromJSON(rec.content);
  if (!doc) return;
  await newDoc({ doc, title: (displayTitle(rec)) + ' のコピー', focus: false });
  toast('コピーを作りました');
}

async function removeDoc(id) {
  const list = await store.listDocs();
  const meta = list.find((m) => m.id === id) || (current && current.id === id ? { title: current.title, preview: derivedTitle(view.state.doc) } : null);
  const name = meta ? displayTitle(meta) : UNTITLED;
  if (!(await confirmBox('文書を削除', `「${name}」を削除します。元に戻せません。`, '削除'))) return;
  await store.deleteDoc(id).catch(() => {});
  store.announce({ type: 'deleted', id });
  if (current && current.id === id) {
    current = null;
    dirty = false;
    const rest = list.filter((m) => m.id !== id);
    if (rest.length) await openDoc(rest[0].id);
    else await newDoc({ focus: false });
  }
  refreshDocsSoon();
  toast('削除しました');
}

$('#docTitle').addEventListener('input', (e) => {
  if (!current) return;
  current.title = e.target.value.trim();
  document.title = (current.title || derivedTitle(view.state.doc) || UNTITLED) + ' - editer';
  markDirty();
});
$('#docTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); view.focus(); }
});

// ---------- drawer: documents and outline ----------

const drawer = $('#drawer');
const scrim = $('#scrim');
function openDrawer(tab) {
  closePop();
  drawer.hidden = false;
  scrim.hidden = false;
  $('#btnDrawer').setAttribute('aria-expanded', 'true');
  showTab(tab || store.readPref('drawerTab', 'docs'));
  refreshDocs();
}
function closeDrawer() {
  if (drawer.hidden) return false;
  drawer.hidden = true;
  scrim.hidden = true;
  $('#btnDrawer').setAttribute('aria-expanded', 'false');
  return true;
}
function showTab(tab) {
  const docs = tab !== 'outline';
  $('#tabDocs').setAttribute('aria-selected', String(docs));
  $('#tabOutline').setAttribute('aria-selected', String(!docs));
  $('#paneDocs').hidden = !docs;
  $('#paneOutline').hidden = docs;
  store.writePref('drawerTab', docs ? 'docs' : 'outline');
  if (!docs) renderOutline();
}
$('#btnDrawer').addEventListener('click', () => (drawer.hidden ? openDrawer() : closeDrawer()));
$('#drawerClose').addEventListener('click', closeDrawer);
scrim.addEventListener('click', closeDrawer);
$('#tabDocs').addEventListener('click', () => showTab('docs'));
$('#tabOutline').addEventListener('click', () => showTab('outline'));
$('#btnNewDoc').addEventListener('click', async () => { closeDrawer(); await newDoc({ focus: !touch.matches }); });
$('#docsFilter').addEventListener('input', () => refreshDocs());

// swipe the drawer closed
{
  let x0 = null, y0 = 0;
  drawer.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
  drawer.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    if (x0 - t.clientX > 60 && Math.abs(t.clientY - y0) < 50) closeDrawer();
    x0 = null;
  }, { passive: true });
}

const timeFmt = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
function when(t) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return d.getFullYear() === now.getFullYear() ? timeFmt.format(d) : dayFmt.format(d);
}

let refreshQueued = false;
function refreshDocsSoon() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; refreshDocs(); }, 150);
}
async function refreshDocs() {
  if (drawer.hidden) return;
  const list = await store.listDocs();
  if (current && !list.some((m) => m.id === current.id)) {
    list.unshift({ id: current.id, title: current.title, preview: derivedTitle(view.state.doc), updatedAt: Date.now(), chars: 0, unsaved: true });
  }
  const q = $('#docsFilter').value.trim().toLowerCase();
  const ul = $('#docsList');
  ul.innerHTML = '';
  for (const m of list) {
    const name = displayTitle(m);
    if (q && !name.toLowerCase().includes(q) && !(m.preview || '').toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.className = 'doc-item' + (current && m.id === current.id ? ' current' : '');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'doc-open';
    const nm = document.createElement('span');
    nm.className = 'doc-name' + (m.title ? '' : ' untitled');
    nm.textContent = name;
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = m.unsaved ? '新しい文書' : `${when(m.updatedAt)} ・ ${fmt(m.chars || 0)} 字`;
    open.append(nm, meta);
    open.addEventListener('click', async () => {
      closeDrawer();
      if (!(current && current.id === m.id)) await openDoc(m.id, { focus: !touch.matches });
    });
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'icon sm';
    more.setAttribute('aria-label', name + ' の操作');
    more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = icon('more');
    more.addEventListener('click', () => openPop(more, (p) => {
      p.append(menuItem({ icon: 'copy', label: 'コピーを作成', onClick: () => duplicateDoc(m.id) }));
      p.append(menuItem({ icon: 'trash', label: '削除', danger: true, onClick: () => removeDoc(m.id) }));
    }, { align: 'end' }));
    li.append(open, more);
    ul.append(li);
  }
  if (!ul.children.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.style.padding = '8px 10px';
    li.textContent = q ? '見つかりません' : '文書はまだありません';
    ul.append(li);
  }
}

let outlineItems = [];
function renderOutline() {
  if (drawer.hidden || $('#paneOutline').hidden) return;
  const ul = $('#outlineList');
  ul.innerHTML = '';
  outlineItems = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type === N.heading) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'outline-item l' + node.attrs.level;
      b.textContent = node.textContent || '（空の見出し）';
      b.addEventListener('click', () => goToPos(pos));
      li.append(b);
      ul.append(li);
      outlineItems.push({ pos, el: b });
      return false;
    }
    return node.type !== N.table && !node.isTextblock;
  });
  $('#outlineEmpty').hidden = outlineItems.length > 0;
  updateOutlineCurrent();
}
function updateOutlineCurrent() {
  if (!outlineItems.length || drawer.hidden) return;
  const at = view.state.selection.from;
  let cur = null;
  for (const it of outlineItems) if (it.pos <= at) cur = it;
  for (const it of outlineItems) it.el.classList.toggle('current', it === cur);
}
function goToPos(pos) {
  closeDrawer();
  const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1)));
  view.dispatch(tr);
  const dom = view.nodeDOM(pos);
  if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: 'start' });
  const sc = $('#scroller');
  sc.scrollTop = Math.max(0, sc.scrollTop - 16);
  if (!touch.matches) view.focus();
}

// ---------- ⋯ menu ----------

$('#btnMore').addEventListener('click', (e) => openPop(e.currentTarget, (p) => {
  p.append(menuItem({ icon: 'plus', label: '新しい文書', onClick: () => newDoc({ focus: !touch.matches }) }));
  p.append(menuItem({ icon: 'upload', label: 'ファイルを開く（.md / .txt / .html）', onClick: () => $('#fileImport').click() }));
  p.append(menuSep());
  p.append(menuLabel('書き出し'));
  p.append(menuItem({ icon: 'download', label: 'Markdown（.md）', onClick: () => exportAs('md') }));
  p.append(menuItem({ icon: 'download', label: 'Web ページ（.html）', onClick: () => exportAs('html') }));
  p.append(menuItem({ icon: 'download', label: 'テキスト（.txt）', onClick: () => exportAs('txt') }));
  p.append(menuItem({ icon: 'doc', label: '印刷・PDF', kbd: `${MOD}P`, onClick: () => window.print() }));
  p.append(menuSep());
  p.append(menuItem({ icon: 'count', label: '文字数', kbd: `${MOD}${SHIFT}C`, onClick: openCounts }));
  p.append(menuItem({ icon: 'settings', label: '表示設定', onClick: () => $('#settingsDialog').showModal() }));
  if (document.fullscreenEnabled) {
    p.append(menuItem({ icon: 'external', label: document.fullscreenElement ? '全画面表示を終了' : '全画面表示', onClick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}) }));
  }
  p.append(menuSep());
  p.append(menuItem({ icon: 'trash', label: 'この文書を削除', danger: true, onClick: () => current && removeDoc(current.id) }));
}, { align: 'end' }));

function fileBase() {
  const t = (current && (current.title || derivedTitle(view.state.doc))) || UNTITLED;
  return t.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 60) || UNTITLED;
}

async function exportAs(kind) {
  const doc = view.state.doc;
  const title = (current && current.title) || derivedTitle(doc) || UNTITLED;
  let text, mime;
  if (kind === 'md') { text = (current && current.title ? `# ${current.title}\n\n` : '') + toMarkdown(doc); mime = 'text/markdown'; }
  else if (kind === 'html') { text = toHtml(doc, title); mime = 'text/html'; }
  else { text = toText(doc); mime = 'text/plain'; }
  await saveFile(`${fileBase()}.${kind}`, text, mime);
}

async function saveFile(filename, text, mime) {
  const c = window.claude;
  const dl = c && typeof c.use === 'function' ? await c.use('downloads').catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename, data: text }); toast('書き出しました'); }
    catch (e) { if (!e || e.code !== 'declined') toast('書き出せませんでした' + (e && e.message ? '：' + e.message : '')); }
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('#fileImport').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = decodeTextFile(await file.arrayBuffer());
    const name = file.name.replace(/\.[^.]+$/, '');
    let doc;
    let title = name;
    if (/\.(html?)$/i.test(file.name)) doc = fromHtml(text);
    else if (/\.(md|markdown)$/i.test(file.name)) {
      // a leading "# Title" becomes the document title
      const m = /^# (.+)\n+/.exec(text);
      if (m) { title = m[1].trim(); doc = fromMarkdown(text.slice(m[0].length)); }
      else doc = fromMarkdown(text);
    } else doc = fromText(text);
    if (!doc.childCount) doc = emptyDoc();
    await newDoc({ doc, title, focus: false });
    toast(`「${title}」を開きました`);
  } catch {
    toast('このファイルは開けませんでした');
  }
});

// ---------- confirm ----------

function confirmBox(title, text, okLabel) {
  const d = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

// ---------- closing things ----------

function closeTransient() {
  return closePop() || closeFind() || closeDrawer();
}
document.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
    if (closePop() || closeDrawer()) e.preventDefault();
    return;
  }
  if (view.hasFocus()) return; // the editor's own keymap handles these
  if (mod && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(false); }
  else if (mod && !e.altKey && e.key.toLowerCase() === 'h') { e.preventDefault(); openFind(true); }
  else if (mod && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(true); }
});
// dialogs return focus to the text
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // tap outside closes
}

// ---------- phones: keep the page above the keyboard ----------

const vv = window.visualViewport;
function fitViewport() {
  if (!vv) return;
  const r = document.documentElement.style;
  r.setProperty('--app-h', vv.height + 'px');
  r.setProperty('--app-top', vv.offsetTop + 'px');
  if (view.hasFocus()) requestAnimationFrame(() => view.dispatch(view.state.tr.scrollIntoView()));
}
if (vv && touch.matches) {
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
  window.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });
}

// ---------- other tabs ----------

store.onAnnounce(async (msg) => {
  refreshDocsSoon();
  if (!current || msg.id !== current.id) return;
  if (msg.type === 'saved' && !dirty && !saving) {
    const rec = await store.getDoc(current.id);
    if (rec && rec.updatedAt > (current.updatedAt || 0)) {
      rec.persisted = true;
      setDocument(rec, { keepSelection: true, focus: view.hasFocus() });
    }
  } else if (msg.type === 'saved' && dirty) {
    toast('別のタブでもこの文書が編集されました。このタブの内容で上書きされます', 5000);
  } else if (msg.type === 'deleted') {
    current.persisted = false;
    toast('この文書は別のタブで削除されました。書き続けると新しく保存されます', 5000);
  }
});

// ---------- saving on the way out ----------

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) saveNow(); });
window.addEventListener('pagehide', () => { if (dirty) saveNow(); });
window.addEventListener('beforeunload', (e) => { if (dirty) { saveNow(); e.preventDefault(); } });

window.addEventListener('hashchange', () => {
  const m = /^#\/d\/([\w-]+)$/.exec(location.hash);
  if (m && (!current || current.id !== m[1])) openDoc(m[1]).then((ok) => { if (!ok) toast('この文書は見つかりません'); });
});

// ---------- the previous app's manuscript ----------

async function migrateGenkocho() {
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
  const rec = { id: store.newId(), title: title || '原稿帳の原稿', preview: derivedTitle(doc), chars: countText(docText(doc)).noSpace, createdAt: now, updatedAt: now, content: doc.toJSON(), settings: { writingMode: 'horizontal-tb' } };
  await store.putDoc(rec);
  return rec;
}

// ---------- start ----------

applySettings();
(async () => {
  await store.ready();
  if (!store.storeInfo.persistent) toast('このブラウザでは文書を保存できません（プライベートブラウズなど）。書き出して保管してください', 7000);
  let migrated = null;
  try { migrated = await migrateGenkocho(); } catch { migrated = null; }
  const hash = /^#\/d\/([\w-]+)$/.exec(location.hash);
  const list = await store.listDocs();
  let opened = false;
  if (hash) opened = await openDoc(hash[1]);
  if (!opened && migrated) opened = await openDoc(migrated.id);
  if (!opened) { const last = store.readPref('last', null); if (last && list.some((m) => m.id === last)) opened = await openDoc(last); }
  if (!opened && list.length) opened = await openDoc(list[0].id);
  if (!opened) await newDoc({ focus: !touch.matches });
  if (migrated) toast(`以前の原稿帳の原稿を「${migrated.title}」として取り込みました`, 6000);
  if (!touch.matches) view.focus();
  scheduleUi();
})();

// for tests and debugging
window.editer = { view, schema, store, toMarkdown, fromMarkdown, openDoc, newDoc };
