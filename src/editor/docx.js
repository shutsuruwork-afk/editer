// Word (.docx) export and import, entirely in the browser. The package is a ZIP file written and
// read here (DEFLATE through CompressionStream / DecompressionStream); the XML parts are built as
// text on export and read back with DOMParser on import.
import { TableMap } from 'prosemirror-tables';
import { schema, BASE_PT, safeHref } from './schema.js';
import { TEXT_HEX, HIGHLIGHT_HEX, CELL_HEX, nearestColor } from './palette.js';

const N = schema.nodes;
const M = schema.marks;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const READ_ERROR = 'Word ファイルを読み込めませんでした';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// "Strict" Open XML uses other namespaces for the same elements
const W_STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const R_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const V_NS = 'urn:schemas-microsoft-com:vml';
const O_NS = 'urn:schemas-microsoft-com:office:office';
const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

// Page geometry in twips (1/20 pt): A4 with 1 inch margins.
const PAGE_W = 11906, PAGE_H = 16838, MARGIN = 1440;
const TEXT_W = PAGE_W - 2 * MARGIN, TEXT_H = PAGE_H - 2 * MARGIN;
const STEP = 720; // one indent level (36pt), as in Docs and Word
const QUOTE_STEP = 360;
const EMU_TW = 635, EMU_PX = 9525;
const LINE_TW = { 1: 240, 1.15: 276, 1.5: 360, 2: 480 };
// What the editor's CSS draws for lists without a style, by nesting depth.
const LIST_DEFAULT = { bullet: ['disc', 'circle', 'square'], ordered: ['decimal', 'lower-alpha', 'lower-roman'] };
const BULLET_CHAR = { disc: '•', circle: '◦', square: '▪', dash: '–' };
const NUM_FMT = { decimal: 'decimal', 'lower-alpha': 'lowerLetter', 'upper-alpha': 'upperLetter', 'lower-roman': 'lowerRoman', 'upper-roman': 'upperRoman', 'cjk-ideographic': 'japaneseCounting' };
const FONT = { sans: ['Yu Gothic', '游ゴシック'], serif: ['Yu Mincho', '游明朝'], mono: ['Consolas', 'MS Gothic'] };
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '') // not allowed in XML at all
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sum = (a) => a.reduce((s, v) => s + v, 0);

// ---------- images ----------

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return '';
}

// Natural size from the file header, for loaders that do not report it.
function imageSize(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    switch (sniff(b)) {
      case 'image/png': return [v.getUint32(16), v.getUint32(20)];
      case 'image/gif': return [v.getUint16(6, true), v.getUint16(8, true)];
      case 'image/bmp': return [Math.abs(v.getInt32(18, true)), Math.abs(v.getInt32(22, true))];
      case 'image/webp': {
        const t = ascii(b, 12, 4);
        if (t === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
        if (t === 'VP8L') { const n = v.getUint32(21, true); return [(n & 0x3fff) + 1, ((n >>> 14) & 0x3fff) + 1]; }
        if (t === 'VP8 ') return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
        break;
      }
      case 'image/jpeg':
        for (let i = 2; i + 9 < b.length;) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1];
          if (m === 0xff) { i++; continue; }
          // SOF markers carry the frame size; C4 (DHT), C8 and CC (DAC) do not
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [v.getUint16(i + 7), v.getUint16(i + 5)];
          i += m === 0x01 || (m >= 0xd0 && m <= 0xd8) ? 2 : 2 + v.getUint16(i + 2);
        }
        break;
      default:
    }
  } catch (e) { /* truncated header */ }
  return null;
}

// Word before Microsoft 365 shows nothing for WebP/SVG/AVIF, so those are redrawn as PNG or JPEG.
async function toWordImage(img) {
  const type = sniff(img.bytes) || String(img.type || '').toLowerCase();
  if (/^image\/(png|jpeg|gif)$/.test(type) || typeof document === 'undefined') return { ...img, type };
  const url = URL.createObjectURL(new Blob([img.bytes], { type }));
  try {
    const el = new Image();
    el.src = url;
    await el.decode();
    const w = Math.round(img.width || el.naturalWidth) || 600, h = Math.round(img.height || el.naturalHeight) || 400;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(el, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    let alpha = false;
    for (let i = 3, step = 4 * Math.max(1, Math.floor((w * h) / 40000)); i < px.length && !alpha; i += step) alpha = px[i] < 250;
    const blob = await new Promise((r) => canvas.toBlob(r, alpha ? 'image/png' : 'image/jpeg', 0.9));
    if (blob) return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type, width: w, height: h };
  } catch (e) { /* keep the original bytes */ } finally {
    URL.revokeObjectURL(url);
  }
  return { ...img, type };
}

function fromBase64(s) {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Used when the caller gives no loader: data: URLs and plain https: images.
async function loadBuiltin(src) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src);
  if (m) return { bytes: m[2] ? fromBase64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])), type: m[1] };
  if (!/^https:/i.test(src)) return null;
  const res = await fetch(src);
  return res.ok ? { bytes: new Uint8Array(await res.arrayBuffer()), type: (res.headers.get('content-type') || '').split(';')[0] } : null;
}

// ---------- ZIP ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  let cs;
  try { cs = new CompressionStream('deflate-raw'); } catch (e) { return null; } // missing, or no raw format
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}

// files: [{ name, data: string | Uint8Array, stored?: true }] (stored: already compressed, e.g. images)
async function zip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], dir = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(raw);
    let data = raw, method = 0;
    if (!f.stored && raw.length > 64) {
      const packed = await deflateRaw(raw);
      if (packed && packed.length < raw.length) { data = packed; method = 8; }
    }
    // the fields shared by the local header (from offset 4) and the central directory (from 6)
    const common = (v, at) => {
      v.setUint16(at, 20, true); // version needed
      v.setUint16(at + 2, 0x0800, true); // UTF-8 names
      v.setUint16(at + 4, method, true);
      v.setUint16(at + 6, time, true);
      v.setUint16(at + 8, date, true);
      v.setUint32(at + 10, crc, true);
      v.setUint32(at + 14, data.length, true);
      v.setUint32(at + 18, raw.length, true);
      v.setUint16(at + 22, name.length, true);
    };
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    common(lv, 4);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    common(cv, 6);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(local, data);
    dir.push(central);
    offset += local.length + data.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, sum(dir.map((d) => d.length)), true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...dir, end], { type: DOCX_MIME });
}

const u64 = (v, at) => v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32;

function readZip(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let end = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  let count = v.getUint16(end + 10, true), at = v.getUint32(end + 16, true);
  if (end >= 20 && v.getUint32(end - 20, true) === 0x07064b50) { // ZIP64
    const z = u64(v, end - 12);
    if (v.getUint32(z, true) === 0x06064b50) { count = u64(v, z + 32); at = u64(v, z + 48); }
  }
  const dec = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip directory');
    const flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true);
    let size = v.getUint32(at + 20, true), loc = v.getUint32(at + 42, true);
    const usize = v.getUint32(at + 24, true);
    const nl = v.getUint16(at + 28, true), xl = v.getUint16(at + 30, true), cl = v.getUint16(at + 32, true);
    for (let x = at + 46 + nl, stop = x + xl; x + 4 <= stop; x += 4 + v.getUint16(x + 2, true)) {
      if (v.getUint16(x, true) !== 1) continue;
      let p = x + 4; // ZIP64 extra field: only the values that overflowed, in this order
      if (usize === 0xffffffff) p += 8;
      if (size === 0xffffffff) { size = u64(v, p); p += 8; }
      if (loc === 0xffffffff) loc = u64(v, p);
    }
    const name = dec.decode(u8.subarray(at + 46, at + 46 + nl)).replace(/\\/g, '/');
    entries.set(name.toLowerCase(), { flags, method, size, loc });
    at += 46 + nl + xl + cl;
  }
  return async (path) => {
    const f = path && (entries.get(path.toLowerCase()) || entries.get(safeDecode(path).toLowerCase()));
    if (!f) return null;
    if (f.flags & 1) throw new Error('encrypted zip entry');
    const start = f.loc + 30 + v.getUint16(f.loc + 26, true) + v.getUint16(f.loc + 28, true);
    const data = u8.subarray(start, start + f.size);
    if (f.method === 0) return data;
    if (f.method === 8) return inflateRaw(data);
    throw new Error('unsupported zip method ' + f.method);
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// ---------- export ----------

const JC = { center: 'center', right: 'right', justify: 'both' };
const QUOTE_BORDER = '<w:left w:val="single" w:sz="18" w:space="8" w:color="C8CCD6"/>';
const RULE_BORDER = '<w:bottom w:val="single" w:sz="6" w:space="1" w:color="A0A4AE"/>';
const TABLE_BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFC4CC"/>`).join('');
const shd = (fill) => `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`;
const rFonts = ([latin, ea]) => `<w:rFonts w:ascii="${latin}" w:hAnsi="${latin}" w:eastAsia="${ea}"/>`;

// Child order inside w:pPr and w:rPr is fixed by the schema; Word rejects files that break it.
function pPr(o) {
  let x = '';
  if (o.style) x += `<w:pStyle w:val="${o.style}"/>`;
  if (o.numId) x += `<w:numPr><w:ilvl w:val="${o.ilvl}"/><w:numId w:val="${o.numId}"/></w:numPr>`;
  if (o.quote || o.rule) x += `<w:pBdr>${o.quote ? QUOTE_BORDER : ''}${o.rule ? RULE_BORDER : ''}</w:pBdr>`;
  if (o.line) x += `<w:spacing w:line="${o.line}" w:lineRule="auto"/>`;
  if (o.left > 0 || o.hanging) x += `<w:ind w:left="${o.left || 0}"${o.hanging ? ` w:hanging="${o.hanging}"` : ''}/>`;
  if (o.jc) x += `<w:jc w:val="${o.jc}"/>`;
  return x ? `<w:pPr>${x}</w:pPr>` : '';
}

function rPr(marks, style) {
  let fonts = '', b = '', i = '', strike = '', color = '', size = '', u = '', fill = '', va = '';
  for (const m of marks) {
    const a = m.attrs;
    switch (m.type) {
      case M.strong: b = '<w:b/><w:bCs/>'; break;
      case M.em: i = '<w:i/><w:iCs/>'; break;
      case M.strike: strike = '<w:strike/>'; break;
      case M.underline: u = '<w:u w:val="single"/>'; break;
      case M.sup: va = '<w:vertAlign w:val="superscript"/>'; break;
      case M.sub: va = '<w:vertAlign w:val="subscript"/>'; break;
      case M.code: style = 'VerbatimChar'; break;
      case M.link: style = style || 'Hyperlink'; break;
      case M.fontSize: { const hp = Math.round(a.size * 2); if (hp > 0) size = `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`; break; }
      case M.fontFamily: if (FONT[a.family]) fonts = rFonts(FONT[a.family]); break;
      case M.color: if (TEXT_HEX[a.color]) color = `<w:color w:val="${TEXT_HEX[a.color].toUpperCase()}"/>`; break;
      // run shading, not w:highlight: that one only knows 16 fixed colors
      case M.highlight: if (HIGHLIGHT_HEX[a.color]) fill = shd(HIGHLIGHT_HEX[a.color].toUpperCase()); break;
      default:
    }
  }
  const x = (style ? `<w:rStyle w:val="${style}"/>` : '') + fonts + b + i + strike + color + size + u + fill + va;
  return x ? `<w:rPr>${x}</w:rPr>` : '';
}

const runText = (s) => s.replace(/\r\n?/g, '\n').split(/(\t|\n)/).map((p) => (p === '\t' ? '<w:tab/>' : p === '\n' ? '<w:br/>' : p ? `<w:t xml:space="preserve">${esc(p)}</w:t>` : '')).join('');

/**
 * Builds a .docx file from a document.
 * loadImage(src) resolves to { bytes, type, width?, height? } or null (the image is then left out).
 */
export async function docToDocx(doc, { title = '', loadImage = loadBuiltin } = {}) {
  const rels = [];
  const rel = (type, target, external) => {
    const id = 'rId' + (rels.length + 1);
    rels.push(`<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return id;
  };
  rel('styles', 'styles.xml');
  rel('settings', 'settings.xml');
  rel('footnotes', 'footnotes.xml');

  // Images are loaded first so that the XML can then be written in one synchronous pass.
  const files = [], images = new Map(), srcs = new Set(), headings = [];
  let hasToc = false;
  doc.descendants((n) => {
    if (n.type === N.image && n.attrs.src) srcs.add(n.attrs.src);
    else if (n.type === N.heading) headings.push(n);
    else if (n.type === N.toc) hasToc = true;
  });
  for (const src of srcs) {
    let img = null;
    try { img = await loadImage(src); } catch (e) { img = null; }
    if (!img || !img.bytes || !img.bytes.byteLength) continue;
    img = await toWordImage({ ...img, bytes: img.bytes instanceof Uint8Array ? img.bytes : new Uint8Array(img.bytes) });
    const ext = IMAGE_EXT[img.type];
    if (!ext) continue;
    let w = img.width, h = img.height;
    if (!(w > 0 && h > 0)) [w, h] = imageSize(img.bytes) || [600, 400];
    const name = `image${images.size + 1}.${ext}`;
    files.push({ name: 'word/media/' + name, data: img.bytes, stored: true });
    images.set(src, { rid: rel('image', 'media/' + name), name, w, h });
  }

  const links = new Map();
  const linkRel = (href) => {
    // spaces and the like are not allowed in a URI; Word refuses such targets
    if (!links.has(href)) links.set(href, rel('hyperlink', href.replace(/[\s"<>\\^`{|}]/g, encodeURIComponent), true));
    return links.get(href);
  };
  const notes = [];
  const abstractIds = new Map(); // list format ('ordered:lower-alpha', 'bullet:disc', …) -> abstractNumId
  const nums = [];
  let pictures = 0, bookmarks = 0;

  function footnote(text) {
    const id = notes.length + 1;
    const lines = String(text || '').split('\n');
    notes.push(`<w:footnote w:id="${id}">${lines.map((line, i) => `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${i ? '' : '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>'}<w:r>${runText((i ? '' : ' ') + line)}</w:r></w:p>`).join('')}</w:footnote>`);
    return id;
  }

  function run(n) {
    if (n.isText) return `<w:r>${rPr(n.marks)}${runText(n.text)}</w:r>`;
    if (n.type === N.hard_break) return `<w:r>${rPr(n.marks)}<w:br/></w:r>`;
    if (n.type === N.footnote) {
      const marks = n.marks.filter((m) => m.type !== M.code && m.type !== M.link);
      return `<w:r>${rPr(marks, 'FootnoteReference')}<w:footnoteReference w:id="${footnote(n.attrs.text)}"/></w:r>`;
    }
    return '';
  }

  function inline(node) {
    let out = '', open = null;
    node.forEach((child) => {
      const lm = child.marks.find((m) => m.type === M.link);
      const href = (lm && safeHref(lm.attrs.href)) || null;
      if (href !== open) {
        if (open) out += '</w:hyperlink>';
        open = href && href.length > 1 ? href : null;
        if (open) out += open[0] === '#' ? `<w:hyperlink w:anchor="${esc(open.slice(1))}">` : `<w:hyperlink r:id="${linkRel(open)}" w:history="1">`;
      }
      out += run(child);
    });
    return open ? out + '</w:hyperlink>' : out;
  }

  // ctx: left = indent of this flow in twips, d = list depth, q = quote depth, ul / ol = enclosing
  // bullet / numbered lists (for the default markers), maxW = width of the page or cell,
  // cont = direct child of a list item, th = inside a header cell
  function para(node, ctx, o = {}) {
    const a = node.attrs, heading = node.type === N.heading;
    const style = o.style || (heading ? 'Heading' + Math.min(4, Math.max(1, a.level)) : ctx.q ? 'Quote' : ctx.cont ? 'ListParagraph' : ctx.th ? 'TableHeading' : '');
    let body = (o.prefix ? `<w:r><w:t xml:space="preserve">${o.prefix}</w:t></w:r>` : '') + inline(node);
    if (heading && hasToc) {
      const id = ++bookmarks; // the TOC entries link here
      body = `<w:bookmarkStart w:id="${id}" w:name="_Toc${id}"/>${body}<w:bookmarkEnd w:id="${id}"/>`;
    }
    const props = pPr({
      style, numId: o.numId, ilvl: o.ilvl, quote: ctx.q > 0, line: LINE_TW[a.lineHeight],
      left: (o.left == null ? ctx.left : o.left) + (a.indent || 0) * STEP, hanging: o.hanging, jc: JC[a.align],
    });
    return `<w:p>${props}${body}</w:p>`;
  }

  function list(node, ctx) {
    const kind = node.type === N.ordered_list ? 'ordered' : node.type === N.bullet_list ? 'bullet' : 'check';
    const ilvl = Math.min(ctx.d, 8), left = ctx.left + STEP;
    let numId = 0, hanging = 360;
    if (kind !== 'check') {
      let style = node.attrs.style;
      if (!(kind === 'ordered' ? NUM_FMT : BULLET_CHAR)[style]) style = LIST_DEFAULT[kind][Math.min(kind === 'ordered' ? ctx.ol : ctx.ul, 2)];
      const key = kind + ':' + style;
      if (!abstractIds.has(key)) abstractIds.set(key, abstractIds.size);
      // a w:num of its own per list, with a start override, so that every list restarts
      nums.push({ abs: abstractIds.get(key), ilvl, start: kind === 'ordered' ? Math.max(0, node.attrs.order | 0) : -1 });
      numId = nums.length;
      hanging = hangingFor(style);
    }
    const inner = { ...ctx, left, d: ctx.d + 1, ul: ctx.ul + (kind === 'ordered' ? 0 : 1), ol: ctx.ol + (kind === 'ordered' ? 1 : 0), cont: true };
    let out = '';
    node.forEach((item) => item.forEach((child, _, i) => {
      out += i === 0 && child.type === N.paragraph
        ? para(child, ctx, { style: 'ListParagraph', numId, ilvl, left, hanging, prefix: kind === 'check' ? (item.attrs.checked ? '☑ ' : '☐ ') : '' })
        : block(child, inner);
    }));
    return out;
  }

  function picture(node, ctx) {
    const img = images.get(node.attrs.src);
    if (!img) return '';
    const avail = Math.max(STEP, ctx.maxW - ctx.left) * EMU_TW, maxH = TEXT_H * EMU_TW;
    let cx, cy;
    if (node.attrs.width > 0) {
      cx = (avail * Math.min(100, node.attrs.width)) / 100;
      cy = (cx * img.h) / img.w;
    } else {
      cx = img.w * EMU_PX;
      cy = img.h * EMU_PX;
      if (cx > avail) { cy *= avail / cx; cx = avail; }
    }
    if (cy > maxH) { cx *= maxH / cy; cy = maxH; }
    cx = Math.max(1, Math.round(cx));
    cy = Math.max(1, Math.round(cy));
    const id = ++pictures, alt = esc(node.attrs.alt || '');
    const jc = node.attrs.align === 'left' || node.attrs.align === 'right' ? node.attrs.align : 'center';
    const props = pPr({ style: ctx.q ? 'Quote' : ctx.cont ? 'ListParagraph' : '', quote: ctx.q > 0, left: ctx.left, jc });
    return `<w:p>${props}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
      + `<wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
      + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${img.name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${img.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }

  function table(node, ctx) {
    const map = TableMap.get(node), cols = map.width;
    const avail = Math.max(1440, ctx.maxW - ctx.left);
    const px = new Array(cols).fill(0), seen = new Set();
    for (const pos of map.map) {
      if (seen.has(pos)) continue;
      seen.add(pos);
      const cw = node.nodeAt(pos).attrs.colwidth, r = map.findCell(pos);
      if (cw) for (let k = 0; k < r.right - r.left; k++) if (cw[k] > 0 && !px[r.left + k]) px[r.left + k] = cw[k];
    }
    // without any widths the table spans the page, as it does in the editor
    const fluid = px.every((v) => !v);
    let tw = px.map((v) => Math.round(v * 15));
    const missing = tw.filter((v) => !v).length;
    if (missing) {
      const share = Math.max(1200, Math.floor((avail - sum(tw)) / missing));
      tw = tw.map((v) => v || share);
    }
    const total = sum(tw);
    if (total > avail) tw = tw.map((v) => Math.floor((v * avail) / total));
    let head = 0; // leading rows of header cells repeat on every page
    while (head < node.childCount) {
      const row = node.child(head);
      let all = row.childCount > 0;
      row.forEach((c) => { if (c.type !== N.table_header) all = false; });
      if (!all) break;
      head++;
    }
    let rows = '';
    for (let r = 0; r < map.height; r++) {
      let cells = '';
      for (let c = 0; c < cols;) {
        const pos = map.map[r * cols + c], rect = map.findCell(pos), cell = node.nodeAt(pos);
        const span = rect.right - rect.left, w = sum(tw.slice(rect.left, rect.right));
        const bg = CELL_HEX[cell.attrs.background];
        const merge = rect.bottom - rect.top > 1 ? (rect.top === r ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>') : '';
        const props = `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${merge}${bg ? shd(bg.toUpperCase()) : ''}</w:tcPr>`;
        const inner = rect.top === r
          ? blocks(cell.content, { left: 0, d: 0, q: 0, ul: ctx.ul, ol: ctx.ol, maxW: Math.max(STEP, w - 216), cont: false, th: cell.type === N.table_header })
          : '';
        cells += `<w:tc>${props}${inner.endsWith('</w:p>') ? inner : inner + '<w:p/>'}</w:tc>`; // a cell has to end with a paragraph
        c = Math.max(rect.right, c + 1);
      }
      rows += `<w:tr>${r < head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
    }
    const width = fluid ? '<w:tblW w:w="5000" w:type="pct"/>' : `<w:tblW w:w="${sum(tw)}" w:type="dxa"/>`;
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>${width}${ctx.left ? `<w:tblInd w:w="${ctx.left}" w:type="dxa"/>` : ''}`
      + `<w:tblBorders>${TABLE_BORDERS}</w:tblBorders>${fluid ? '' : '<w:tblLayout w:type="fixed"/>'}`
      + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
      + `<w:tblGrid>${tw.map((v) => `<w:gridCol w:w="${v}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>`;
  }

  // A real TOC field. Its result already lists the headings (linked to bookmarks on them), so it
  // reads correctly before anyone updates the field; page numbers only appear after an update.
  function toc() {
    const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-4" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>';
    const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    let out = '<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:t>目次</w:t></w:r></w:p>';
    if (!headings.length) out += `<w:p>${begin}${end}</w:p>`;
    headings.forEach((h, i) => {
      const text = h.textContent.replace(/\s+/g, ' ').trim() || ' ';
      out += `<w:p><w:pPr><w:pStyle w:val="TOC${Math.min(4, Math.max(1, h.attrs.level))}"/></w:pPr>${i ? '' : begin}`
        + `<w:hyperlink w:anchor="_Toc${i + 1}" w:history="1"><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:hyperlink>${i === headings.length - 1 ? end : ''}</w:p>`;
    });
    return `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>${out}</w:sdtContent></w:sdt>`;
  }

  function block(n, ctx) {
    switch (n.type) {
      case N.paragraph: case N.heading: return para(n, ctx);
      case N.blockquote: return blocks(n.content, { ...ctx, left: ctx.left + QUOTE_STEP, q: ctx.q + 1, cont: false });
      case N.code_block: {
        const text = n.textContent;
        return `<w:p>${pPr({ style: 'SourceCode', quote: ctx.q > 0, left: ctx.left })}${text ? `<w:r>${runText(text)}</w:r>` : ''}</w:p>`;
      }
      case N.horizontal_rule: return `<w:p>${pPr({ rule: true, quote: ctx.q > 0, left: ctx.left })}</w:p>`;
      case N.page_break: return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      case N.toc: return toc();
      case N.bullet_list: case N.ordered_list: case N.checklist: return list(n, ctx);
      case N.image: return picture(n, ctx);
      case N.table: return table(n, ctx);
      default: return n.isTextblock ? para(n, ctx) : '';
    }
  }

  function blocks(frag, ctx) {
    let out = '';
    frag.forEach((n) => {
      const x = block(n, ctx);
      if (x.startsWith('<w:tbl>') && out.endsWith('</w:tbl>')) out += '<w:p/>'; // Word joins adjacent tables
      out += x;
    });
    return out;
  }

  let body = blocks(doc.content, { left: 0, d: 0, q: 0, ul: 0, ol: 0, maxW: TEXT_W, cont: false, th: false });
  if (!body.endsWith('</w:p>')) body += '<w:p/>';
  const document = XML_HEAD
    + `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<w:body>${body}<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>`
    + `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="720" w:footer="720" w:gutter="0"/>`
    + '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>';

  if (nums.length) rel('numbering', 'numbering.xml');
  const exts = new Set(files.map((f) => f.name.split('.').pop()));
  const types = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + [...exts].map((e) => `<Default Extension="${e}" ContentType="${Object.keys(IMAGE_EXT).find((t) => IMAGE_EXT[t] === e)}"/>`).join('')
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
    + (nums.length ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : '')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${esc(title || '')}</dc:title><dc:language>ja-JP</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
  const app = XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Editer</Application></Properties>';
  const footnotes = XML_HEAD + `<w:footnotes xmlns:w="${W_NS}" xmlns:r="${R_NS}">`
    + '<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>'
    + '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
    + notes.join('') + '</w:footnotes>';
  const out = [
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>`
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + `<Relationship Id="rId3" Type="${R_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>` },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/settings.xml', data: SETTINGS },
    { name: 'word/footnotes.xml', data: footnotes },
  ];
  if (nums.length) out.push({ name: 'word/numbering.xml', data: numberingXml(abstractIds, nums) });
  return zip(out.concat(files));
}

// "一、" is two full-width characters, wider than the usual 18pt hanging indent
const hangingFor = (style) => (style === 'cjk-ideographic' ? 480 : 360);

function numberingXml(abstractIds, nums) {
  let abs = '';
  for (const [key, id] of abstractIds) {
    const [kind, style] = key.split(':');
    let lvls = '';
    for (let i = 0; i < 9; i++) {
      const fmt = kind === 'bullet' ? 'bullet' : NUM_FMT[style];
      const text = kind === 'bullet' ? BULLET_CHAR[style] : `%${i + 1}${style === 'cjk-ideographic' ? '、' : '.'}`;
      lvls += `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
        + `<w:pPr><w:ind w:left="${STEP * (i + 1)}" w:hanging="${hangingFor(style)}"/></w:pPr>`
        + (kind === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr>' : '') + '</w:lvl>';
    }
    abs += `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`;
  }
  const list = nums.map((n, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${n.abs}"/>${n.start >= 0 ? `<w:lvlOverride w:ilvl="${n.ilvl}"><w:startOverride w:val="${n.start}"/></w:lvlOverride>` : ''}</w:num>`);
  return XML_HEAD + `<w:numbering xmlns:w="${W_NS}">${abs}${list.join('')}</w:numbering>`;
}

const SETTINGS = XML_HEAD + `<w:settings xmlns:w="${W_NS}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>`
  + '<w:characterSpacingControl w:val="doNotCompress"/><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>'
  + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
  + '<w:themeFontLang w:val="en-US" w:eastAsia="ja-JP"/><w:decimalSymbol w:val="."/><w:listSeparator w:val=","/></w:settings>';

function stylesXml() {
  const style = (type, id, name, body, flag = '') => `<w:style w:type="${type}"${flag} w:styleId="${id}"><w:name w:val="${name}"/>${body}</w:style>`;
  const DEFAULT = ' w:default="1"', CUSTOM = ' w:customStyle="1"';
  const size = (hp) => `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`;
  const mono = rFonts(FONT.mono);
  const headings = [[40, 360], [32, 280], [26, 240], [22, 200]].map(([hp, before], i) => style('paragraph', 'Heading' + (i + 1), 'heading ' + (i + 1),
    `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${i}"/></w:pPr>`
    + `<w:rPr><w:b/><w:bCs/>${i === 3 ? '<w:color w:val="4B5563"/>' : ''}${size(hp)}</w:rPr>`));
  const tocs = [1, 2, 3, 4].map((n) => style('paragraph', 'TOC' + n, 'toc ' + n,
    `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="60"/><w:ind w:left="${(n - 1) * 220}"/></w:pPr>`));
  return XML_HEAD + `<w:styles xmlns:w="${W_NS}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr>${rFonts(FONT.sans)}${size(BASE_PT * 2)}<w:lang w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    // spacing lives here rather than in Normal so that the table style can take it away in cells
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + style('paragraph', 'Normal', 'Normal', '<w:qFormat/>', DEFAULT)
    + style('character', 'DefaultParagraphFont', 'Default Paragraph Font', '<w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/>', DEFAULT)
    + style('table', 'TableNormal', 'Normal Table', '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>', DEFAULT)
    + style('numbering', 'NoList', 'No List', '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>', DEFAULT)
    + headings.join('')
    + style('paragraph', 'Quote', 'Quote', `<w:basedOn w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr>${QUOTE_BORDER}</w:pBdr><w:ind w:left="${QUOTE_STEP}"/></w:pPr><w:rPr><w:color w:val="4B5563"/></w:rPr>`)
    // named as pandoc names it, so that pandoc reads these paragraphs back as code
    + style('paragraph', 'SourceCode', 'Source Code', `<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>${shd('F3F5F8')}<w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr>${mono}${size(20)}</w:rPr>`, CUSTOM)
    + style('paragraph', 'ListParagraph', 'List Paragraph', `<w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="${STEP}"/><w:contextualSpacing/></w:pPr>`)
    + style('paragraph', 'TableHeading', 'Table Heading', '<w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:bCs/></w:rPr>', CUSTOM)
    + style('paragraph', 'FootnoteText', 'footnote text', `<w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr>${size(18)}</w:rPr>`)
    + style('character', 'FootnoteReference', 'footnote reference', '<w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>')
    + style('character', 'Hyperlink', 'Hyperlink', `<w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="${TEXT_HEX.blue.toUpperCase()}"/><w:u w:val="single"/></w:rPr>`)
    + style('character', 'VerbatimChar', 'Verbatim Char', `<w:rPr>${mono}${shd('EEF0F3')}</w:rPr>`, CUSTOM)
    + style('paragraph', 'TOCHeading', 'TOC Heading', `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="9"/></w:pPr><w:rPr><w:b/><w:bCs/>${size(28)}</w:rPr>`)
    + tocs.join('')
    + style('table', 'TableGrid', 'Table Grid', `<w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${TABLE_BORDERS}</w:tblBorders></w:tblPr>`)
    + '</w:styles>';
}

// ---------- import ----------

const isW = (e) => e.namespaceURI === W_NS || e.namespaceURI === W_STRICT;
const wkids = (e, name) => (e ? Array.prototype.filter.call(e.children, (c) => isW(c) && (!name || c.localName === name)) : []);
function wkid(e, name) {
  if (e) for (const c of e.children) if (isW(c) && c.localName === name) return c;
  return null;
}
const wval = (e, name = 'val') => (e ? e.getAttributeNS(W_NS, name) ?? e.getAttributeNS(W_STRICT, name) : null);
const rid = (e, name) => e.getAttributeNS(R_NS, name) ?? e.getAttributeNS(R_STRICT, name);
const on = (e) => !!e && !/^(0|false|off)$/i.test(wval(e) || '');
const hex = (v) => (/^[0-9a-f]{6}$/i.test(v || '') ? v : null);
function side(bdr, s) {
  const e = wkid(bdr, s);
  return e ? !/^(nil|none)$/i.test(wval(e) || '') : null;
}
// Fallback is the older markup (VML, w:sym, plain text) that every producer writes and we understand.
function altContent(ac) {
  const kids = Array.from(ac.children);
  return kids.find((c) => c.localName === 'Fallback') || kids.find((c) => c.localName === 'Choice') || null;
}
function inTextBox(e, stop) {
  for (let p = e.parentNode; p && p !== stop; p = p.parentNode) if (p.localName === 'txbxContent') return true;
  return false;
}

const ALIGN_IN = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };
const ORDER_STYLE = { decimal: 'decimal', decimalZero: 'decimal', lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman' };
const HIGHLIGHT_NAMES = { yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF', blue: '0000FF', red: 'FF0000', darkBlue: '00008B', darkCyan: '008B8B', darkGreen: '006400', darkMagenta: '800080', darkRed: '8B0000', darkYellow: '808000', darkGray: 'A9A9A9', lightGray: 'D3D3D3' };
// Wingdings / Symbol code points used for check boxes and bullets
const SYMBOLS = { f0a8: '☐', f06f: '☐', f0fe: '☑', f0fd: '☒', f078: '☒', f0b7: '•', f0a7: '▪' };
const MONO_FONT = /mono|courier|consolas|menlo|monaco|lucida console|inconsolata|source code|fira code|\bcode\b|等幅/i;
const SERIF_FONT = /mincho|明朝|serif|times|georgia|garamond|cambria|century|palatino|book antiqua|minion|batang|song|宋/i;

function fontClass(el) {
  const names = el ? ['eastAsia', 'ascii', 'hAnsi'].map((a) => wval(el, a)).filter(Boolean) : [];
  if (!names.length) return null;
  if (names.some((f) => MONO_FONT.test(f))) return 'mono';
  return SERIF_FONT.test(names[0]) && !/sans|gothic|ゴシック/i.test(names[0]) ? 'serif' : 'sans';
}
const colorful = (h) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return Math.max(r, g, b) > 0x40 && Math.min(r, g, b) < 0xf0; // black-ish and white-ish text stays plain
};
function indLeft(el) {
  if (!el) return null;
  const v = wval(el, 'left') ?? wval(el, 'start');
  return v != null ? +v || 0 : null;
}
function lineOf(el) {
  const rule = wval(el, 'lineRule'), line = +wval(el, 'line');
  return line > 0 && (!rule || rule === 'auto') ? line : null;
}
function nearestLine(tw) {
  let best = null, d = 0.1;
  for (const k of Object.keys(LINE_TW)) if (Math.abs(tw / 240 - k) <= d) { d = Math.abs(tw / 240 - k); best = k; }
  return best;
}
function decodeText(b) {
  const enc = b[0] === 0xff && b[1] === 0xfe ? 'utf-16le' : b[0] === 0xfe && b[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(enc).decode(b);
}
function resolvePath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = dir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

/** Reads a .docx file (ArrayBuffer, typed array or Blob) into { doc, title }. */
export async function docxToDoc(input) {
  try {
    return await readDocx(input);
  } catch (e) {
    if (e && e.docx) throw e;
    const err = new Error(READ_ERROR);
    err.cause = e;
    throw err;
  }
}

async function readDocx(input) {
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(typeof input.arrayBuffer === 'function' ? await input.arrayBuffer() : input);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    // an OLE container: Word 97-2003 or an encrypted .docx
    const e = new Error(READ_ERROR + '（古い .doc 形式やパスワード付きのファイルには対応していません）');
    e.docx = true;
    throw e;
  }
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream is not available');
  const read = readZip(bytes);
  const xml = async (path) => {
    const b = path ? await read(path) : null;
    if (!b) return null;
    const d = new DOMParser().parseFromString(decodeText(b), 'application/xml');
    return d.getElementsByTagName('parsererror').length ? null : d;
  };
  const relsOf = async (path) => {
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    const d = await xml(dir + '_rels/' + path.slice(dir.length) + '.rels');
    const map = new Map();
    if (d) {
      for (const r of d.getElementsByTagNameNS('*', 'Relationship')) {
        const external = /^external$/i.test(r.getAttribute('TargetMode') || '');
        const target = r.getAttribute('Target') || '';
        map.set(r.getAttribute('Id'), { type: r.getAttribute('Type') || '', target: external ? target : resolvePath(dir, target), external });
      }
    }
    return map;
  };
  const find = (rels, type) => {
    for (const r of rels.values()) if (!r.external && r.type.endsWith('/' + type)) return r.target;
    return null;
  };
  const pkg = await relsOf('');
  const main = find(pkg, 'officeDocument') || 'word/document.xml';
  const dom = await xml(main);
  const body = dom && wkid(dom.documentElement, 'body');
  if (!body) throw new Error('no document body');
  const rels = await relsOf(main);
  const [styles, numbering, footnotes, endnotes, core] = await Promise.all([
    xml(find(rels, 'styles')), xml(find(rels, 'numbering')), xml(find(rels, 'footnotes')), xml(find(rels, 'endnotes')),
    xml(find(pkg, 'core-properties') || 'docProps/core.xml'),
  ]);
  const media = new Map();
  for (const [id, r] of rels) {
    if (r.external || !r.type.endsWith('/image')) continue;
    const b = await read(r.target).catch(() => null);
    const type = b && sniff(b);
    if (type && type !== 'image/bmp') media.set(id, `data:${type};base64,${toBase64(b)}`); // EMF, WMF, TIFF… are left out
  }
  const nodes = convert(body, { rels, styles, numbering, footnotes, endnotes, media });
  const doc = N.doc.create(null, nodes.length ? nodes : [N.paragraph.create()]);
  doc.check();
  const t = core && core.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
  return { doc, title: t ? t.textContent.trim() : '' };
}

function convert(body, { rels, styles: stylesDoc, numbering, footnotes, endnotes, media }) {
  // ----- styles -----
  const styles = new Map();
  let defP = null, docSz = 20, docLine = null, docFont = 'sans';
  if (stylesDoc) {
    const root = stylesDoc.documentElement;
    const dd = wkid(root, 'docDefaults');
    const rpd = wkid(wkid(dd, 'rPrDefault'), 'rPr');
    docSz = +wval(wkid(rpd, 'sz')) || 20;
    docLine = lineOf(wkid(wkid(wkid(dd, 'pPrDefault'), 'pPr'), 'spacing'));
    for (const s of wkids(root, 'style')) {
      const id = wval(s, 'styleId');
      styles.set(id, { id, name: (wval(wkid(s, 'name')) || id || '').toLowerCase(), basedOn: wval(wkid(s, 'basedOn')), pPr: wkid(s, 'pPr'), rPr: wkid(s, 'rPr') });
      if (wval(s, 'type') === 'paragraph' && /^(1|true|on)$/i.test(wval(s, 'default') || '')) defP = id;
    }
    const normal = styles.get(defP);
    docFont = fontClass(wkid(normal && normal.rPr, 'rFonts')) || fontClass(wkid(rpd, 'rFonts')) || 'sans';
  }
  function* chain(id) {
    for (let i = 0; id && i < 20; i++) {
      const s = styles.get(id);
      if (!s) return;
      yield s;
      id = s.basedOn;
    }
  }
  const pCache = new Map(), cCache = new Map();
  function pStyle(id) {
    let c = pCache.get(id || '');
    if (c) return c;
    c = { heading: null, sz: null, jc: null, left: null, line: null, pbb: null, numId: null, ilvl: null, bl: null, br: null, bb: null };
    const set = (k, v) => { if (c[k] == null && v != null) c[k] = v; };
    const names = [];
    for (const s of chain(id)) {
      const p = s.pPr;
      names.push(s.name);
      // the nearest outline level or "heading N" / "Title" name decides
      const ol = wval(wkid(p, 'outlineLvl')), m = /^(?:heading|見出し)\s*(\d)$/.exec(s.name);
      set('heading', ol != null ? (+ol < 9 ? +ol + 1 : 0) : m ? +m[1] : s.name === 'title' ? 1 : null);
      if (s.id !== defP) { // Japanese Word justifies Normal; that is the page default, not a format
        set('jc', wval(wkid(p, 'jc')));
        set('left', indLeft(wkid(p, 'ind')));
      }
      set('line', lineOf(wkid(p, 'spacing')));
      if (wkid(p, 'pageBreakBefore')) set('pbb', on(wkid(p, 'pageBreakBefore')));
      const np = wkid(p, 'numPr');
      if (np) { set('numId', wval(wkid(np, 'numId'))); set('ilvl', wval(wkid(np, 'ilvl'))); }
      const bd = wkid(p, 'pBdr');
      if (bd) { set('bl', side(bd, 'left')); set('br', side(bd, 'right')); set('bb', side(bd, 'bottom') ?? side(bd, 'top')); }
      const z = wval(wkid(s.rPr, 'sz'));
      if (z) set('sz', +z);
    }
    c.heading = Math.min(4, c.heading || 0);
    const all = names.join('\n');
    c.code = /\b(code|preformatted|verbatim|plain text|macro text|source text)\b/i.test(all);
    c.quote = /quot|引用|block ?text/i.test(all);
    c.listPara = /list (paragraph|continue)|リスト段落/i.test(all);
    c.th = /^table ?head(ing|er)$/im.test(all);
    c.hr = /horizontal ?line/i.test(all);
    pCache.set(id || '', c);
    return c;
  }
  function cStyle(id) {
    if (!id) return {};
    let c = cCache.get(id);
    if (c) return c;
    c = {};
    for (const s of chain(id)) {
      if (/verbatim|source text|\bcode\b|html (code|typewriter|keyboard|sample)/i.test(s.name) || fontClass(wkid(s.rPr, 'rFonts')) === 'mono') c.code = true;
      for (const k of ['b', 'i', 'strike']) if (c[k] == null && wkid(s.rPr, k)) c[k] = on(wkid(s.rPr, k));
      if (!c.va) c.va = wval(wkid(s.rPr, 'vertAlign'));
    }
    cCache.set(id, c);
    return c;
  }

  // ----- numbering -----
  const abstracts = new Map(), nums = new Map(), nCache = new Map(), counters = new Map();
  if (numbering) {
    const root = numbering.documentElement;
    for (const a of wkids(root, 'abstractNum')) abstracts.set(wval(a, 'abstractNumId'), a);
    for (const n of wkids(root, 'num')) {
      const o = {};
      for (const lo of wkids(n, 'lvlOverride')) {
        const so = wkid(lo, 'startOverride');
        o[+wval(lo, 'ilvl') || 0] = { start: so ? +wval(so) || 0 : null, lvl: wkid(lo, 'lvl') };
      }
      nums.set(wval(n, 'numId'), { abs: wval(wkid(n, 'abstractNumId')), o });
    }
  }
  function abstractLevel(absId, ilvl, depth = 0) {
    const a = abstracts.get(absId);
    if (!a || depth > 3) return null;
    for (const l of wkids(a, 'lvl')) if ((+wval(l, 'ilvl') || 0) === ilvl) return l;
    const s = styles.get(wval(wkid(a, 'numStyleLink'))); // the levels live with a numbering style
    const np = s && wkid(s.pPr, 'numPr');
    const num = np && nums.get(wval(wkid(np, 'numId')));
    return num ? abstractLevel(num.abs, ilvl, depth + 1) : null;
  }
  function numInfo(numId, ilvl) {
    const key = numId + ':' + ilvl;
    if (nCache.has(key)) return nCache.get(key);
    let info = null;
    const num = nums.get(numId);
    const ov = (num && num.o[ilvl]) || {};
    const lvl = num && (ov.lvl || abstractLevel(num.abs, ilvl));
    if (lvl) {
      let fe = wkid(lvl, 'numFmt');
      if (!fe) { // Word 2010+ wraps some formats in mc:AlternateContent
        const ac = Array.from(lvl.children).find((c) => c.localName === 'AlternateContent');
        fe = ac && wkid(altContent(ac), 'numFmt');
      }
      const fmt = wval(fe) || 'decimal', text = wval(wkid(lvl, 'lvlText')) || '';
      const sv = wval(wkid(lvl, 'start')), left = indLeft(wkid(wkid(lvl, 'pPr'), 'ind'));
      const start = ov.start != null ? ov.start : sv != null && sv !== '' ? +sv || 0 : 1;
      // a level without a visible marker (pandoc writes these) continues the item above
      if (fmt === 'none' || (fmt === 'bullet' && !text.trim())) info = { kind: 'blank', left };
      else if (fmt === 'bullet' || (text && !/%\d/.test(text))) info = { kind: 'bullet', style: bulletStyle(text), left };
      else info = { kind: 'ordered', style: ORDER_STYLE[fmt] || (/counting|ideograph|chinese|japanese|korean|taiwanese/i.test(fmt) ? 'cjk-ideographic' : 'decimal'), start, left };
    }
    nCache.set(key, info);
    return info;
  }
  function bulletStyle(text) {
    const c = text.trim().charAt(0);
    if (!c) return 'disc';
    if ('◦○o'.includes(c)) return 'circle';
    if ('▪■□\uf0a7\uf06e\uf06f'.includes(c)) return 'square'; // Wingdings squares too
    if ('–—-－\uf02d'.includes(c)) return 'dash';
    return 'disc';
  }
  // Word counts on across interruptions, so a list split by a paragraph keeps its numbers.
  function count(numId, ilvl, start) {
    let c = counters.get(numId);
    if (!c) counters.set(numId, (c = []));
    if (c.length > ilvl + 1) c.length = ilvl + 1;
    c[ilvl] = c[ilvl] == null ? start : c[ilvl] + 1;
    return c[ilvl];
  }

  // ----- footnotes -----
  function plain(el) {
    const paras = [];
    const walk = (e, acc) => {
      for (const c of e.children) {
        if (!isW(c)) {
          if (c.localName === 'AlternateContent') { const a = altContent(c); if (a) walk(a, acc); }
          continue;
        }
        const n = c.localName;
        if (n === 'p') { const a = []; walk(c, a); paras.push(a.join('')); }
        else if (n === 't') acc.push(c.textContent);
        else if (n === 'tab') acc.push('\t');
        else if (n === 'br' || n === 'cr') acc.push('\n');
        else if (!/^(del|moveFrom|instrText|delText|rPr|pPr)$/.test(n)) walk(c, acc);
      }
    };
    walk(el, []);
    return paras.join('\n').trim();
  }
  const notesOf = (d, tag) => {
    const m = new Map();
    if (d) for (const f of wkids(d.documentElement, tag)) if (!wval(f, 'type') || wval(f, 'type') === 'normal') m.set(wval(f, 'id'), plain(f));
    return m;
  };
  const fnotes = notesOf(footnotes, 'footnote'), enotes = notesOf(endnotes, 'endnote');

  // ----- sections: a section break that starts a new page becomes a page break -----
  const sects = Array.from(body.getElementsByTagNameNS('*', 'sectPr')).filter((s) => isW(s) && s.parentNode.localName !== 'sectPrChange');
  const breaks = new Set();
  sects.forEach((s, i) => {
    const next = sects[i + 1];
    if (next && s.parentNode.localName === 'pPr' && (wval(wkid(next, 'type')) || 'nextPage') !== 'continuous') breaks.add(s);
  });
  const sect = wkid(body, 'sectPr') || sects[sects.length - 1];
  const num = (v, d) => (v == null || v === '' || isNaN(+v) ? d : +v);
  const pgMar = wkid(sect, 'pgMar');
  let pageWidth = num(wval(wkid(sect, 'pgSz'), 'w'), PAGE_W) - num(wval(pgMar, 'left'), MARGIN) - num(wval(pgMar, 'right'), MARGIN);
  if (!(pageWidth > 1000)) pageWidth = TEXT_W;

  // ----- fields (HYPERLINK, TOC, …) can span runs and paragraphs -----
  const fields = [];
  const hidden = () => fields.some((f) => !f.sep || f.toc);
  const fieldHref = () => {
    for (let i = fields.length - 1; i >= 0; i--) if (fields[i].href) return fields[i].href;
    return null;
  };
  function fieldLink(instr) {
    const m = /^\s*HYPERLINK\b(.*)$/is.exec(instr || '');
    if (!m) return null;
    const tokens = m[1].match(/"[^"]*"|\S+/g) || [];
    for (let i = 0; i < tokens.length; i++) {
      if (/^\\[lotm]$/i.test(tokens[i])) { i++; continue; } // \l anchor, \o tooltip, … take an argument
      if (tokens[i][0] === '\\') continue;
      return safeHref(tokens[i].replace(/^"|"$/g, '')) || null;
    }
    return null;
  }
  function fieldChar(c, out) {
    const type = wval(c, 'fldCharType');
    if (type === 'begin') { fields.push({ instr: '', sep: false, toc: false, href: null }); return; }
    if (type !== 'separate' && type !== 'end') return;
    const f = type === 'end' ? fields.pop() : fields[fields.length - 1];
    if (!f || f.sep) return;
    f.sep = true;
    if (/^\s*TOC\b/i.test(f.instr)) {
      if (!fields.some((g) => g !== f && g.toc)) out.push({ block: N.toc.create() });
      f.toc = true; // its cached entries are not imported
    } else f.href = fieldLink(f.instr);
  }

  // ----- runs -----
  function runMarks(rPr, href, paraSz) {
    const cs = cStyle(wval(wkid(rPr, 'rStyle')));
    if (cs.code) return [M.code.create()];
    const flag = (n, d) => (wkid(rPr, n) ? on(wkid(rPr, n)) : !!d);
    const out = [];
    if (flag('b', cs.b)) out.push(M.strong.create());
    if (flag('i', cs.i)) out.push(M.em.create());
    const u = wkid(rPr, 'u');
    // links come underlined and blue from every producer; that is the link's look, not a format
    if (!href && u && !/^none$/i.test(wval(u) || '')) out.push(M.underline.create());
    if (flag('strike', cs.strike) || flag('dstrike')) out.push(M.strike.create());
    const va = wval(wkid(rPr, 'vertAlign')) || cs.va;
    if (va === 'superscript') out.push(M.sup.create());
    else if (va === 'subscript') out.push(M.sub.create());
    if (href) out.push(M.link.create({ href }));
    const sz = +wval(wkid(rPr, 'sz'));
    if (sz > 0 && sz !== paraSz) out.push(M.fontSize.create({ size: Math.min(400, Math.max(1, sz / 2)) }));
    const fc = fontClass(wkid(rPr, 'rFonts'));
    if (fc && fc !== docFont) out.push(M.fontFamily.create({ family: fc }));
    const color = !href && hex(wval(wkid(rPr, 'color')));
    if (color && colorful(color)) out.push(M.color.create({ color: nearestColor(color, TEXT_HEX) }));
    let hl = HIGHLIGHT_NAMES[wval(wkid(rPr, 'highlight'))];
    const sh = !hl && wkid(rPr, 'shd');
    if (sh) hl = hex(wval(sh) === 'solid' ? wval(sh, 'color') : wval(sh, 'fill'));
    if (hl && !/^f{6}$/i.test(hl)) out.push(M.highlight.create({ color: nearestColor(hl, HIGHLIGHT_HEX) }));
    let set = [];
    for (const m of out) set = m.addToSet(set);
    return set;
  }

  function symbol(e) {
    const code = (wval(e, 'char') || '').toLowerCase();
    if (SYMBOLS[code]) return SYMBOLS[code];
    const n = parseInt(code, 16);
    return n > 0x1f && n < 0xf000 ? String.fromCodePoint(n) : '';
  }

  function picture(el, out, width) {
    const ext = el.getElementsByTagNameNS(WP_NS, 'extent')[0];
    const pr = el.getElementsByTagNameNS(WP_NS, 'docPr')[0];
    const pos = el.getElementsByTagNameNS(WP_NS, 'positionH')[0];
    const al = pos && /^(left|center|right)$/.exec(((pos.getElementsByTagNameNS(WP_NS, 'align')[0] || {}).textContent || '').trim());
    for (const b of el.getElementsByTagNameNS(A_NS, 'blip')) {
      const src = !inTextBox(b, el) && media.get(rid(b, 'embed'));
      if (src) out.push({ img: { src, alt: pr ? pr.getAttribute('descr') || pr.getAttribute('title') || '' : '', cx: ext ? +ext.getAttribute('cx') : 0, align: al ? al[1] : null } });
    }
    // VML: older pictures and the fallback of shapes
    for (const im of el.getElementsByTagNameNS(V_NS, 'imagedata')) {
      const src = !inTextBox(im, el) && media.get(rid(im, 'id'));
      if (!src) continue;
      const shape = im.parentNode;
      const m = /(?:^|;)\s*width:\s*([\d.]+)\s*(pt|in|cm|mm|px)?/i.exec((shape.getAttribute && shape.getAttribute('style')) || '');
      const cx = m ? parseFloat(m[1]) * { pt: 12700, in: 914400, cm: 360000, mm: 36000, px: EMU_PX }[(m[2] || 'px').toLowerCase()] : 0;
      out.push({ img: { src, alt: im.getAttributeNS(O_NS, 'title') || (shape.getAttribute && shape.getAttribute('alt')) || '', cx, align: null } });
    }
    for (const r of el.getElementsByTagNameNS(V_NS, 'rect')) if (r.getAttributeNS(O_NS, 'hr') === 't') { out.push({ block: N.horizontal_rule.create() }); break; }
    // text boxes flow into the document after their paragraph
    for (const t of el.getElementsByTagNameNS('*', 'txbxContent')) if (isW(t) && !inTextBox(t, el)) out.push({ blocks: flow(t, width) });
  }

  function run(r, out, link, paraSz, width) {
    const rPr = wkid(r, 'rPr');
    const vanish = rPr && on(wkid(rPr, 'vanish'));
    let marks = null, marksFor;
    const mk = () => {
      const href = fieldHref() || link;
      if (!marks || marksFor !== href) { marks = runMarks(rPr, href, paraSz); marksFor = href; }
      return marks;
    };
    const text = (s) => { if (s) out.push(schema.text(s, mk())); };
    const each = (el) => {
      for (const c of el.children) {
        if (!isW(c)) {
          if (c.localName === 'AlternateContent') { const a = altContent(c); if (a) each(a); }
          continue;
        }
        const n = c.localName;
        if (n === 'fldChar') { fieldChar(c, out); continue; }
        if (n === 'instrText') { const f = fields[fields.length - 1]; if (f && !f.sep) f.instr += c.textContent; continue; }
        if (vanish || hidden()) continue;
        switch (n) {
          case 't': text(c.textContent); break;
          case 'tab': case 'ptab': text('\t'); break;
          case 'br':
            if (wval(c, 'type') === 'page') out.push({ block: N.page_break.create() });
            else out.push(N.hard_break.create(null, mk()));
            break;
          case 'cr': out.push(N.hard_break.create(null, mk())); break;
          case 'noBreakHyphen': text('-'); break;
          case 'sym': text(symbol(c)); break;
          case 'drawing': case 'pict': case 'object': picture(c, out, width); break;
          case 'footnoteReference': case 'endnoteReference':
            out.push(N.footnote.create({ text: (n === 'footnoteReference' ? fnotes : enotes).get(wval(c, 'id')) || '' }));
            break;
          default:
        }
      }
    };
    each(r);
  }

  function inlines(el, out, link, paraSz, width) {
    for (const c of el.children) {
      if (!isW(c)) {
        if (c.localName === 'AlternateContent') { const a = altContent(c); if (a) inlines(a, out, link, paraSz, width); }
        else if ((c.localName === 'oMath' || c.localName === 'oMathPara') && !hidden()) {
          const t = Array.from(c.getElementsByTagNameNS(MATH_NS, 't'), (x) => x.textContent).join('');
          if (t) out.push(schema.text(t)); // equations keep only their text
        }
        continue;
      }
      switch (c.localName) {
        case 'r': run(c, out, link, paraSz, width); break;
        case 'hyperlink': {
          const r = rels.get(rid(c, 'id'));
          const anchor = wval(c, 'anchor');
          const href = r && r.external ? safeHref(r.target + (anchor ? '#' + anchor : '')) : '';
          inlines(c, out, href || link, paraSz, width);
          break;
        }
        case 'fldSimple': {
          const instr = wval(c, 'instr') || '';
          if (/^\s*TOC\b/i.test(instr)) { if (!hidden()) out.push({ block: N.toc.create() }); }
          else inlines(c, out, fieldLink(instr) || link, paraSz, width);
          break;
        }
        case 'sdt': inlines(wkid(c, 'sdtContent') || c, out, link, paraSz, width); break;
        case 'ins': case 'moveTo': case 'smartTag': case 'customXml': case 'dir': case 'bdo':
          inlines(c, out, link, paraSz, width);
          break;
        default: // properties, bookmarks, comments, deleted text
      }
    }
  }

  // ----- paragraphs: each becomes one or more items for the structure builder -----
  const codeNode = (t) => N.code_block.create(null, t ? schema.text(t) : null);
  const pct = (cx, width) => (cx > 0 ? Math.max(1, Math.min(100, Math.round((cx / (width * EMU_TW)) * 1000) / 10)) : null);

  function paragraph(p, items, width) {
    const pPr = wkid(p, 'pPr');
    const d = (n) => wkid(pPr, n);
    const st = pStyle(wval(d('pStyle')) || defP);
    const was = hidden();
    const out = [];
    inlines(p, out, null, st.sz || docSz, width);
    const hid = was || hidden();

    const np = d('numPr');
    let numId = np && wval(wkid(np, 'numId')), ilvl = np && wval(wkid(np, 'ilvl'));
    if (numId == null) numId = st.numId;
    if (ilvl == null) ilvl = st.ilvl;
    ilvl = Math.min(8, +ilvl || 0);
    const ol = wval(d('outlineLvl'));
    const level = ol != null ? (+ol < 9 ? Math.min(4, +ol + 1) : 0) : st.heading;
    // numbered headings stay headings
    const numbering = !level && !st.code && numId && numId !== '0' ? numInfo(numId, ilvl) : null;
    const jc = wval(d('jc')) || st.jc;
    const indent = indLeft(d('ind'));
    const left = indent != null ? indent : numbering && numbering.left != null ? numbering.left : st.left || 0;
    const bd = d('pBdr');
    const pick = (s, k) => { const v = side(bd, s); return v != null ? v : st[k]; };
    const bl = pick('left', 'bl'), br = pick('right', 'br');
    let bb = side(bd, 'bottom');
    if (bb == null) bb = side(bd, 'top');
    if (bb == null) bb = st.bb;
    const pbb = d('pageBreakBefore') ? on(d('pageBreakBefore')) : st.pbb;
    const lv = lineOf(d('spacing'));
    const lineHeight = lv && lv !== (st.line || docLine) ? nearestLine(lv) : null;

    // "☐ " / "☑ " at the start makes a checklist item (also Wingdings boxes and content controls)
    let checked = null;
    if (!level && !st.code) {
      const i = out.findIndex((x) => x && !x.block && !x.img && !x.blocks);
      const t = out[i];
      const m = t && t.isText && /^\s*[☐☑☒]\s?/.exec(t.text);
      if (m) {
        checked = m[0].trim() !== '☐';
        const rest = t.text.slice(m[0].length);
        out[i] = rest ? schema.text(rest, t.marks) : null;
        const next = out[i + 1];
        if (!rest && next && next.isText && /^\s/.test(next.text)) {
          const r2 = next.text.replace(/^\s+/, '');
          out[i + 1] = r2 ? schema.text(r2, next.marks) : null;
        }
      }
    }

    const listish = !!numbering || checked != null || st.listPara;
    const quote = st.quote || (bl && !br);
    let q = 0;
    if (quote) {
      const prev = items[items.length - 1];
      if (listish) q = (prev && prev.q) || 1;
      else if (st.quote) q = 1 + Math.max(0, Math.round((left - (st.left || 0)) / QUOTE_STEP));
      else q = Math.max(1, Math.round(left / QUOTE_STEP));
      q = Math.min(q, 8);
    }
    const levelFromIndent = () => Math.max(0, Math.round((left - q * QUOTE_STEP) / STEP) - 1);
    let list = null, cont = null;
    if (numbering && numbering.kind !== 'blank') {
      const n = count(numId, ilvl, numbering.start);
      list = checked != null ? { level: ilvl, kind: 'check', checked } : { level: ilvl, kind: numbering.kind, numId, style: numbering.style, n };
    } else if (checked != null) list = { level: numbering ? ilvl : levelFromIndent(), kind: 'check', checked };
    else if (numbering) cont = ilvl;

    const attrs = { align: ALIGN_IN[jc] || null, indent: listish || q ? 0 : Math.max(0, Math.min(8, Math.round(left / STEP))), lineHeight };
    const groups = [];
    let cur = [];
    for (const x of out) {
      if (!x) continue;
      if (x.block || x.img || x.blocks) { groups.push(cur, x); cur = []; } else cur.push(x);
    }
    groups.push(cur);
    const solo = groups.length === 1;
    if (pbb && !hid) items.push({ node: N.page_break.create(), q });
    let first = true;
    // left and qi let the builder put indented blocks into the list item above them
    const qi = quote && !listish ? { style: st.quote ? st.left || 0 : null } : null;
    const push = (node, extra) => {
      items.push(Object.assign({ node, q, left, qi, listPara: st.listPara }, first ? { list, cont } : list || cont != null ? { cont: true } : null, extra));
      first = false;
    };
    for (const g of groups) {
      if (Array.isArray(g)) {
        const visible = g.some((n) => !n.isText || n.text.trim());
        if (!visible && (!solo || hid)) continue;
        if (st.code) {
          const t = g.map((n) => (n.isText ? n.text : n.type === N.hard_break ? '\n' : '')).join('');
          const prev = items[items.length - 1];
          // one paragraph per line (LibreOffice, Word) becomes one code block
          if (first && prev && prev.code != null && prev.q === q && prev.left === left && !prev.list) {
            prev.code += '\n' + t;
            prev.node = codeNode(prev.code);
            first = false;
          } else push(codeNode(t), { code: t });
        } else if (level) push(N.heading.create({ ...attrs, level }, g));
        else if (!visible && (bb || st.hr)) push(N.horizontal_rule.create());
        else push(N.paragraph.create(attrs, g));
      } else if (g.img) {
        const align = g.img.align || (jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left');
        push(N.image.create({ src: g.img.src, alt: g.img.alt, width: pct(g.img.cx, Math.max(STEP, width - Math.max(0, left))), align }));
      } else if (g.block) push(g.block);
      else g.blocks.forEach((n) => push(n));
    }
    const sp = d('sectPr');
    if (sp && breaks.has(sp)) items.push({ node: N.page_break.create(), q });
  }

  // ----- tables -----
  function table(tbl, width) {
    const fluid = wval(wkid(wkid(tbl, 'tblPr'), 'tblW'), 'type') === 'pct';
    const grid = wkids(wkid(tbl, 'tblGrid'), 'gridCol').map((g) => +wval(g, 'w') || 0);
    const wrapper = (n) => /^(sdt|customXml|ins|moveTo)$/.test(n);
    const trs = [];
    const rowsIn = (el) => {
      for (const c of wkids(el)) {
        if (c.localName === 'tr') trs.push(c);
        else if (wrapper(c.localName)) rowsIn(wkid(c, 'sdtContent') || c);
      }
    };
    rowsIn(tbl);
    const rows = trs.map((tr) => {
      const trPr = wkid(tr, 'trPr');
      const cells = [];
      let col = +wval(wkid(trPr, 'gridBefore')) || 0;
      if (col) cells.push({ col: 0, span: col });
      const cellsIn = (el) => {
        for (const c of wkids(el)) {
          if (c.localName === 'tc') {
            const pr = wkid(c, 'tcPr');
            const span = Math.max(1, +wval(wkid(pr, 'gridSpan')) || 1);
            const vm = wkid(pr, 'vMerge');
            cells.push({ tc: c, col, span, cont: !!vm && wval(vm) !== 'restart' });
            col += span;
          } else if (wrapper(c.localName)) cellsIn(wkid(c, 'sdtContent') || c);
        }
      };
      cellsIn(tr);
      return { head: on(wkid(trPr, 'tblHeader')), cells };
    });
    // a "continue" cell joins the cell above it in the same grid column
    rows.forEach((row, r) => row.cells.forEach((c) => {
      if (c.used) return;
      c.rowspan = 1;
      for (let k = r + 1; k < rows.length; k++) {
        const below = rows[k].cells.find((x) => x.cont && !x.used && x.col === c.col);
        if (!below) break;
        below.used = true;
        c.rowspan++;
      }
    }));
    const headCell = (tc) => {
      const ps = wkids(tc, 'p');
      return ps.length > 0 && ps.every((p) => pStyle(wval(wkid(wkid(p, 'pPr'), 'pStyle')) || defP).th);
    };
    const background = (tc) => {
      const s = wkid(wkid(tc, 'tcPr'), 'shd');
      const h = s && hex(wval(s) === 'solid' ? wval(s, 'color') : wval(s, 'fill'));
      return h && !/^f{6}$/i.test(h) ? nearestColor(h, CELL_HEX) : null;
    };
    const pm = rows.map((row) => row.cells.filter((c) => !c.used).map((c) => {
      const cols = grid.slice(c.col, c.col + c.span);
      const known = cols.length === c.span && cols.every((v) => v > 0);
      let content = c.tc ? flow(c.tc, known ? Math.max(STEP, sum(cols) - 216) : width) : [];
      if (!content.length) content = [N.paragraph.create()];
      const type = row.head || (c.tc && headCell(c.tc)) ? N.table_header : N.table_cell;
      return type.create({
        colspan: c.span, rowspan: c.rowspan || 1,
        colwidth: known && !fluid ? cols.map((v) => Math.round(v / 15)) : null,
        background: c.tc ? background(c.tc) : null,
      }, content);
    }));
    // rows have to cover the same number of columns
    const cover = pm.map(() => 0);
    let cols = 0;
    pm.forEach((cells, r) => {
      let n = cover[r];
      for (const c of cells) {
        n += c.attrs.colspan;
        for (let k = 1; k < c.attrs.rowspan && r + k < pm.length; k++) cover[r + k] += c.attrs.colspan;
      }
      cols = Math.max(cols, n);
    });
    if (!cols) return null;
    return N.table.create(null, pm.map((cells, r) => {
      for (let n = cover[r] + sum(cells.map((c) => c.attrs.colspan)); n < cols; n++) cells.push(N.table_cell.create(null, N.paragraph.create()));
      return N.table_row.create(null, cells);
    }));
  }

  // ----- block structure -----
  function blocksOf(el, items, width) {
    for (const c of el.children) {
      if (!isW(c)) {
        if (c.localName === 'AlternateContent') { const a = altContent(c); if (a) blocksOf(a, items, width); }
        continue;
      }
      const n = c.localName;
      if (n === 'p') paragraph(c, items, width);
      else if (n === 'tbl') {
        const t = !hidden() && table(c, width);
        const ind = wkid(wkid(c, 'tblPr'), 'tblInd');
        if (t) items.push({ node: t, left: ind && wval(ind, 'type') !== 'pct' ? +wval(ind, 'w') || 0 : 0 });
      } else if (n === 'sdt') {
        const gallery = wkid(wkid(wkid(c, 'sdtPr'), 'docPartObj'), 'docPartGallery');
        if (/table of contents/i.test(wval(gallery) || '')) items.push({ node: N.toc.create() });
        else blocksOf(wkid(c, 'sdtContent') || c, items, width);
      } else if (/^(customXml|ins|moveTo|smartTag)$/.test(n)) blocksOf(c, items, width);
    }
  }

  // A block indented to the text of an open list item belongs to that item; quotes inside it
  // and its indent count from the item's text.
  function attach(frame, it) {
    const item = frame.item, rel = (it.left || 0) - frame.left;
    let rq = 0;
    if (it.qi) rq = Math.min(8, it.qi.style != null ? 1 + Math.max(0, Math.round((rel - it.qi.style) / QUOTE_STEP)) : Math.max(1, Math.round(rel / QUOTE_STEP)));
    const qs = item.qs || (item.qs = [item]);
    while (qs.length - 1 > rq) qs.pop();
    while (qs.length - 1 < rq) {
      const b = { type: N.blockquote, attrs: null, kids: [] };
      qs[qs.length - 1].kids.push(b);
      qs.push(b);
    }
    let node = it.node;
    if (node.type === N.paragraph || node.type === N.heading) {
      const indent = rq ? 0 : Math.max(0, Math.min(8, Math.round(rel / STEP)));
      if (indent !== node.attrs.indent) node = node.type.create({ ...node.attrs, indent }, node.content, node.marks);
    }
    qs[rq].kids.push(node);
  }

  // Items are flat (Word has no nesting); quotes, lists and list items are rebuilt here.
  function build(items) {
    const root = { kids: [] };
    let quotes = [root], lists = [];
    for (const it of items) {
      if (!it.list && lists.length) {
        if (it.cont === true) { attach(lists[lists.length - 1], it); continue; } // the rest of a split list paragraph
        if (typeof it.cont === 'number') { // a numbering level without a marker
          while (lists.length > 1 && lists[lists.length - 1].level > it.cont) lists.pop();
          attach(lists[lists.length - 1], it);
          continue;
        }
        let k = lists.length - 1;
        while (k >= 0 && !(lists[k].left <= it.left + 40)) k--;
        if (k >= 0 || it.listPara) {
          lists.length = Math.max(k, 0) + 1;
          attach(lists[lists.length - 1], it);
          continue;
        }
      }
      const q = it.q || 0;
      if (q !== quotes.length - 1) {
        lists = [];
        while (quotes.length - 1 > q) quotes.pop();
        while (quotes.length - 1 < q) {
          const b = { type: N.blockquote, attrs: null, kids: [] };
          quotes[quotes.length - 1].kids.push(b);
          quotes.push(b);
        }
      }
      const host = quotes[quotes.length - 1];
      const L = it.list;
      if (L) {
        while (lists.length && lists[lists.length - 1].level > L.level) lists.pop();
        let top = lists[lists.length - 1];
        if (top && top.level === L.level && !(top.kind === L.kind && (L.kind === 'check' || top.numId === L.numId))) {
          lists.pop();
          top = lists[lists.length - 1];
        }
        if (!top || top.level < L.level) {
          const ordered = L.kind === 'ordered';
          const depth = Math.min(2, lists.filter((x) => (x.kind === 'ordered') === ordered).length);
          const style = L.kind === 'check' ? null : L.style === LIST_DEFAULT[L.kind][depth] ? null : L.style;
          const el = {
            type: ordered ? N.ordered_list : L.kind === 'bullet' ? N.bullet_list : N.checklist,
            attrs: ordered ? { order: L.n, style } : L.kind === 'bullet' ? { style } : null,
            kids: [],
          };
          (top ? top.item : host).kids.push(el);
          top = { level: L.level, kind: L.kind, numId: L.numId, el, item: null, left: 0 };
          lists.push(top);
        }
        top.left = it.left || 0;
        top.item = { type: L.kind === 'check' ? N.check_item : N.list_item, attrs: L.kind === 'check' ? { checked: L.checked } : null, kids: [it.node] };
        top.el.kids.push(top.item);
      } else {
        lists = [];
        host.kids.push(it.node);
      }
    }
    const finish = (kids) => kids.map((k) => {
      if (!k.kids) return k;
      const content = finish(k.kids);
      // list items have to start with a paragraph
      if ((k.type === N.list_item || k.type === N.check_item) && (!content.length || content[0].type !== N.paragraph)) content.unshift(N.paragraph.create());
      return k.type.create(k.attrs, content);
    });
    return finish(root.kids);
  }

  function flow(el, width) {
    const items = [];
    blocksOf(el, items, width);
    const nodes = build(items);
    // Word keeps an empty paragraph after a table that ends a cell or the document
    const last = nodes[nodes.length - 1];
    if (nodes.length > 1 && last.type === N.paragraph && !last.content.size && nodes[nodes.length - 2].type === N.table) nodes.pop();
    return nodes;
  }

  return flow(body, pageWidth);
}
