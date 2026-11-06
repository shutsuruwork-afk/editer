import { toggleMark, setBlockType, wrapIn, lift, chainCommands } from 'prosemirror-commands';
import { wrapInList, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { isInTable, CellSelection, goToNextCell, addRowAfter, selectedRect, TableMap } from 'prosemirror-tables';
import { schema, safeHref, FONT_SIZES, BASE_PT, MAX_INDENT, FORMAT_MARKS } from './schema.js';

const N = schema.nodes;
const M = schema.marks;
const LISTS = [N.bullet_list, N.ordered_list, N.checklist];
const FORMAT = FORMAT_MARKS.map((n) => M[n]);

// ---------- inspecting the selection ----------

export function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

// The attribute of a mark at the cursor / in the selection; undefined when the selection is mixed.
export function markAttr(state, type, attr) {
  const { from, $from, to, empty } = state.selection;
  if (empty) { const m = type.isInSet(state.storedMarks || $from.marks()); return m ? m.attrs[attr] : null; }
  let found;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    const m = type.isInSet(node.marks);
    const v = m ? m.attrs[attr] : null;
    if (found === undefined) found = v;
    else if (found !== v) found = 'mixed';
    return true;
  });
  return found === 'mixed' ? undefined : found === undefined ? null : found;
}

export function textblocksIn(state) {
  const { from, to } = state.selection;
  const out = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) { out.push([node, pos]); return false; }
    return true;
  });
  if (!out.length && state.selection.$from.parent.isTextblock) out.push([state.selection.$from.parent, state.selection.$from.before()]);
  return out;
}

// The textblock the cursor is in: "paragraph", "h1"…"h4", "code"
export function blockStyle(state) {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to) && $from.parent.type !== $to.parent.type) return null;
  const p = $from.parent;
  if (p.type === N.heading) return 'h' + p.attrs.level;
  if (p.type === N.code_block) return 'code';
  if (p.type === N.paragraph) return 'paragraph';
  return null;
}

export function blockAttr(state, name) {
  const p = state.selection.$from.parent;
  return p.attrs ? p.attrs[name] : null;
}
export const blockAlign = (state) => blockAttr(state, 'align') || 'left';

// The innermost list around the cursor: "bullet_list" | "ordered_list" | "checklist" | null
export function listType(state) {
  const f = findList(state.selection.$from);
  return f ? f.node.type.name : null;
}
export function currentList(state) { return findList(state.selection.$from); }

export function inside(state, type) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
}

export { isInTable };

// The size shown in the font size box: an explicit size, or what the paragraph style gives.
const STYLE_PT = { h1: 19, h2: 15, h3: 13, h4: 11, code: 9.5, paragraph: BASE_PT };
export function fontSizeAt(state) {
  const s = markAttr(state, M.fontSize, 'size');
  if (s === undefined) return null;
  if (s) return s;
  return STYLE_PT[blockStyle(state)] || BASE_PT;
}

// ---------- marks ----------

export const toggleBold = toggleMark(M.strong);
export const toggleItalic = toggleMark(M.em);
export const toggleUnderline = toggleMark(M.underline);
export const toggleStrike = toggleMark(M.strike);
export const toggleCode = toggleMark(M.code);
export const toggleSup = toggleMark(M.sup);
export const toggleSub = toggleMark(M.sub);

// Sets (attrs) or removes (null) a mark with attributes over the selection, or for what is typed next.
export function setMark(type, attrs) {
  return (state, dispatch) => {
    const { from, to, empty, $cursor } = state.selection;
    if (empty && !$cursor) return false;
    if (dispatch) {
      const tr = state.tr;
      if (empty) {
        if (attrs) tr.addStoredMark(type.create(attrs));
        else tr.removeStoredMark(type);
      } else {
        tr.removeMark(from, to, type);
        if (attrs) tr.addMark(from, to, type.create(attrs));
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export const setColor = (color) => setMark(M.color, color ? { color } : null);
export const setHighlight = (color) => setMark(M.highlight, color ? { color } : null);
export const setFontFamily = (family) => setMark(M.fontFamily, family ? { family } : null);
export const setFontSize = (size) => setMark(M.fontSize, size && Math.abs(size - BASE_PT) > 0.01 ? { size } : null);

// Ctrl+Shift+. / Ctrl+Shift+, — the next size in the list.
export function stepFontSize(dir) {
  return (state, dispatch) => {
    const cur = fontSizeAt(state) || BASE_PT;
    let next;
    if (dir > 0) next = FONT_SIZES.find((s) => s > cur + 0.01) || cur + 1;
    else next = [...FONT_SIZES].reverse().find((s) => s < cur - 0.01) || Math.max(1, cur - 1);
    const style = STYLE_PT[blockStyle(state)] || BASE_PT;
    return setMark(M.fontSize, Math.abs(next - style) < 0.01 && style === BASE_PT ? null : { size: next })(state, dispatch);
  };
}

export function clearFormatting(state, dispatch) {
  const { from, to, empty } = state.selection;
  if (dispatch) {
    const tr = state.tr;
    if (empty) tr.setStoredMarks([]);
    else for (const m of FORMAT) tr.removeMark(from, to, m);
    for (const [node, pos] of textblocksIn(state)) {
      if ('indent' in node.attrs && (node.attrs.align || node.attrs.indent || node.attrs.lineHeight)) {
        tr.setNodeMarkup(pos, null, { ...node.attrs, align: null, indent: 0, lineHeight: null });
      }
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
}

// ---------- copying formatting (書式のコピー / ペイント) ----------

export function captureFormat(state) {
  const { $from, empty } = state.selection;
  const marks = (empty ? state.storedMarks || $from.marks() : (state.doc.nodeAt(state.selection.from) || { marks: $from.marks() }).marks)
    .filter((m) => FORMAT.includes(m.type));
  const p = $from.parent;
  const block = p.type === N.heading || p.type === N.paragraph ? { type: p.type.name, attrs: { ...p.attrs } } : null;
  return { marks, block };
}

export function applyFormat(fmt, range) {
  return (state, dispatch) => {
    const from = range ? range.from : state.selection.from;
    const to = range ? range.to : state.selection.to;
    if (from === to) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const m of FORMAT) tr.removeMark(from, to, m);
      for (const m of fmt.marks) tr.addMark(from, to, m);
      if (fmt.block) {
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isTextblock) return true;
          if (node.type === N.paragraph || node.type === N.heading) {
            const type = N[fmt.block.type];
            const attrs = type === N.heading ? { ...fmt.block.attrs } : { align: fmt.block.attrs.align, indent: fmt.block.attrs.indent, lineHeight: fmt.block.attrs.lineHeight };
            tr.setNodeMarkup(pos, type, attrs);
          }
          return false;
        });
      }
      dispatch(tr);
    }
    return true;
  };
}

// ---------- block styles ----------

function keptAttrs(node) {
  const a = node && node.attrs ? node.attrs : {};
  return { align: a.align || null, indent: a.indent || 0, lineHeight: a.lineHeight || null };
}

export function setStyle(style) {
  return (state, dispatch) => {
    const keep = keptAttrs(state.selection.$from.parent);
    if (style === 'paragraph') return setBlockType(N.paragraph, keep)(state, dispatch);
    if (style === 'code') return setBlockType(N.code_block)(state, dispatch);
    const level = +String(style).slice(1);
    return setBlockType(N.heading, { level, ...keep })(state, dispatch);
  };
}

function setBlockAttr(name, value) {
  return (state, dispatch) => {
    const targets = textblocksIn(state).filter(([node]) => name in node.attrs);
    if (!targets.length) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const [node, pos] of targets) tr.setNodeMarkup(pos, null, { ...node.attrs, [name]: value });
      dispatch(tr);
    }
    return true;
  };
}

export const setAlign = (align) => setBlockAttr('align', align === 'left' ? null : align);
export const setLineHeight = (lh) => setBlockAttr('lineHeight', lh || null);

// Docs' indent buttons: inside a list they move the item; elsewhere they indent the paragraph.
export function changeIndent(delta) {
  return (state, dispatch) => {
    if (listType(state)) return delta > 0 ? indent(state, dispatch) : outdent(state, dispatch);
    const targets = textblocksIn(state).filter(([node]) => 'indent' in node.attrs);
    const changes = targets
      .map(([node, pos]) => [node, pos, Math.max(0, Math.min(MAX_INDENT, (node.attrs.indent || 0) + delta))])
      .filter(([node, , v]) => v !== (node.attrs.indent || 0));
    if (!changes.length) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const [node, pos, v] of changes) tr.setNodeMarkup(pos, null, { ...node.attrs, indent: v });
      dispatch(tr);
    }
    return true;
  };
}

// ---------- lists ----------

function findList($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (LISTS.includes(node.type)) return { node, depth: d, pos: $pos.before(d) };
  }
  return null;
}

// Docs-style list buttons: off → on, same list → off, other list → switch kind in place.
export function toggleList(name, style = null) {
  const listNode = N[name];
  const itemNode = name === 'checklist' ? N.check_item : N.list_item;
  return (state, dispatch) => {
    const found = findList(state.selection.$from);
    if (found && found.node.type === listNode && !style) {
      return chainCommands(liftListItem(N.list_item), liftListItem(N.check_item))(state, dispatch);
    }
    const attrs = listNode === N.ordered_list ? { order: 1, style } : listNode === N.bullet_list ? { style } : null;
    if (found) {
      if (dispatch) {
        const tr = state.tr;
        const { node, pos } = found;
        tr.setNodeMarkup(pos, listNode, found.node.type === listNode && listNode === N.ordered_list ? { ...node.attrs, style } : attrs);
        if (found.node.type !== listNode) {
          node.forEach((child, offset) => {
            tr.setNodeMarkup(pos + 1 + offset, itemNode, itemNode === N.check_item ? { checked: false } : null);
          });
        }
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    return wrapInList(listNode, attrs)(state, dispatch);
  };
}

export const indent = (state, dispatch) => chainCommands(sinkListItem(N.list_item), sinkListItem(N.check_item))(state, dispatch);
export const outdent = (state, dispatch) => chainCommands(liftListItem(N.list_item), liftListItem(N.check_item))(state, dispatch);

// Starts the numbering again at `start` from the item the cursor is in.
export function restartNumbering(start = 1) {
  return (state, dispatch) => {
    const found = findList(state.selection.$from);
    if (!found || found.node.type !== N.ordered_list) return false;
    const { $from } = state.selection;
    const index = $from.index(found.depth);
    if (dispatch) {
      const tr = state.tr;
      if (index === 0) {
        tr.setNodeMarkup(found.pos, null, { ...found.node.attrs, order: start });
      } else {
        const at = $from.posAtIndex(index, found.depth);
        tr.split(at, 1, [{ type: N.ordered_list, attrs: { ...found.node.attrs, order: start } }]);
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function toggleCheck(pos) {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== N.check_item) return false;
    if (dispatch) dispatch(state.tr.setNodeMarkup(pos, null, { ...node.attrs, checked: !node.attrs.checked }));
    return true;
  };
}

// ---------- quote ----------

export function toggleQuote(state, dispatch) {
  if (inside(state, N.blockquote)) return lift(state, dispatch);
  return wrapIn(N.blockquote)(state, dispatch);
}

// ---------- inserting ----------

// Inserts a block (rule, image, table…) at the cursor the way Docs does: into an empty line it
// replaces the line, at the end of a line it goes after it, in the middle it splits the line.
// Returns the transaction and where the block starts, or null when it cannot go here.
function insertBlockTr(state, node) {
  const sel = state.selection;
  if (sel instanceof CellSelection) return null;
  const tr = state.tr;
  if (sel instanceof NodeSelection) {
    const $p = tr.doc.resolve(sel.to);
    if (!$p.parent.canReplaceWith($p.index(), $p.index(), node.type)) return null;
    tr.insert(sel.to, node);
    return { tr, pos: sel.to };
  }
  if (!sel.empty) tr.deleteSelection();
  const $c = tr.selection.$from;
  if (!$c.parent.isTextblock || $c.depth < 1) return null;
  const container = $c.node($c.depth - 1);
  const idx = $c.index($c.depth - 1);
  const can = (from, to) => container.canReplaceWith(from, to, node.type);
  const size = $c.parent.content.size;
  let pos;
  if (size === 0 && can(idx, idx + 1)) { pos = $c.before(); tr.replaceWith(pos, $c.after(), node); }
  else if (($c.parentOffset === size || size === 0) && can(idx + 1, idx + 1)) { pos = $c.after(); tr.insert(pos, node); }
  else if ($c.parentOffset === 0 && can(idx, idx)) { pos = $c.before(); tr.insert(pos, node); }
  else if (can(idx + 1, idx + 1)) { tr.split($c.pos); pos = $c.pos + 1; tr.insert(pos, node); }
  else return null;
  const end = pos + node.nodeSize;
  if (!tr.doc.resolve(end).nodeAfter) tr.insert(end, N.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1));
  return { tr, pos };
}

function insertBlock(node) {
  return (state, dispatch) => {
    const r = insertBlockTr(state, node);
    if (!r) return false;
    if (dispatch) dispatch(r.tr.scrollIntoView());
    return true;
  };
}

export const insertRule = (state, dispatch) => insertBlock(N.horizontal_rule.create())(state, dispatch);
export const insertPageBreak = (state, dispatch) => insertBlock(N.page_break.create())(state, dispatch);
export const insertToc = (state, dispatch) => insertBlock(N.toc.create())(state, dispatch);

export function insertImage(src, alt = '') {
  return insertBlock(N.image.create({ src, alt }));
}

export function insertTable(rows, cols, header = true) {
  return (state, dispatch) => {
    const list = [];
    for (let r = 0; r < rows; r++) {
      const cells = [];
      for (let c = 0; c < cols; c++) cells.push((header && r === 0 ? N.table_header : N.table_cell).createAndFill());
      list.push(N.table_row.create(null, cells));
    }
    const r = insertBlockTr(state, N.table.create(null, list));
    if (!r) return false;
    if (dispatch) {
      // table > row > cell > paragraph
      r.tr.setSelection(TextSelection.create(r.tr.doc, r.pos + 4));
      dispatch(r.tr.scrollIntoView());
    }
    return true;
  };
}

export function insertText(text) {
  return (state, dispatch) => {
    if (!state.selection.$from.parent.inlineContent) return false;
    if (dispatch) dispatch(state.tr.insertText(text).scrollIntoView());
    return true;
  };
}

// Inserts a footnote reference at the cursor; `onInserted(pos)` gets where it went.
export function insertFootnote(text, onInserted) {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if (!$from.parent.inlineContent || !$from.parent.canReplaceWith($from.index(), $from.index(), N.footnote)) return false;
    if (dispatch) {
      const tr = state.tr;
      const pos = state.selection.to;
      tr.insert(pos, N.footnote.create({ text }));
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      dispatch(tr.scrollIntoView());
      if (onInserted) onInserted(pos);
    }
    return true;
  };
}

export function setNodeAttrs(pos, patch) {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node) return false;
    if (dispatch) {
      const tr = state.tr.setNodeMarkup(pos, null, { ...node.attrs, ...patch });
      if (state.selection instanceof NodeSelection && state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos));
      dispatch(tr);
    }
    return true;
  };
}

// ---------- tables ----------

// Tab in the last cell adds a row, like Docs.
export function nextCellOrNewRow(state, dispatch) {
  if (goToNextCell(1)(state, dispatch)) return true;
  if (!isInTable(state)) return false;
  if (!dispatch) return true;
  let tr = null;
  addRowAfter(state, (t) => { tr = t; });
  if (!tr) return false;
  // then move into the first cell of the new row (only the selection changes, so it fits tr.doc)
  goToNextCell(1)(state.apply(tr), (t) => { tr.setSelection(t.selection); });
  dispatch(tr.scrollIntoView());
  return true;
}

export function distributeColumns(state, dispatch) {
  if (!isInTable(state)) return false;
  if (dispatch) {
    const rect = selectedRect(state);
    const tr = state.tr;
    const map = rect.map || TableMap.get(rect.table);
    const seen = new Set();
    for (const rel of map.map) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const pos = rect.tableStart + rel;
      const cell = state.doc.nodeAt(pos);
      if (cell && cell.attrs.colwidth) tr.setNodeMarkup(pos, null, { ...cell.attrs, colwidth: null });
    }
    dispatch(tr);
  }
  return true;
}

// ---------- links ----------

// The full extent of the link at the cursor (or in the selection): { from, to, href } or null.
export function linkRange(state) {
  const { $from, from, to, empty } = state.selection;
  let mark = null;
  if (empty) {
    mark = M.link.isInSet($from.marks())
      || ($from.nodeAfter && M.link.isInSet($from.nodeAfter.marks))
      || ($from.nodeBefore && M.link.isInSet($from.nodeBefore.marks));
  } else if ($from.sameParent(state.selection.$to)) {
    state.doc.nodesBetween(from, to, (n) => { if (!mark) mark = M.link.isInSet(n.marks); });
  }
  if (!mark) return null;
  const runs = [];
  const base = $from.start();
  $from.parent.forEach((child, offset) => {
    const s = base + offset, e = s + child.nodeSize;
    if (!mark.isInSet(child.marks)) return;
    const last = runs[runs.length - 1];
    if (last && last[1] === s) last[1] = e; else runs.push([s, e]);
  });
  const run = runs.find(([s, e]) => s <= from && e >= from) || runs.find(([s, e]) => s < to && e > from);
  return run ? { from: run[0], to: run[1], href: mark.attrs.href } : null;
}

export function setLink(href, text) {
  return (state, dispatch) => {
    const url = safeHref(href);
    if (!url) return false;
    if (dispatch) {
      const tr = state.tr;
      const existing = linkRange(state);
      let { from, to } = state.selection;
      if (existing && state.selection.empty) { from = existing.from; to = existing.to; }
      if (text != null && text !== state.doc.textBetween(from, to)) {
        const marks = state.doc.resolve(from).marksAcross(state.doc.resolve(to)) || [];
        tr.replaceWith(from, to, schema.text(text || url, marks.filter((m) => m.type !== M.link)));
        to = from + (text || url).length;
      } else if (from === to) {
        tr.insertText(url, from);
        to = from + url.length;
      }
      tr.removeMark(from, to, M.link).addMark(from, to, M.link.create({ href: url }));
      tr.setSelection(TextSelection.create(tr.doc, to));
      tr.removeStoredMark(M.link);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function removeLink(state, dispatch) {
  const r = linkRange(state);
  const { from, to, empty } = state.selection;
  if (!r && empty) return false;
  if (dispatch) dispatch(state.tr.removeMark(r && empty ? r.from : from, r && empty ? r.to : to, M.link));
  return true;
}
