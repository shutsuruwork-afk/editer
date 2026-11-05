// Moving documents in and out: Markdown, HTML and plain text.
import { DOMParser as PMDOMParser, DOMSerializer } from 'prosemirror-model';
import { MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';
import { schema } from './schema.js';

const N = schema.nodes;

// ---------- reading ----------

export function fromHtml(html) {
  const dom = new window.DOMParser().parseFromString(html, 'text/html');
  // Docs/Word put page styles in <style>, comments etc.; only the body matters
  return PMDOMParser.fromSchema(schema).parse(dom.body);
}

const md = new MarkdownIt('default', { html: false, linkify: true, breaks: false });

export function fromMarkdown(text) {
  const html = md.render(text);
  const dom = new window.DOMParser().parseFromString(html, 'text/html');
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
  return PMDOMParser.fromSchema(schema).parse(dom.body);
}

// Plain text: one line is one paragraph (how most Japanese text is written).
export function fromText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const paras = lines.map((l) => N.paragraph.create(null, l ? schema.text(l) : null));
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

// ---------- writing ----------

const plainMark = { open: '', close: '', mixable: true, expelEnclosingWhitespace: true };

const serializer = new MarkdownSerializer({
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
  table(state, node) {
    const rows = [];
    node.forEach((row) => {
      const cells = [];
      row.forEach((cell) => {
        const inner = serializer.serialize(N.doc.create(null, cell.content)).trim();
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
  underline: plainMark,
  color: plainMark,
  highlight: plainMark,
});

export function toMarkdown(doc) {
  return serializer.serialize(doc, { tightLists: true }) + '\n';
}

export function toText(doc) {
  const out = [];
  doc.descendants((node, pos, parent) => {
    if (node.isTextblock) {
      let prefix = '';
      if (parent && parent.type === N.check_item) prefix = parent.attrs.checked ? '☑ ' : '☐ ';
      else if (parent && parent.type === N.list_item) prefix = '・';
      if (parent && (parent.type === N.list_item || parent.type === N.check_item) && parent.firstChild !== node) prefix = '';
      out.push(prefix + node.textBetween(0, node.content.size, '', (leaf) => (leaf.type === N.hard_break ? '\n' : '')));
      return false;
    }
    if (node.type === N.horizontal_rule) out.push('――――――――');
    return true;
  });
  return out.join('\n') + '\n';
}

const EXPORT_CSS = `
body{max-width:760px;margin:40px auto;padding:0 20px;font:16px/1.8 "Hiragino Sans","Yu Gothic","Noto Sans JP",system-ui,sans-serif;color:#1c2233}
img{max-width:100%;display:block;margin:12px auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd;padding:6px 8px;vertical-align:top}
th{background:#f0f2f6}blockquote{margin:0;padding-left:16px;border-left:3px solid #ccd;color:#556}pre{background:#f3f5f8;padding:12px;border-radius:6px;overflow:auto}
ul[data-type=checklist]{list-style:none;padding-left:4px}ul[data-type=checklist] li[data-checked=true]{text-decoration:line-through;color:#889}
ul[data-type=checklist] li::before{content:"☐ "}ul[data-type=checklist] li[data-checked=true]::before{content:"☑ "}
.tc-gray{color:#6b7280}.tc-red{color:#c0362c}.tc-orange{color:#c2610c}.tc-yellow{color:#a17a00}.tc-green{color:#2e7d4f}.tc-blue{color:#2563b0}.tc-purple{color:#7c3aad}
mark{background:#fdf0a6;color:inherit}.hl-gray{background:#e5e7eb}.hl-red{background:#fbd5d0}.hl-orange{background:#fde0c2}.hl-green{background:#d3efd9}.hl-blue{background:#d6e6fb}.hl-purple{background:#e8dcf8}
.bg-gray{background:#f1f2f4}.bg-red{background:#fde8e5}.bg-orange{background:#fdeedd}.bg-yellow{background:#fdf6d3}.bg-green{background:#e3f4e7}.bg-blue{background:#e5effc}.bg-purple{background:#f0e9fb}
`;

export function toHtml(doc, title) {
  const div = document.createElement('div');
  div.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  // links in exported files open normally
  for (const a of div.querySelectorAll('a')) { a.removeAttribute('target'); }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${esc(title)}</title>\n<style>${EXPORT_CSS}</style>\n</head>\n<body>\n${div.innerHTML}\n</body>\n</html>\n`;
}
