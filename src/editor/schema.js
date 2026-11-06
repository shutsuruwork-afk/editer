// The document structure. Every document is stored as ProseMirror JSON built from this schema,
// so anything added here has to stay readable by later versions: only add nodes, marks and
// attributes (with defaults), never rename or remove them.
import { Schema } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

export const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
export const ALIGNS = ['left', 'center', 'right', 'justify'];
export const LINE_HEIGHTS = ['1', '1.15', '1.5', '2'];
export const MAX_INDENT = 8;
// Font sizes are in points, as in Docs; 11pt is the normal text size and maps to the base size.
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
export const BASE_PT = 11;
export const FONTS = ['sans', 'serif', 'mono'];
export const BULLET_STYLES = ['disc', 'circle', 'square', 'dash'];
export const NUMBER_STYLES = ['decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman', 'cjk-ideographic'];

const SAFE_URL = /^(https?:|mailto:|tel:|#)/i;
export function safeHref(href) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (SAFE_URL.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return ''; // javascript:, data:, … are dropped
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(h)) return 'https://' + h; // "example.com/x"
  return '';
}
// "idb:<hash>" points at an image kept in this browser's image store (see src/app/images.js).
const SAFE_IMG = /^(data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);|https:|idb:[0-9a-z]+$)/i;
export const safeSrc = (src) => (SAFE_IMG.test(String(src || '')) ? String(src) : '');

// ---------- paragraph attributes: alignment, indentation, line spacing ----------

const blockAttrs = { align: { default: null }, indent: { default: 0 }, lineHeight: { default: null } };

const UNIT_PX = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, em: 16, rem: 16 };
function toPx(v) {
  const m = /^(-?[\d.]+)\s*([a-z%]*)$/i.exec(String(v || '').trim());
  if (!m) return 0;
  return parseFloat(m[1]) * (UNIT_PX[m[2].toLowerCase()] || (m[2] ? 0 : 1));
}

function readBlockAttrs(dom) {
  const a = (dom.style && dom.style.textAlign) || dom.getAttribute('align') || '';
  const align = a === 'start' ? null : a === 'end' ? 'right' : (ALIGNS.includes(a) && a !== 'left' ? a : null);
  let indent = parseInt(dom.getAttribute('data-indent') || '', 10);
  if (!(indent >= 0)) {
    // Docs and Word indent by 36pt (half an inch) per level
    const px = toPx(dom.style && (dom.style.marginLeft || dom.style.paddingLeft));
    indent = Math.round(px / 48);
  }
  indent = Math.max(0, Math.min(MAX_INDENT, indent || 0));
  let lh = dom.getAttribute('data-line-height') || (dom.style && dom.style.lineHeight) || '';
  if (lh === '100%') lh = '1';
  else if (lh === '115%') lh = '1.15';
  else if (lh === '150%') lh = '1.5';
  else if (lh === '200%') lh = '2';
  const lineHeight = LINE_HEIGHTS.includes(String(parseFloat(lh))) ? String(parseFloat(lh)) : null;
  return { align, indent, lineHeight };
}

function blockDOMAttrs(attrs) {
  const style = [];
  const out = {};
  if (attrs.align) style.push(`text-align:${attrs.align}`);
  if (attrs.indent) { style.push(`margin-left:${attrs.indent * 2}em`); out['data-indent'] = String(attrs.indent); }
  if (attrs.lineHeight) { style.push(`line-height:${attrs.lineHeight}`); out['data-line-height'] = attrs.lineHeight; }
  if (style.length) out.style = style.join(';');
  return out;
}

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

function listStyleFrom(dom, allowed, typeMap) {
  const t = dom.getAttribute('type');
  if (t && typeMap && typeMap[t]) return typeMap[t];
  const s = (dom.style && dom.style.listStyleType) || '';
  if (allowed.includes(s)) return s;
  return null;
}
const OL_TYPES = { 1: 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' };
export const listStyleCss = (style) => (style === 'dash' ? '"– "' : style);

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },

    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: blockAttrs,
      parseDOM: [{ tag: 'p', getAttrs: readBlockAttrs }],
      toDOM: (node) => ['p', blockDOMAttrs(node.attrs), 0],
    },

    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 }, ...blockAttrs },
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((n) => ({
        tag: 'h' + n,
        getAttrs: (dom) => ({ level: Math.min(n, 4), ...readBlockAttrs(dom) }),
      })),
      toDOM: (node) => ['h' + node.attrs.level, blockDOMAttrs(node.attrs), 0],
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

    // Starts a new page when printing or exporting to PDF / Word.
    page_break: {
      group: 'block',
      atom: true,
      selectable: true,
      parseDOM: [
        { tag: 'div[data-type="page-break"]' },
        // Docs pastes page breaks as <hr style="page-break-before:always">
        { tag: 'hr', priority: 60, getAttrs: (dom) => (/(page-)?break-(before|after)\s*:\s*(always|page)/i.test(dom.getAttribute('style') || '') ? null : false) },
      ],
      toDOM: () => ['div', { 'data-type': 'page-break', class: 'page-break' }],
    },

    // A table of contents built from the document's headings (drawn by a node view).
    toc: {
      group: 'block',
      atom: true,
      selectable: true,
      parseDOM: [{ tag: 'nav[data-type="toc"]' }],
      toDOM: () => ['nav', { 'data-type': 'toc', class: 'toc' }],
    },

    bullet_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { style: { default: null } },
      parseDOM: [{
        tag: 'ul',
        getAttrs: (dom) => (dom.dataset.type === 'checklist' ? false : { style: listStyleFrom(dom, ['circle', 'square']) }),
      }],
      toDOM: (node) => ['ul', node.attrs.style ? { style: `list-style-type:${listStyleCss(node.attrs.style)}`, 'data-style': node.attrs.style } : {}, 0],
    },

    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { order: { default: 1 }, style: { default: null } },
      parseDOM: [{
        tag: 'ol',
        getAttrs: (dom) => ({
          order: dom.hasAttribute('start') ? +dom.getAttribute('start') || 1 : 1,
          style: dom.getAttribute('data-style') || listStyleFrom(dom, NUMBER_STYLES, OL_TYPES),
        }),
      }],
      toDOM: (node) => {
        const a = {};
        if (node.attrs.order !== 1) a.start = node.attrs.order;
        if (node.attrs.style) { a.style = `list-style-type:${node.attrs.style}`; a['data-style'] = node.attrs.style; }
        return ['ol', a, 0];
      },
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
          const al = dom.dataset.align;
          return { src, alt: dom.getAttribute('alt') || '', width: w > 0 && w <= 100 ? w : null, align: al === 'left' || al === 'right' ? al : 'center' };
        },
      }],
      toDOM: (node) => {
        const { width, align } = node.attrs;
        const a = { src: safeSrc(node.attrs.src), alt: node.attrs.alt || '' };
        const style = ['display:block', 'max-width:100%', 'height:auto'];
        if (width) { a['data-width'] = String(width); style.push(`width:${width}%`); }
        if (align !== 'center') a['data-align'] = align;
        style.push(align === 'left' ? 'margin:0.4em auto 0.9em 0' : align === 'right' ? 'margin:0.4em 0 0.9em auto' : 'margin:0.4em auto 0.9em');
        a.style = style.join(';');
        return ['img', a];
      },
    },

    ...tables,

    text: { group: 'inline' },

    // A footnote reference; its text is kept on the node and listed at the end of the document.
    footnote: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      attrs: { text: { default: '' } },
      parseDOM: [{ tag: 'sup[data-footnote]', priority: 60, getAttrs: (dom) => ({ text: dom.getAttribute('data-footnote') || '' }) }],
      toDOM: (node) => ['sup', { class: 'footnote', 'data-footnote': node.attrs.text }],
      leafText: () => '',
    },

    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
      leafText: () => '\n',
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

    sup: {
      excludes: 'sup sub',
      parseDOM: [{ tag: 'sup' }, { style: 'vertical-align', getAttrs: (v) => (v === 'super' ? null : false) }],
      toDOM: () => ['sup', 0],
    },

    sub: {
      excludes: 'sup sub',
      parseDOM: [{ tag: 'sub' }, { style: 'vertical-align', getAttrs: (v) => (v === 'sub' ? null : false) }],
      toDOM: () => ['sub', 0],
    },

    code: {
      excludes: '_',
      code: true,
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0],
    },

    // Point sizes relative to the 11pt normal text, drawn against the base size (--fs) so they
    // look the same inside headings.
    fontSize: {
      attrs: { size: {} },
      parseDOM: [
        { tag: 'span[data-size]', getAttrs: (dom) => { const s = parseFloat(dom.dataset.size); return s >= 1 && s <= 400 ? { size: s } : false; } },
        // only point sizes, which is what Docs and Word paste; web pages use px and stay as they are
        {
          style: 'font-size',
          getAttrs: (v) => {
            const m = /^([\d.]+)pt$/.exec(v.trim());
            if (!m) return false;
            const s = Math.round(parseFloat(m[1]) * 2) / 2;
            return s >= 1 && s <= 400 && Math.abs(s - BASE_PT) >= 0.5 ? { size: s } : false;
          },
        },
      ],
      toDOM: (mark) => ['span', { 'data-size': String(mark.attrs.size), style: `font-size:calc(var(--fs, 16px) * ${+(mark.attrs.size / BASE_PT).toFixed(4)})` }, 0],
    },

    fontFamily: {
      attrs: { family: {} },
      parseDOM: [
        { tag: 'span[data-font]', getAttrs: (dom) => (FONTS.includes(dom.dataset.font) ? { family: dom.dataset.font } : false) },
        {
          style: 'font-family',
          getAttrs: (v) => {
            if (/mono|courier|consolas|menlo|code/i.test(v)) return { family: 'mono' };
            if (/mincho|明朝|serif(?!.*sans)|times|georgia|garamond|cambria/i.test(v) && !/sans/i.test(v)) return { family: 'serif' };
            return false;
          },
        },
      ],
      toDOM: (mark) => ['span', { 'data-font': mark.attrs.family, class: 'ff-' + mark.attrs.family }, 0],
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

// Marks that "書式をクリア" removes and "書式のコピー" carries over (links are content, not format).
export const FORMAT_MARKS = ['strong', 'em', 'underline', 'strike', 'sup', 'sub', 'code', 'fontSize', 'fontFamily', 'color', 'highlight'];
