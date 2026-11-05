// The document structure. Every document is stored as ProseMirror JSON built from this schema,
// so anything added here has to stay readable by later versions (only add, never rename).
import { Schema } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

export const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
export const ALIGNS = ['left', 'center', 'right', 'justify'];

const SAFE_URL = /^(https?:|mailto:|tel:|#)/i;
export function safeHref(href) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (SAFE_URL.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return ''; // javascript:, data:, … are dropped
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(h)) return 'https://' + h; // "example.com/x"
  return '';
}
const SAFE_IMG = /^(data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);|https:)/i;
export const safeSrc = (src) => (SAFE_IMG.test(String(src || '')) ? String(src) : '');

const alignAttr = { align: { default: null } };
function readAlign(dom) {
  const a = (dom.style && dom.style.textAlign) || dom.getAttribute('align') || '';
  const v = a === 'start' ? 'left' : a === 'end' ? 'right' : a;
  return ALIGNS.includes(v) && v !== 'left' ? v : null;
}
const alignStyle = (node) => (node.attrs.align ? { style: `text-align:${node.attrs.align}` } : {});

const colorFromClass = (dom, prefix) => {
  for (const c of dom.classList || []) if (c.startsWith(prefix) && COLORS.includes(c.slice(prefix.length))) return c.slice(prefix.length);
  return null;
};

const tables = tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {
    background: {
      default: null,
      getFromDOM: (dom) => colorFromClass(dom, 'bg-'),
      setDOMAttr: (value, attrs) => { if (value) attrs.class = (attrs.class ? attrs.class + ' ' : '') + 'bg-' + value; },
    },
  },
});

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },

    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: alignAttr,
      parseDOM: [{ tag: 'p', getAttrs: (dom) => ({ align: readAlign(dom) }) }],
      toDOM: (node) => ['p', alignStyle(node), 0],
    },

    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 }, ...alignAttr },
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((n) => ({
        tag: 'h' + n,
        getAttrs: (dom) => ({ level: Math.min(n, 4), align: readAlign(dom) }),
      })),
      toDOM: (node) => ['h' + node.attrs.level, alignStyle(node), 0],
    },

    blockquote: {
      group: 'block',
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    },

    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
    },

    horizontal_rule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    },

    bullet_list: {
      group: 'block',
      content: 'list_item+',
      parseDOM: [{ tag: 'ul', getAttrs: (dom) => (dom.dataset.type === 'checklist' ? false : null) }],
      toDOM: () => ['ul', 0],
    },

    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { order: { default: 1 } },
      parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ order: dom.hasAttribute('start') ? +dom.getAttribute('start') || 1 : 1 }) }],
      toDOM: (node) => (node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order }, 0]),
    },

    list_item: {
      content: 'paragraph block*',
      defining: true,
      parseDOM: [{ tag: 'li', getAttrs: (dom) => (dom.closest('ul[data-type="checklist"]') ? false : null) }],
      toDOM: () => ['li', 0],
    },

    checklist: {
      group: 'block',
      content: 'check_item+',
      parseDOM: [{ tag: 'ul[data-type="checklist"]', priority: 60 }],
      toDOM: () => ['ul', { 'data-type': 'checklist' }, 0],
    },

    check_item: {
      content: 'paragraph block*',
      defining: true,
      attrs: { checked: { default: false } },
      parseDOM: [{
        tag: 'ul[data-type="checklist"] > li',
        priority: 60,
        getAttrs: (dom) => ({ checked: dom.dataset.checked === 'true' }),
      }],
      toDOM: (node) => ['li', { 'data-checked': node.attrs.checked ? 'true' : 'false' }, 0],
    },

    image: {
      group: 'block',
      atom: true,
      draggable: true,
      attrs: { src: {}, alt: { default: '' }, width: { default: null }, align: { default: 'center' } },
      parseDOM: [{
        tag: 'img[src]',
        getAttrs: (dom) => {
          const src = safeSrc(dom.getAttribute('src'));
          if (!src) return false;
          const w = parseFloat(dom.dataset.width || '');
          return { src, alt: dom.getAttribute('alt') || '', width: w > 0 && w <= 100 ? w : null };
        },
      }],
      toDOM: (node) => {
        const a = { src: safeSrc(node.attrs.src), alt: node.attrs.alt || '' };
        if (node.attrs.width) { a['data-width'] = String(node.attrs.width); a.style = `width:${node.attrs.width}%`; }
        return ['img', a];
      },
    },

    ...tables,

    text: { group: 'inline' },

    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },
  },

  marks: {
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{
        tag: 'a[href]',
        getAttrs: (dom) => {
          const href = safeHref(dom.getAttribute('href'));
          return href ? { href } : false;
        },
      }],
      toDOM: (mark) => ['a', { href: safeHref(mark.attrs.href), rel: 'noopener noreferrer nofollow', target: '_blank' }, 0],
    },

    strong: {
      parseDOM: [
        { tag: 'strong' },
        // Google Docs wraps whole pastes in <b style="font-weight:normal">
        { tag: 'b', getAttrs: (dom) => dom.style.fontWeight !== 'normal' && null },
        { style: 'font-weight=400', clearMark: (m) => m.type.name === 'strong' },
        { style: 'font-weight', getAttrs: (v) => /^(bold(er)?|[6-9]\d{2})$/.test(v) && null },
      ],
      toDOM: () => ['strong', 0],
    },

    em: {
      parseDOM: [
        { tag: 'i' }, { tag: 'em' },
        { style: 'font-style=italic' },
        { style: 'font-style=normal', clearMark: (m) => m.type.name === 'em' },
      ],
      toDOM: () => ['em', 0],
    },

    underline: {
      parseDOM: [
        { tag: 'u' },
        { style: 'text-decoration', getAttrs: (v) => v.includes('underline') && null },
        { style: 'text-decoration-line', getAttrs: (v) => v.includes('underline') && null },
      ],
      toDOM: () => ['u', 0],
    },

    strike: {
      parseDOM: [
        { tag: 's' }, { tag: 'del' }, { tag: 'strike' },
        { style: 'text-decoration', getAttrs: (v) => v.includes('line-through') && null },
        { style: 'text-decoration-line', getAttrs: (v) => v.includes('line-through') && null },
      ],
      toDOM: () => ['s', 0],
    },

    code: {
      excludes: '_',
      code: true,
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0],
    },

    // Colors are names, not values, so they can be redrawn for the dark theme.
    color: {
      attrs: { color: {} },
      parseDOM: [{ tag: 'span[class*="tc-"]', getAttrs: (dom) => { const c = colorFromClass(dom, 'tc-'); return c ? { color: c } : false; } }],
      toDOM: (mark) => ['span', { class: 'tc-' + mark.attrs.color }, 0],
    },

    highlight: {
      attrs: { color: { default: 'yellow' } },
      parseDOM: [
        { tag: 'mark', getAttrs: (dom) => ({ color: colorFromClass(dom, 'hl-') || 'yellow' }) },
      ],
      toDOM: (mark) => ['mark', { class: 'hl-' + mark.attrs.color }, 0],
    },
  },
});
