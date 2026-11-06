import { Plugin, PluginKey, NodeSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { history } from 'prosemirror-history';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { columnResizing, tableEditing } from 'prosemirror-tables';
import { search } from 'prosemirror-search';
import { schema, safeHref } from './schema.js';
import { buildKeymap, buildInputRules } from './keys.js';
import { storeFile, imageUrl, cachedUrl } from '../app/images.js';

const N = schema.nodes;
const M = schema.marks;

// ---------- headings and footnotes, collected with a per-block cache ----------
// Unchanged top-level blocks are the same objects between edits, so only edited blocks are walked.

const headingCache = new WeakMap();
const footnoteCache = new WeakMap();

function collect(doc, cache, test, inline) {
  const out = [];
  doc.forEach((child, offset) => {
    let list = cache.get(child);
    if (!list) {
      list = [];
      if (test(child)) list.push({ node: child, rel: 0 });
      else if (!child.isLeaf && (inline || !child.isTextblock)) {
        child.descendants((n, p) => {
          if (test(n)) list.push({ node: n, rel: p + 1 });
          return inline || !n.isTextblock;
        });
      }
      cache.set(child, list);
    }
    for (const it of list) out.push({ node: it.node, pos: offset + it.rel });
  });
  return out;
}

export const headingsOf = (doc) => collect(doc, headingCache, (n) => n.type === N.heading, false)
  .map(({ node, pos }) => ({ level: node.attrs.level, text: node.textContent, pos }));
export const footnotesOf = (doc) => collect(doc, footnoteCache, (n) => n.type === N.footnote, true)
  .map(({ node, pos }) => ({ text: node.attrs.text, pos }));

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
      if (!view.editable) return;
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
    const { src, alt, width, align } = this.node.attrs;
    if (this.src !== src) {
      this.src = src;
      const ready = cachedUrl(src);
      if (ready) this.show(ready);
      else {
        this.dom.classList.add('loading');
        imageUrl(src).then((url) => { if (this.src === src) this.show(url); });
      }
    }
    this.img.alt = alt || '';
    this.dom.title = alt || '';
    this.dom.style.width = width ? width + '%' : '';
    this.dom.dataset.align = align || 'center';
  }
  show(url) {
    this.dom.classList.remove('loading');
    this.dom.classList.toggle('missing', !url);
    if (url) this.img.src = url; else this.img.removeAttribute('src');
  }
  startResize(e) {
    if (!this.view.editable) return;
    e.preventDefault();
    e.stopPropagation();
    const page = this.dom.parentElement;
    const full = page ? page.getBoundingClientRect().width : 600;
    const startX = e.clientX;
    const startW = this.dom.getBoundingClientRect().width;
    const centered = (this.node.attrs.align || 'center') === 'center';
    this.handle.setPointerCapture(e.pointerId);
    let pct = null;
    const move = (ev) => {
      const w = Math.max(40, Math.min(full, startW + (ev.clientX - startX) * (centered ? 2 : 1)));
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

class FootnoteView {
  constructor(node) {
    this.node = node;
    this.dom = document.createElement('sup');
    this.dom.className = 'footnote-ref';
    this.dom.title = node.attrs.text || '（空の脚注）';
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.title = node.attrs.text || '（空の脚注）';
    return true;
  }
  selectNode() { this.dom.classList.add('selected'); }
  deselectNode() { this.dom.classList.remove('selected'); }
  ignoreMutation() { return true; }
}

const tocViews = new Set();
class TocView {
  constructor(node, view) {
    this.node = node;
    this.view = view;
    this.dom = document.createElement('nav');
    this.dom.className = 'toc';
    this.dom.dataset.type = 'toc';
    this.dom.addEventListener('mousedown', (e) => { if (e.target.closest('a')) e.preventDefault(); });
    this.dom.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-i]');
      if (!a) return;
      e.preventDefault();
      const h = headingsOf(this.view.state.doc)[+a.dataset.i];
      if (h) this.dom.dispatchEvent(new CustomEvent('editer:goto', { bubbles: true, detail: h.pos }));
    });
    tocViews.add(this);
    this.render();
  }
  render() {
    const hs = headingsOf(this.view.state.doc);
    const sig = hs.map((h) => h.level + h.text).join('\n');
    if (sig === this.sig) return;
    this.sig = sig;
    this.dom.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'toc-title';
    title.textContent = '目次';
    this.dom.append(title);
    if (!hs.length) {
      const p = document.createElement('p');
      p.className = 'toc-empty';
      p.textContent = '見出しを付けると、ここに目次ができます。';
      this.dom.append(p);
      return;
    }
    const ul = document.createElement('ul');
    hs.forEach((h, i) => {
      const li = document.createElement('li');
      li.className = 'l' + h.level;
      const a = document.createElement('a');
      a.href = '#';
      a.dataset.i = String(i);
      a.textContent = h.text || '（空の見出し）';
      li.append(a);
      ul.append(li);
    });
    this.dom.append(ul);
  }
  update(node) { return node.type === this.node.type; }
  selectNode() { this.dom.classList.add('selected'); }
  deselectNode() { this.dom.classList.remove('selected'); }
  stopEvent(e) { return !!(e.target.closest && e.target.closest('a')); }
  ignoreMutation() { return true; }
  destroy() { tocViews.delete(this); }
}

const tocRefresh = new Plugin({
  view: () => ({
    update(view, prev) {
      if (view.state.doc !== prev.doc && tocViews.size) for (const t of tocViews) if (t.view === view) t.render();
    },
  }),
});

// ---------- footnotes listed at the end of the document ----------

const footnoteKey = new PluginKey('footnotes');
const footnoteList = new Plugin({
  key: footnoteKey,
  state: {
    init: (_, state) => footnotesOf(state.doc),
    apply: (tr, prev) => (tr.docChanged ? footnotesOf(tr.doc) : prev),
  },
  props: {
    decorations(state) {
      const notes = footnoteKey.getState(state);
      if (!notes.length) return null;
      const sig = notes.map((n) => n.text).join('\u0000');
      return DecorationSet.create(state.doc, [Decoration.widget(state.doc.content.size, () => {
        const sec = document.createElement('section');
        sec.className = 'footnotes';
        sec.contentEditable = 'false';
        const ol = document.createElement('ol');
        notes.forEach((n, i) => {
          const li = document.createElement('li');
          li.dataset.i = String(i);
          li.textContent = n.text || '（空の脚注）';
          li.title = '押して編集';
          ol.append(li);
        });
        sec.append(ol);
        sec.addEventListener('mousedown', (e) => e.preventDefault());
        sec.addEventListener('click', (e) => {
          const li = e.target.closest('li[data-i]');
          if (li) sec.dispatchEvent(new CustomEvent('editer:footnote', { bubbles: true, detail: { index: +li.dataset.i } }));
        });
        return sec;
      }, { side: 1, key: 'fn:' + sig, ignoreSelection: true, stopEvent: () => true })]);
    },
  },
});

// ---------- pasting and dropping ----------

function imageFiles(list) {
  return Array.from(list || []).filter((f) => /^image\//.test(f.type));
}

const notice = (view, msg) => view.dom.dispatchEvent(new CustomEvent('editer:notice', { bubbles: true, detail: msg }));

async function insertImageFiles(view, files, pos) {
  for (const file of files) {
    try {
      const src = await storeFile(file);
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
    } catch {
      notice(view, '画像を読み込めませんでした（' + file.name + '）');
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

// ---------- long documents: skip laying out what is off screen ----------
// Text blocks get `content-visibility: auto` (see styles.css) once a document is long. The blocks
// around the caret are always laid out, so a paragraph or list made by Enter or a typing shortcut is
// never skipped while the next keystroke arrives.

const LONG_DOC = 150;
const longDocs = new Plugin({
  props: {
    attributes: (state) => (state.doc.childCount >= LONG_DOC ? { class: 'long' } : null),
    decorations(state) {
      const { doc, selection } = state;
      if (doc.childCount < LONG_DOC) return null;
      const decos = [];
      const seen = new Set();
      const around = (pos) => {
        const { index, offset } = doc.content.findIndex(Math.min(pos, doc.content.size - 1));
        let start = index > 0 ? offset - doc.child(index - 1).nodeSize : offset;
        for (let i = Math.max(0, index - 1); i <= Math.min(doc.childCount - 1, index + 1); i++) {
          const size = doc.child(i).nodeSize;
          if (!seen.has(i)) { seen.add(i); decos.push(Decoration.node(start, start + size, { class: 'near-caret' })); }
          start += size;
        }
      };
      around(selection.from);
      if (selection.to !== selection.from) around(selection.to);
      return DecorationSet.create(doc, decos);
    },
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
    footnoteList,
    tocRefresh,
    longDocs,
    placeholder('ここに入力…'),
  ];
}

export const nodeViews = {
  check_item: (node, view, getPos) => new CheckItemView(node, view, getPos),
  image: (node, view, getPos) => new ImageView(node, view, getPos),
  footnote: (node) => new FootnoteView(node),
  toc: (node, view) => new TocView(node, view),
};
