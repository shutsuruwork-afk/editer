import { toggleMark, setBlockType, wrapIn, lift, chainCommands } from 'prosemirror-commands';
import { wrapInList, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { isInTable, CellSelection } from 'prosemirror-tables';
import { schema, safeHref } from './schema.js';

const N = schema.nodes;
const M = schema.marks;
const LISTS = [N.bullet_list, N.ordered_list, N.checklist];
const ITEMS = [N.list_item, N.check_item];

// ---------- inspecting the selection ----------

export function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

export function markAttr(state, type, attr) {
  const { from, $from, to, empty } = state.selection;
  if (empty) { const m = type.isInSet(state.storedMarks || $from.marks()); return m ? m.attrs[attr] : null; }
  let found = null;
  state.doc.nodesBetween(from, to, (node) => { if (found == null) { const m = type.isInSet(node.marks); if (m) found = m.attrs[attr]; } });
  return found;
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

export function blockAlign(state) {
  const p = state.selection.$from.parent;
  return (p.attrs && p.attrs.align) || 'left';
}

// The innermost list around the cursor: "bullet_list" | "ordered_list" | "checklist" | null
export function listType(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type;
    if (LISTS.includes(t)) return t.name;
  }
  return null;
}

export function inside(state, type) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
}

export { isInTable };

// ---------- marks ----------

export const toggleBold = toggleMark(M.strong);
export const toggleItalic = toggleMark(M.em);
export const toggleUnderline = toggleMark(M.underline);
export const toggleStrike = toggleMark(M.strike);
export const toggleCode = toggleMark(M.code);

export function setColorMark(type, color) {
  return (state, dispatch) => {
    const { from, to, empty, $cursor } = state.selection;
    if (empty && !$cursor) return false;
    if (dispatch) {
      const tr = state.tr;
      if (empty) {
        if (color) tr.addStoredMark(type.create({ color }));
        else tr.removeStoredMark(type);
      } else {
        tr.removeMark(from, to, type);
        if (color) tr.addMark(from, to, type.create({ color }));
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function clearFormatting(state, dispatch) {
  const { from, to, empty } = state.selection;
  if (empty) {
    if (dispatch) dispatch(state.tr.setStoredMarks([]));
    return true;
  }
  if (dispatch) {
    const tr = state.tr;
    for (const m of [M.strong, M.em, M.underline, M.strike, M.code, M.color, M.highlight]) tr.removeMark(from, to, m);
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock && node.type !== N.code_block) {
        if (node.type !== N.paragraph || node.attrs.align) tr.setNodeMarkup(tr.mapping.map(pos), N.paragraph, { align: null });
        return false;
      }
      return true;
    });
    dispatch(tr.scrollIntoView());
  }
  return true;
}

// ---------- block styles ----------

export function setStyle(style) {
  return (state, dispatch) => {
    const align = blockAlign(state);
    const keep = align === 'left' ? null : align;
    if (style === 'paragraph') return setBlockType(N.paragraph, { align: keep })(state, dispatch);
    if (style === 'code') return setBlockType(N.code_block)(state, dispatch);
    const level = +String(style).slice(1);
    return setBlockType(N.heading, { level, align: keep })(state, dispatch);
  };
}

export function setAlign(align) {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const targets = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) { if ('align' in node.attrs) targets.push([node, pos]); return false; }
      return true;
    });
    if (!targets.length) return false;
    if (dispatch) {
      const tr = state.tr;
      const value = align === 'left' ? null : align;
      for (const [node, pos] of targets) tr.setNodeMarkup(pos, null, { ...node.attrs, align: value });
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
export function toggleList(name) {
  const listNode = N[name];
  const itemNode = name === 'checklist' ? N.check_item : N.list_item;
  return (state, dispatch) => {
    const found = findList(state.selection.$from);
    if (found && found.node.type === listNode) {
      return chainCommands(liftListItem(N.list_item), liftListItem(N.check_item))(state, dispatch);
    }
    if (found) {
      if (dispatch) {
        const tr = state.tr;
        const { node, pos } = found;
        tr.setNodeMarkup(pos, listNode, listNode === N.ordered_list ? { order: 1 } : null);
        node.forEach((child, offset) => {
          const p = pos + 1 + offset;
          tr.setNodeMarkup(p, itemNode, itemNode === N.check_item ? { checked: false } : null);
        });
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    return wrapInList(listNode)(state, dispatch);
  };
}

export const indent = (state, dispatch) => chainCommands(sinkListItem(N.list_item), sinkListItem(N.check_item))(state, dispatch);
export const outdent = (state, dispatch) => chainCommands(liftListItem(N.list_item), liftListItem(N.check_item))(state, dispatch);

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

// Inserts a block (rule, image, table) at the cursor the way Docs does: into an empty line it
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
