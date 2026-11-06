// Moving documents in and out: Markdown, HTML and plain text.
import { DOMParser as PMDOMParser, DOMSerializer } from 'prosemirror-model';
import { MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';
import { schema } from './schema.js';
import { TEXT_HEX, HIGHLIGHT_HEX, CELL_HEX } from './palette.js';

const N = schema.nodes;

// ---------- reading ----------

const parser = PMDOMParser.fromSchema(schema);

export function fromHtml(html) {
  const dom = new window.DOMParser().parseFromString(html, 'text/html');
  // Docs/Word put page styles in <style>, comments etc.; only the body matters
  return parser.parse(dom.body);
}

// Raw HTML in Markdown is allowed: it only ever goes through the schema's parser (DOMParser
// documents never run scripts or load anything), so unknown tags are simply dropped.
const md = new MarkdownIt('default', { html: true, linkify: true, breaks: false });

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fromMarkdown(text) {
  // footnotes: "[^1]" references and "[^1]: text" definitions
  const notes = new Map();
  text = text.replace(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm, (_, id, body) => { notes.set(id, body.trim()); return ''; });
  if (notes.size) {
    text = text.replace(/\[\^([^\]\s]+)\](?!:)/g, (m, id) => (notes.has(id) ? `<sup data-footnote="${escAttr(notes.get(id))}"></sup>` : m));
  }
  const html = md.render(text);
  const dom = new window.DOMParser().parseFromString(html, 'text/html');
  // "[TOC]" on its own line becomes a table of contents
  for (const p of dom.querySelectorAll('p')) {
    if (/^\s*\[(TOC|toc|目次)\]\s*$/.test(p.textContent) && !p.children.length) {
      const nav = dom.createElement('nav');
      nav.dataset.type = 'toc';
      p.replaceWith(nav);
    }
  }
  // "- [ ] task" / "- [x] done" become checklists
  for (const ul of dom.querySelectorAll('ul')) {
    const items = Array.from(ul.children).filter((li) => li.tagName === 'LI');
    const marker = (li) => {
      const first = li.firstChild && li.firstChild.nodeType === 1 && li.firstChild.tagName === 'P' ? li.firstChild : li;
      const t = first.firstChild;
      return t && t.nodeType === 3 ? { node: t, m: /^\[( |x|X)\]\s?/.exec(t.data) } : null;
    };
    if (!items.length || !items.every((li) => { const r = marker(li); return r && r.m; })) continue;
    ul.dataset.type = 'checklist';
    for (const li of items) {
      const { node, m } = marker(li);
      li.dataset.checked = m[1] === ' ' ? 'false' : 'true';
      node.data = node.data.slice(m[0].length);
    }
  }
  return parser.parse(dom.body);
}

// Plain text: one line is one paragraph (how most Japanese text is written).
export function fromText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const paras = lines.map((l) => (l === '\f' ? N.page_break.create() : N.paragraph.create(null, l ? schema.text(l.replace(/\f/g, '')) : null)));
  return N.doc.create(null, paras.length ? paras : [N.paragraph.create()]);
}

// The previous app (原稿帳) kept one line per paragraph and "#", "##", "###" for headings.
export function fromGenkocho(text) {
  const blocks = String(text || '').split('\n').map((line) => {
    const m = /^(#{1,3}) (.*)$/.exec(line);
    if (m) return N.heading.create({ level: m[1].length }, m[2] ? schema.text(m[2]) : null);
    const t = line.startsWith('\\') ? line.slice(1) : line;
    return N.paragraph.create(null, t ? schema.text(t) : null);
  });
  return N.doc.create(null, blocks.length ? blocks : [N.paragraph.create()]);
}

export function decodeTextFile(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''); }
  catch {
    try { return new TextDecoder('shift_jis').decode(buffer); }
    catch { return new TextDecoder('utf-8').decode(buffer); }
  }
}

// ---------- writing Markdown ----------

const plainMark = { open: '', close: '', mixable: true, expelEnclosingWhitespace: true };
const htmlMark = (tag) => ({ open: `<${tag}>`, close: `</${tag}>`, mixable: true, expelEnclosingWhitespace: true });

function makeSerializer(notes) {
  const s = new MarkdownSerializer({
    ...defaultMarkdownSerializer.nodes,
    heading(state, node) {
      state.write(state.repeat('#', node.attrs.level) + ' ');
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    code_block(state, node) {
      const fence = node.textContent.match(/`{3,}/gm) ? '````' : '```';
      state.write(fence + '\n');
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write(fence);
      state.closeBlock(node);
    },
    bullet_list(state, node) {
      state.renderList(node, '  ', () => '- ');
    },
    checklist(state, node) {
      state.renderList(node, '  ', () => '- ');
    },
    check_item(state, node) {
      state.write(node.attrs.checked ? '[x] ' : '[ ] ');
      state.renderContent(node);
    },
    image(state, node) {
      state.write('![' + state.esc(node.attrs.alt || '') + '](' + node.attrs.src.replace(/[()]/g, '\\$&') + ')');
      state.closeBlock(node);
    },
    page_break(state, node) {
      state.write('<div style="page-break-after: always"></div>');
      state.closeBlock(node);
    },
    toc(state, node) {
      state.write('[TOC]');
      state.closeBlock(node);
    },
    footnote(state, node) {
      notes.push(node.attrs.text);
      state.write(`[^${notes.length}]`);
    },
    table(state, node) {
      const rows = [];
      node.forEach((row) => {
        const cells = [];
        row.forEach((cell) => {
          const inner = makeSerializer(notes).serialize(N.doc.create(null, cell.content)).trim();
          cells.push(inner.replace(/\n+/g, '<br>').replace(/\|/g, '\\|') || ' ');
        });
        rows.push(cells);
      });
      const cols = Math.max(...rows.map((r) => r.length));
      const line = (cells) => '| ' + Array.from({ length: cols }, (_, i) => cells[i] ?? ' ').join(' | ') + ' |';
      state.write(line(rows[0]) + '\n');
      state.write('|' + ' --- |'.repeat(cols) + '\n');
      for (const r of rows.slice(1)) state.write(line(r) + '\n');
      state.closeBlock(node);
    },
    table_row() {}, table_cell() {}, table_header() {},
  }, {
    ...defaultMarkdownSerializer.marks,
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    underline: htmlMark('u'),
    sup: htmlMark('sup'),
    sub: htmlMark('sub'),
    fontSize: plainMark,
    fontFamily: plainMark,
    color: plainMark,
    highlight: htmlMark('mark'),
  });
  return s;
}

export function toMarkdown(doc) {
  const notes = [];
  let out = makeSerializer(notes).serialize(doc, { tightLists: true });
  if (notes.length) out += '\n\n' + notes.map((t, i) => `[^${i + 1}]: ${t.replace(/\n/g, ' ')}`).join('\n');
  return out + '\n';
}

// ---------- writing plain text ----------

export function toText(doc) {
  const out = [];
  const notes = [];
  const inline = (node) => {
    let t = '';
    node.forEach((child) => {
      if (child.isText) t += child.text;
      else if (child.type === N.hard_break) t += '\n';
      else if (child.type === N.footnote) { notes.push(child.attrs.text); t += `[${notes.length}]`; }
    });
    return t;
  };
  doc.descendants((node, pos, parent) => {
    if (node.isTextblock) {
      let prefix = '';
      const first = parent && parent.firstChild === node;
      if (parent && parent.type === N.check_item && first) prefix = parent.attrs.checked ? '☑ ' : '☐ ';
      else if (parent && parent.type === N.list_item && first) prefix = '・';
      out.push(prefix + inline(node));
      return false;
    }
    if (node.type === N.horizontal_rule) out.push('――――――――');
    else if (node.type === N.page_break) out.push('');
    else if (node.type === N.toc) {
      doc.descendants((h) => { if (h.type === N.heading) out.push('　'.repeat(h.attrs.level - 1) + h.textContent); return !h.isTextblock; });
    }
    return true;
  });
  if (notes.length) out.push('', '――', ...notes.map((t, i) => `[${i + 1}] ${t}`));
  return out.join('\n') + '\n';
}

// ---------- writing HTML ----------

const css = (table, prefix, prop) => Object.entries(table).map(([k, v]) => `.${prefix}-${k}{${prop}:#${v}}`).join('');
const EXPORT_CSS = `
:root{--fs:16px}
body{max-width:760px;margin:40px auto;padding:0 20px;font:16px/1.8 "Hiragino Sans","Yu Gothic","Noto Sans JP",system-ui,sans-serif;color:#1c2233}
img{max-width:100%}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd;padding:6px 8px;vertical-align:top}
th{background:#f0f2f6}blockquote{margin:0;padding-left:16px;border-left:3px solid #ccd;color:#556}pre{background:#f3f5f8;padding:12px;border-radius:6px;overflow:auto}
ul[data-type=checklist]{list-style:none;padding-left:4px}ul[data-type=checklist] li[data-checked=true]{text-decoration:line-through;color:#889}
ul[data-type=checklist] li::before{content:"☐ "}ul[data-type=checklist] li[data-checked=true]::before{content:"☑ "}
.page-break{break-after:page;page-break-after:always;height:0}
.ff-serif{font-family:"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif}.ff-mono{font-family:ui-monospace,Menlo,Consolas,monospace}.ff-sans{font-family:"Hiragino Sans","Yu Gothic","Noto Sans JP",sans-serif}
nav.toc{border:1px solid #dde2ea;border-radius:8px;padding:8px 16px;margin:0 0 1em}nav.toc ul{list-style:none;padding-left:0;margin:0}
nav.toc .l2{padding-left:1.2em}nav.toc .l3{padding-left:2.4em}nav.toc .l4{padding-left:3.6em}
sup.footnote a,section.footnotes a{text-decoration:none}section.footnotes{border-top:1px solid #dde2ea;margin-top:2em;font-size:.9em}
mark{color:inherit}${css(TEXT_HEX, 'tc', 'color')}${css(HIGHLIGHT_HEX, 'hl', 'background')}${css(CELL_HEX, 'bg', 'background')}
`;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function toHtml(doc, title) {
  const div = document.createElement('div');
  div.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  // links in exported files open normally
  for (const a of div.querySelectorAll('a')) a.removeAttribute('target');
  // headings get ids so the table of contents can link to them
  const heads = Array.from(div.querySelectorAll('h1,h2,h3,h4'));
  heads.forEach((h, i) => { h.id = 'h' + (i + 1); });
  for (const nav of div.querySelectorAll('nav[data-type="toc"]')) {
    nav.innerHTML = '<ul>' + heads.map((h, i) => `<li class="l${h.tagName[1]}"><a href="#h${i + 1}">${esc(h.textContent)}</a></li>`).join('') + '</ul>';
  }
  // footnotes: numbered references and a list at the end
  const refs = Array.from(div.querySelectorAll('sup.footnote'));
  if (refs.length) {
    const items = refs.map((sup, i) => {
      const n = i + 1;
      const text = sup.getAttribute('data-footnote') || '';
      sup.removeAttribute('data-footnote');
      sup.id = 'fnref' + n;
      sup.innerHTML = `<a href="#fn${n}">${n}</a>`;
      return `<li id="fn${n}">${esc(text)} <a href="#fnref${n}" aria-label="本文へ戻る">↩</a></li>`;
    });
    div.insertAdjacentHTML('beforeend', `<section class="footnotes"><ol>${items.join('')}</ol></section>`);
  }
  return `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${esc(title)}</title>\n<style>${EXPORT_CSS}</style>\n</head>\n<body>\n${div.innerHTML}\n</body>\n</html>\n`;
}
