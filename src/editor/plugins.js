import { Plugin, NodeSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { history } from 'prosemirror-history';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { columnResizing, tableEditing } from 'prosemirror-tables';
import { search } from 'prosemirror-search';
import { schema, safeHref } from './schema.js';
import { buildKeymap, buildInputRules } from './keys.js';
import { imageFileToDataUrl } from '../util/image.js';

const N = schema.nodes;
const M = schema.marks;

// ---------- node views ----------

class CheckItemView {
  constructor(node, view, getPos) {
    this.node = node;
    this.dom = document.createElement('li');
    this.dom.dataset.checked = String(node.attrs.checked);
    const box = document.createElement('span');
    box.className = 'check';
    box.contentEditable = 'false';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(node.attrs.checked));
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      const pos = getPos();
      if (pos == null) return;
      const cur = view.state.doc.nodeAt(pos);
      if (cur) view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...cur.attrs, checked: !cur.attrs.checked }));
    });
    this.box = box;
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'check-body';
    this.dom.append(box, this.contentDOM);
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.dataset.checked = String(node.attrs.checked);
    this.box.setAttribute('aria-checked', String(node.attrs.checked));
    return true;
  }
  ignoreMutation(m) { return m.target === this.box || m.target === this.dom && m.type === 'attributes'; }
}

class ImageView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement('figure');
    this.dom.className = 'img';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.handle = document.createElement('span');
    this.handle.className = 'img-handle';
    this.handle.title = 'ドラッグして大きさを変える';
    this.dom.append(this.img, this.handle);
    this.handle.addEventListener('pointerdown', (e) => this.startResize(e));
    this.render();
  }
  render() {
    const { src, alt, width } = this.node.attrs;
    if (this.img.getAttribute('src') !== src) this.img.src = src;
    this.img.alt = alt || '';
    this.dom.style.width = width ? width + '%' : '';
  }
  startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const page = this.dom.parentElement;
    const full = page ? page.getBoundingClientRect().width : 600;
    const startX = e.clientX;
    const startW = this.dom.getBoundingClientRect().width;
    this.handle.setPointerCapture(e.pointerId);
    let pct = null;
    const move = (ev) => {
      const w = Math.max(40, Math.min(full, startW + (ev.clientX - startX) * 2)); // centered: grows both ways
      pct = Math.round((w / full) * 100);
      this.dom.style.width = pct + '%';
    };
    const up = () => {
      this.handle.removeEventListener('pointermove', move);
      this.handle.removeEventListener('pointerup', up);
      this.handle.removeEventListener('pointercancel', up);
      const pos = this.getPos();
      if (pct != null && pos != null) {
        const tr = this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, width: pct >= 100 ? null : pct });
        tr.setSelection(NodeSelection.create(tr.doc, pos));
        this.view.dispatch(tr);
      }
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
    this.handle.addEventListener('pointercancel', up);
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  selectNode() { this.dom.classList.add('selected'); }
  deselectNode() { this.dom.classList.remove('selected'); }
  stopEvent(e) { return e.target === this.handle; }
  ignoreMutation() { return true; }
}

// ---------- pasting and dropping ----------

function imageFiles(list) {
  return Array.from(list || []).filter((f) => /^image\//.test(f.type));
}

async function insertImageFiles(view, files, pos) {
  for (const file of files) {
    try {
      const src = await imageFileToDataUrl(file);
      const node = N.image.create({ src, alt: file.name.replace(/\.[^.]+$/, '') });
      const { state } = view;
      let tr;
      if (pos != null) {
        const $p = state.doc.resolve(Math.min(pos, state.doc.content.size));
        const at = $p.parent.isTextblock ? ($p.parentOffset === 0 ? $p.before() : $p.after()) : $p.pos;
        tr = state.tr.insert(at, node);
        pos = at + node.nodeSize;
      } else {
        tr = state.tr.replaceSelectionWith(node);
      }
      view.dispatch(tr.scrollIntoView());
    } catch (err) {
      view.dom.dispatchEvent(new CustomEvent('editer:notice', { bubbles: true, detail: '画像を読み込めませんでした（' + file.name + '）' }));
    }
  }
}

const pasteAndDrop = new Plugin({
  props: {
    handlePaste(view, event) {
      const files = imageFiles(event.clipboardData && event.clipboardData.files);
      const html = event.clipboardData && event.clipboardData.getData('text/html');
      if (files.length && !html) { insertImageFiles(view, files); return true; }
      // a bare URL pasted over selected text becomes a link
      const text = event.clipboardData && event.clipboardData.getData('text/plain');
      const { from, to, empty } = view.state.selection;
      if (!empty && text && !html && /^\S+$/.test(text.trim())) {
        const href = safeHref(text.trim());
        if (href && /^(https?:|mailto:)/.test(href) && view.state.selection.$from.sameParent(view.state.selection.$to)) {
          view.dispatch(view.state.tr.addMark(from, to, M.link.create({ href })));
          return true;
        }
      }
      return false;
    },
    handleDrop(view, event, slice, moved) {
      if (moved) return false;
      const files = imageFiles(event.dataTransfer && event.dataTransfer.files);
      if (!files.length) return false;
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
      insertImageFiles(view, files, at ? at.pos : null);
      return true;
    },
  },
});

// URLs in pasted text become links.
const URL_IN_TEXT = /https?:\/\/[^\s<>()（）「」]+[^\s<>()（）「」.,;:!?、。]/g;
const linkifyPaste = new Plugin({
  appendTransaction(trs, oldState, state) {
    if (!trs.some((tr) => tr.getMeta('uiEvent') === 'paste')) return null;
    const ranges = [];
    trs.forEach((t, ti) => {
      t.mapping.maps.forEach((map, i) => {
        map.forEach((_os, _oe, s, e) => {
          for (const m of [t.mapping.slice(i + 1), ...trs.slice(ti + 1).map((x) => x.mapping)]) { s = m.map(s, -1); e = m.map(e, 1); }
          ranges.push([s, e]);
        });
      });
    });
    const tr = state.tr;
    for (const [from, to] of ranges) {
      state.doc.nodesBetween(Math.max(0, from), Math.min(to, state.doc.content.size), (node, pos, parent) => {
        if (!node.isText || parent.type.spec.code || M.link.isInSet(node.marks) || M.code.isInSet(node.marks)) return;
        for (const m of node.text.matchAll(URL_IN_TEXT)) {
          const s = pos + m.index;
          tr.addMark(s, s + m[0].length, M.link.create({ href: m[0] }));
        }
      });
    }
    return tr.docChanged ? tr : null;
  },
});

// ---------- placeholder ----------

const placeholder = (text) => new Plugin({
  props: {
    decorations(state) {
      const { doc } = state;
      if (doc.childCount !== 1 || !doc.firstChild.isTextblock || doc.firstChild.content.size) return null;
      return DecorationSet.create(doc, [Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-empty', 'data-placeholder': text })]);
    },
  },
});

export function buildPlugins(app) {
  return [
    buildInputRules(),
    ...buildKeymap(app),
    history({ newGroupDelay: 600 }),
    dropCursor({ class: 'drop-cursor', width: 2 }),
    gapCursor(),
    columnResizing({ cellMinWidth: 48 }),
    tableEditing(),
    search(),
    pasteAndDrop,
    linkifyPaste,
    placeholder('ここに入力…'),
  ];
}

export const nodeViews = {
  check_item: (node, view, getPos) => new CheckItemView(node, view, getPos),
  image: (node, view, getPos) => new ImageView(node, view, getPos),
};
