// The formatting toolbar, laid out like Docs'. On phones it scrolls sideways; table tools appear
// first while the cursor is in a table.
import { undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import {
  addRowBefore, addRowAfter, addColumnBefore, addColumnAfter, deleteRow, deleteColumn,
  mergeCells, splitCell, toggleHeaderRow, deleteTable, setCellAttr,
} from 'prosemirror-tables';
import { ctx, run, on, $, MOD, ALT, SHIFT, isMac, el } from '../app/ctx.js';
import { icon } from './icons.js';
import { openPop, closePop, menuItem, menuSep, menuLabel, keepFocus } from './pop.js';
import { paint, startPaint, stopPaint, copyFormat, pasteFormat } from './paint.js';
import * as C from '../editor/commands.js';
import { schema, COLORS, FONT_SIZES, BULLET_STYLES, NUMBER_STYLES } from '../editor/schema.js';

const N = schema.nodes;
const M = schema.marks;

export const STYLES = [
  ['paragraph', '標準テキスト', `${MOD}${ALT}0`],
  ['h1', '見出し 1', `${MOD}${ALT}1`],
  ['h2', '見出し 2', `${MOD}${ALT}2`],
  ['h3', '見出し 3', `${MOD}${ALT}3`],
  ['h4', '見出し 4', `${MOD}${ALT}4`],
  ['code', 'コード', ''],
];
const FONT_NAMES = { sans: 'ゴシック', serif: '明朝', mono: '等幅' };
const ALIGN_ICON = { left: 'alignLeft', center: 'alignCenter', right: 'alignRight', justify: 'alignJustify' };
export const COLOR_NAME = { gray: 'グレー', red: '赤', orange: 'オレンジ', yellow: '黄', green: '緑', blue: '青', purple: '紫' };
const BULLET_NAME = { disc: '● 黒丸', circle: '○ 白丸', square: '■ 四角', dash: '– ダッシュ' };
const NUMBER_NAME = { decimal: '1. 2. 3.', 'lower-alpha': 'a. b. c.', 'upper-alpha': 'A. B. C.', 'lower-roman': 'i. ii. iii.', 'upper-roman': 'I. II. III.', 'cjk-ideographic': '一、二、三、' };

const buttons = {};
let actions = {};
let tb, gTable, styleLabel, fontLabel, sizeLabel, tcBtn, hlBtn;

function btn(parent, key, ic, label, onClick, kbd, cls = '') {
  const b = el('button', { type: 'button', class: 'icon' + (cls ? ' ' + cls : ''), html: icon(ic), 'aria-label': label, title: kbd ? `${label}（${kbd}）` : label });
  b.addEventListener('click', () => onClick(b));
  parent.append(b);
  if (key) buttons[key] = b;
  return b;
}
function group(cls = '') {
  const g = el('div', { class: 'tb-group' + (cls ? ' ' + cls : '') });
  tb.append(g);
  return g;
}
function sep(parent = tb) { parent.append(el('span', { class: 'sep' })); }
function dropdown(parent, key, labelHtml, title, onClick, cls = '') {
  const b = el('button', { type: 'button', class: 'drop-btn' + (cls ? ' ' + cls : ''), title, 'aria-haspopup': 'menu', html: labelHtml + icon('chevron') });
  b.addEventListener('click', () => onClick(b));
  parent.append(b);
  if (key) buttons[key] = b;
  return b;
}

export function initToolbar(a) {
  actions = a;
  tb = $('#toolbar');
  keepFocus(tb);
  keepFocus($('#pop'));

  // ----- table tools (only while in a table) -----
  gTable = group('table-tools');
  gTable.hidden = true;
  gTable.append(el('span', { class: 'tb-label', text: '表' }));
  btn(gTable, 'rowAbove', 'rowAbove', '上に行を挿入', () => run(addRowBefore));
  btn(gTable, 'rowBelow', 'rowBelow', '下に行を挿入', () => run(addRowAfter));
  btn(gTable, 'colLeft', 'colLeft', '左に列を挿入', () => run(addColumnBefore));
  btn(gTable, 'colRight', 'colRight', '右に列を挿入', () => run(addColumnAfter));
  btn(gTable, 'rowDel', 'rowDelete', '行を削除', () => run(deleteRow));
  btn(gTable, 'colDel', 'colDelete', '列を削除', () => run(deleteColumn));
  btn(gTable, 'merge', 'merge', 'セルを結合', () => run(mergeCells));
  btn(gTable, 'split', 'split', 'セルの結合を解除', () => run(splitCell));
  btn(gTable, 'headerRow', 'headerRow', '見出し行の切り替え', () => run(toggleHeaderRow));
  btn(gTable, 'cellColor', 'cellColor', 'セルの背景色', (b) => openPalette(b, 'cell'));
  btn(gTable, 'distribute', 'distribute', '列の幅を揃える', () => run(C.distributeColumns));
  btn(gTable, 'tableDel', 'tableDelete', '表を削除', () => run(deleteTable));
  sep(gTable);

  // ----- history and paint format -----
  const gHist = group();
  btn(gHist, 'undo', 'undo', '元に戻す', () => run(undo), `${MOD}Z`);
  btn(gHist, 'redo', 'redo', 'やり直す', () => run(redo), isMac ? '⇧⌘Z' : 'Ctrl+Y');
  const pb = btn(gHist, 'paint', 'paint', '書式のコピー／貼り付け（ダブルクリックで続けて貼り付け）', () => {});
  let clickTimer = null;
  pb.addEventListener('click', () => {
    if (paint.fmt && !paint.sticky) { stopPaint(); return; }
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { if (!paint.fmt) startPaint(false); }, 220);
  });
  pb.addEventListener('dblclick', () => { clearTimeout(clickTimer); startPaint(true); });
  sep();

  // ----- paragraph style, font, size -----
  const gText = group();
  const sb = dropdown(gText, 'style', '<span class="lbl"></span>', '段落スタイル', (b) => openPop(b, (p) => {
    const cur = C.blockStyle(ctx.view.state);
    for (const [v, label, kbd] of STYLES) p.append(menuItem({ label, kbd, checked: cur === v, cls: 'style-item ' + v, onClick: () => run(C.setStyle(v)) }));
  }), 'style-btn');
  styleLabel = sb.querySelector('.lbl');
  const fb = dropdown(gText, 'font', '<span class="lbl"></span>', 'フォント', (b) => openPop(b, (p) => {
    const cur = C.markAttr(ctx.view.state, M.fontFamily, 'family');
    p.append(menuItem({ label: '標準（設定に従う）', checked: cur === null, onClick: () => run(C.setFontFamily(null)) }));
    for (const f of ['sans', 'serif', 'mono']) p.append(menuItem({ label: FONT_NAMES[f], checked: cur === f, cls: 'ff-' + f, onClick: () => run(C.setFontFamily(f)) }));
  }), 'font-btn');
  fontLabel = fb.querySelector('.lbl');
  sep(gText);
  btn(gText, 'sizeDown', 'minus', 'フォントサイズを小さく', () => run(C.stepFontSize(-1)), `${MOD}${SHIFT},`, 'narrow');
  const zb = el('button', { type: 'button', class: 'size-btn', title: 'フォントサイズ', 'aria-haspopup': 'menu', html: '<span class="lbl">11</span>' });
  zb.addEventListener('click', () => openPop(zb, (p) => {
    const cur = C.fontSizeAt(ctx.view.state);
    for (const s of FONT_SIZES) p.append(menuItem({ label: String(s), checked: cur === s, onClick: () => run(C.setFontSize(s)) }));
  }));
  gText.append(zb);
  buttons.size = zb;
  sizeLabel = zb.querySelector('.lbl');
  btn(gText, 'sizeUp', 'plus', 'フォントサイズを大きく', () => run(C.stepFontSize(1)), `${MOD}${SHIFT}.`, 'narrow');
  sep();

  // ----- character formatting -----
  const gMarks = group();
  btn(gMarks, 'bold', 'bold', '太字', () => run(C.toggleBold), `${MOD}B`);
  btn(gMarks, 'italic', 'italic', '斜体', () => run(C.toggleItalic), `${MOD}I`);
  btn(gMarks, 'underline', 'underline', '下線', () => run(C.toggleUnderline), `${MOD}U`);
  btn(gMarks, 'strike', 'strike', '取り消し線', () => run(C.toggleStrike), `${MOD}${SHIFT}X`);
  tcBtn = btn(gMarks, 'textColor', 'textColor', '文字の色', (b) => openPalette(b, 'text'), '', 'color-ic');
  hlBtn = btn(gMarks, 'highlight', 'highlight', '蛍光ペン', (b) => openPalette(b, 'highlight'), '', 'color-ic');
  sep();

  // ----- insert -----
  const gIns = group();
  btn(gIns, 'link', 'link', 'リンク', () => actions.openLink(), `${MOD}K`);
  btn(gIns, 'image', 'image', '画像を挿入', (b) => openPop(b, (p) => {
    p.append(menuItem({ icon: 'upload', label: 'パソコン・端末から', onClick: () => actions.pickImage() }));
    p.append(menuItem({ icon: 'link', label: 'URL を指定', onClick: () => actions.imageFromUrl() }));
  }));
  btn(gIns, 'table', 'table', '表を挿入', (b) => openTablePicker(b));
  sep();

  // ----- paragraph -----
  const gPara = group();
  btn(gPara, 'align', 'alignLeft', '配置', (b) => openPop(b, (p) => {
    const cur = C.blockAlign(ctx.view.state);
    for (const [v, label, k] of [['left', '左揃え', 'L'], ['center', '中央揃え', 'E'], ['right', '右揃え', 'R'], ['justify', '両端揃え', 'J']]) {
      p.append(menuItem({ icon: ALIGN_ICON[v], label, kbd: `${MOD}${SHIFT}${k}`, checked: cur === v, onClick: () => run(C.setAlign(v)) }));
    }
  }));
  btn(gPara, 'lineHeight', 'lineSpacing', '行間隔', (b) => openPop(b, (p) => {
    const cur = C.blockAttr(ctx.view.state, 'lineHeight') || null;
    p.append(menuItem({ label: '標準（設定に従う）', checked: cur === null, onClick: () => run(C.setLineHeight(null)) }));
    for (const [v, label] of [['1', '1 行'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', '2 行']]) {
      p.append(menuItem({ label, checked: cur === v, onClick: () => run(C.setLineHeight(v)) }));
    }
  }));
  sep();
  const gList = group();
  btn(gList, 'checklist', 'checklist', 'チェックリスト', () => run(C.toggleList('checklist')), `${MOD}${SHIFT}9`);
  btn(gList, 'bullet', 'bulletList', '箇条書き', () => run(C.toggleList('bullet_list')), `${MOD}${SHIFT}8`);
  btn(gList, 'bulletStyle', 'chevron', '箇条書きの記号', (b) => openPop(b, (p) => {
    const l = C.currentList(ctx.view.state);
    const cur = l && l.node.type === N.bullet_list ? l.node.attrs.style || 'disc' : null;
    for (const s of BULLET_STYLES) p.append(menuItem({ label: BULLET_NAME[s], checked: cur === s, onClick: () => run(C.toggleList('bullet_list', s === 'disc' ? null : s)) }));
  }), '', 'chev');
  btn(gList, 'ordered', 'orderedList', '番号付きリスト', () => run(C.toggleList('ordered_list')), `${MOD}${SHIFT}7`);
  btn(gList, 'orderedStyle', 'chevron', '番号の形式', (b) => openPop(b, (p) => {
    const l = C.currentList(ctx.view.state);
    const cur = l && l.node.type === N.ordered_list ? l.node.attrs.style || 'decimal' : null;
    for (const s of NUMBER_STYLES) p.append(menuItem({ label: NUMBER_NAME[s], checked: cur === s, onClick: () => run(C.toggleList('ordered_list', s === 'decimal' ? null : s)) }));
    if (cur) {
      p.append(menuSep());
      p.append(menuItem({ label: 'ここから番号を振り直す', onClick: () => run(C.restartNumbering(1)) }));
      p.append(menuItem({ label: '開始番号を指定…', onClick: () => actions.listStart() }));
    }
  }), '', 'chev');
  btn(gList, 'outdent', 'outdent', 'インデントを減らす', () => run(C.changeIndent(-1)), `${MOD}[`);
  btn(gList, 'indent', 'indent', 'インデントを増やす', () => run(C.changeIndent(1)), `${MOD}]`);
  sep();

  // ----- more -----
  const gMore = group();
  btn(gMore, 'insert', 'insert', '挿入', (b) => openPop(b, (p) => {
    p.append(menuItem({ icon: 'image', label: '画像', onClick: () => actions.pickImage() }));
    p.append(menuItem({ icon: 'table', label: '表', onClick: () => run(C.insertTable(3, 3)) }));
    p.append(menuItem({ icon: 'rule', label: '区切り線', onClick: () => run(C.insertRule) }));
    p.append(menuItem({ icon: 'pageBreak', label: '改ページ', kbd: `${MOD}Enter`, onClick: () => run(C.insertPageBreak) }));
    p.append(menuItem({ icon: 'footnote', label: '脚注', kbd: `${MOD}${ALT}F`, onClick: () => actions.insertFootnote() }));
    p.append(menuItem({ icon: 'toc', label: '目次', onClick: () => run(C.insertToc) }));
    p.append(menuItem({ icon: 'calendar', label: '今日の日付', onClick: () => actions.insertDate() }));
    p.append(menuItem({ icon: 'link', label: 'リンク', kbd: `${MOD}K`, onClick: () => actions.openLink() }));
  }));
  btn(gMore, 'format', 'format', '書式', (b) => openPop(b, (p) => {
    const s = ctx.view.state;
    p.append(menuItem({ icon: 'sup', label: '上付き文字', kbd: `${MOD}.`, checked: C.markActive(s, M.sup), onClick: () => run(C.toggleSup) }));
    p.append(menuItem({ icon: 'sub', label: '下付き文字', kbd: `${MOD},`, checked: C.markActive(s, M.sub), onClick: () => run(C.toggleSub) }));
    p.append(menuItem({ icon: 'code', label: 'コード（文字）', kbd: `${MOD}E`, checked: C.markActive(s, M.code), onClick: () => run(C.toggleCode) }));
    p.append(menuItem({ icon: 'quoteBlock', label: '引用', checked: C.inside(s, N.blockquote), onClick: () => run(C.toggleQuote) }));
    p.append(menuSep());
    p.append(menuItem({ icon: 'paint', label: '書式をコピー', kbd: `${MOD}${ALT}C`, onClick: () => copyFormat() }));
    p.append(menuItem({ icon: 'paint', label: '書式を貼り付け', kbd: `${MOD}${ALT}V`, onClick: () => pasteFormat() }));
    p.append(menuItem({ icon: 'clear', label: '書式をクリア', kbd: `${MOD}\\`, onClick: () => run(C.clearFormatting) }));
  }));
  btn(gMore, 'clear', 'clear', '書式をクリア', () => run(C.clearFormatting), `${MOD}\\`);

  on('paint', () => {
    setPressed('paint', !!paint.fmt);
    ctx.view.dom.classList.toggle('painting', !!paint.fmt);
  });
}

function setPressed(key, v) { if (buttons[key]) buttons[key].setAttribute('aria-pressed', String(!!v)); }
function setDisabled(key, v) { if (buttons[key]) buttons[key].disabled = !!v; }

export function updateToolbar() {
  const s = ctx.view.state;
  setDisabled('undo', undoDepth(s) === 0);
  setDisabled('redo', redoDepth(s) === 0);
  const st = C.blockStyle(s);
  const found = STYLES.find(([v]) => v === st);
  styleLabel.textContent = found ? found[1] : '—';
  const ff = C.markAttr(s, M.fontFamily, 'family');
  fontLabel.textContent = ff === undefined ? '—' : ff ? FONT_NAMES[ff] : '標準';
  const size = C.fontSizeAt(s);
  sizeLabel.textContent = size == null ? '—' : String(size);
  setPressed('bold', C.markActive(s, M.strong));
  setPressed('italic', C.markActive(s, M.em));
  setPressed('underline', C.markActive(s, M.underline));
  setPressed('strike', C.markActive(s, M.strike));
  setPressed('link', !!C.linkRange(s));
  const tc = C.markAttr(s, M.color, 'color');
  tcBtn.style.setProperty('--swatch', tc ? `var(--tc-${tc})` : 'var(--ink)');
  const hl = C.markAttr(s, M.highlight, 'color');
  hlBtn.style.setProperty('--swatch', hl ? `var(--hl-${hl})` : 'transparent');
  const al = C.blockAlign(s);
  if (buttons.align.dataset.v !== al) { buttons.align.dataset.v = al; buttons.align.innerHTML = icon(ALIGN_ICON[al] || 'alignLeft'); }
  const lt = C.listType(s);
  setPressed('bullet', lt === 'bullet_list');
  setPressed('ordered', lt === 'ordered_list');
  setPressed('checklist', lt === 'checklist');
  setDisabled('indent', !C.changeIndent(1)(s));
  setDisabled('outdent', !C.changeIndent(-1)(s));
  const inTable = C.isInTable(s);
  if (gTable.hidden === inTable) gTable.hidden = !inTable;
  if (inTable) {
    setDisabled('merge', !mergeCells(s));
    setDisabled('split', !splitCell(s));
  }
}

// ---------- palettes and pickers ----------

function cellBackground(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type === N.table_cell || n.type === N.table_header) return n.attrs.background;
  }
  return null;
}

function openPalette(button, kind) {
  openPop(button, (p) => {
    const s = ctx.view.state;
    const cur = kind === 'text' ? C.markAttr(s, M.color, 'color') : kind === 'highlight' ? C.markAttr(s, M.highlight, 'color') : cellBackground(s);
    p.append(menuLabel(kind === 'text' ? '文字の色' : kind === 'highlight' ? '蛍光ペン' : 'セルの背景色'));
    const grid = el('div', { class: 'swatches' });
    const apply = (color) => {
      closePop();
      if (kind === 'text') run(C.setColor(color));
      else if (kind === 'highlight') run(C.setHighlight(color));
      else run(setCellAttr('background', color));
    };
    const none = el('button', { type: 'button', class: 'swatch none', text: 'なし', 'aria-checked': String(!cur) });
    none.addEventListener('click', () => apply(null));
    grid.append(none);
    for (const c of COLORS) {
      const b = el('button', { type: 'button', class: 'swatch', title: COLOR_NAME[c], 'aria-label': COLOR_NAME[c], 'aria-checked': String(cur === c) });
      if (kind === 'text') { b.textContent = 'A'; b.style.color = `var(--tc-${c})`; }
      else b.style.background = `var(--${kind === 'highlight' ? 'hl' : 'bg'}-${c})`;
      b.addEventListener('click', () => apply(c));
      grid.append(b);
    }
    p.append(grid);
  }, { role: 'dialog' });
}

function openTablePicker(button) {
  openPop(button, (p) => {
    const label = el('div', { class: 'grid-label', text: '表の大きさを選ぶ' });
    const grid = el('div', { class: 'grid-pick' });
    const cells = [];
    const show = (r, c) => {
      for (const b of cells) b.classList.toggle('on', +b.dataset.r <= r && +b.dataset.c <= c);
      label.textContent = `${r} 行 × ${c} 列`;
    };
    for (let r = 1; r <= 8; r++) {
      for (let c = 1; c <= 8; c++) {
        const b = el('button', { type: 'button', 'data-r': String(r), 'data-c': String(c), 'aria-label': `${r} 行 × ${c} 列` });
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

