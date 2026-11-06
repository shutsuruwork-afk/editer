// Word (.docx) export and import, checked in a real browser: node tests/docx.test.mjs
// The exported file is also opened with unzip, LibreOffice and pandoc, and files made by pandoc and
// LibreOffice are imported, when those tools are installed. Temporary files go to DOCX_TEST_DIR.
import { createRequire } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.env.DOCX_TEST_DIR || path.join(os.tmpdir(), 'editer-docx-test'));
await mkdir(dir, { recursive: true });

await esbuild.build({
  stdin: {
    contents: "export { docToDocx, docxToDoc } from './src/editor/docx.js'; export { schema } from './src/editor/schema.js';",
    resolveDir: root,
    sourcefile: 'docx-test-entry.js',
  },
  bundle: true,
  format: 'iife',
  globalName: 'D',
  target: ['es2020', 'safari15'],
  outfile: path.join(dir, 'docx-test-bundle.js'),
  logLevel: 'warning',
});

const server = http.createServer(async (req, res) => {
  const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
  if (!name) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>docx</title><script src="/docx-test-bundle.js"></script>');
    return;
  }
  try {
    const data = await readFile(path.join(dir, name));
    res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
// LibreOffice and pandoc keep their own temporary files with ours as well
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, env: { ...process.env, TMPDIR: dir }, ...opts });
const loProfile = `-env:UserInstallation=file://${path.join(dir, 'lo-profile')}`;
const soffice = (...args) => sh('soffice', [loProfile, '--headless', ...args], { cwd: dir });

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ', String((e && e.stack) || e).split('\n').slice(0, 24).join('\n      ')); }
}
const skip = (name, why) => console.log('skip', name, `(${why})`);

// ---------- helpers over ProseMirror JSON ----------
function all(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.content || []) all(c, pred, out);
  return out;
}
const text = (node) => (node.type === 'text' ? node.text : node.type === 'hard_break' ? '\n' : (node.content || []).map(text).join(''));
const marksOf = (doc, s) => {
  const t = all(doc, (n) => n.type === 'text' && n.text.includes(s))[0];
  assert.ok(t, `text "${s}" not found`);
  return Object.fromEntries((t.marks || []).map((m) => [m.type, m.attrs || true]));
};
const byType = (doc, type) => all(doc, (n) => n.type === type);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base);
await page.waitForFunction(() => window.D && window.D.docToDocx);

// ---------- round trip ----------
const sample = await page.evaluate(async () => {
  const { schema, docToDocx, docxToDoc } = window.D;
  const n = (type, attrs, content) => schema.node(type, attrs, content);
  const t = (s, ...marks) => schema.text(s, marks.map((m) => (typeof m === 'string' ? schema.mark(m) : schema.mark(m[0], m[1]))));
  const p = (...c) => n('paragraph', null, c);
  const pa = (attrs, ...c) => n('paragraph', attrs, c);
  const li = (...c) => n('list_item', null, c);
  const ci = (checked, ...c) => n('check_item', { checked }, c);
  const cell = (type, attrs, s) => n(type, attrs, [p(t(s))]);

  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 60;
  const g = canvas.getContext('2d');
  g.fillStyle = '#2563b0';
  g.fillRect(0, 0, 120, 60);
  g.fillStyle = '#fdf0a6';
  g.fillRect(20, 10, 40, 40);
  const png = canvas.toDataURL('image/png');
  const webp = canvas.toDataURL('image/webp');

  const doc = n('doc', null, [
    n('heading', { level: 1 }, [t('文書の題名')]),
    n('toc'),
    n('heading', { level: 2, align: 'center' }, [t('はじめに')]),
    p(
      t('普通の文章、'), t('太字', 'strong'), t('と'), t('斜体', 'em'), t('と'), t('下線', 'underline'), t('と'),
      t('取り消し', 'strike'), t('、x'), t('2', 'sup'), t('とH'), t('2', 'sub'), t('O、'), t('コード', 'code'), t('、'),
      t('大きな文字', ['fontSize', { size: 18 }]), t('、'), t('明朝体', ['fontFamily', { family: 'serif' }]), t('、'),
      t('等幅', ['fontFamily', { family: 'mono' }]), t('、'), t('赤い文字', ['color', { color: 'red' }]), t('、'),
      t('黄色の蛍光', ['highlight', { color: 'yellow' }]), t('、'), t('緑の蛍光', ['highlight', { color: 'green' }]), t('、'),
      t('リンク先', ['link', { href: 'https://example.com/パス?q=1&r=2' }]), t('、太字のリンク', 'strong', ['link', { href: 'https://example.com/パス?q=1&r=2' }]),
      t('。脚注つき'), n('footnote', { text: '一つ目の脚注です。' }), t('の文。'), n('hard_break'), t('改行後\tタブの後'),
    ),
    pa({ align: 'center', indent: 2, lineHeight: '1.5' }, t('中央・字下げ2・行間1.5')),
    pa({ align: 'right' }, t('右寄せ')),
    pa({ align: 'justify', lineHeight: '2' }, t('両端揃えで行間2')),
    n('heading', { level: 3 }, [t('引用とコード'), n('footnote', { text: '見出しの脚注\n二行目' })]),
    n('blockquote', null, [p(t('引用の一段目')), n('blockquote', null, [p(t('入れ子の引用'))])]),
    n('code_block', null, [schema.text('function f() {\n  return "<a&b>";\n}\tタブ')]),
    n('horizontal_rule'),
    n('heading', { level: 4 }, [t('リスト')]),
    n('bullet_list', null, [
      li(p(t('りんご')), n('bullet_list', null, [li(p(t('青りんご'))), li(p(t('赤りんご')), n('ordered_list', { order: 1, style: 'upper-roman' }, [li(p(t('ローマ数字')))]))])),
      li(p(t('みかん')), p(t('みかんの二段落目'))),
    ]),
    n('ordered_list', { order: 3, style: 'lower-alpha' }, [li(p(t('三番目から'))), li(p(t('次の項目')))]),
    n('ordered_list', null, [li(p(t('一番'))), li(p(t('二番')), n('ordered_list', null, [li(p(t('入れ子の番号')))]))]),
    n('bullet_list', { style: 'square' }, [li(p(t('四角')))]),
    n('bullet_list', { style: 'dash' }, [li(p(t('ダッシュ')))]),
    n('ordered_list', { order: 1, style: 'cjk-ideographic' }, [li(p(t('漢数字')))]),
    n('checklist', null, [ci(false, p(t('未完了のタスク'))), ci(true, p(t('完了したタスク')), n('checklist', null, [ci(true, p(t('入れ子のタスク')))]))]),
    n('page_break'),
    n('table', null, [
      n('table_row', null, [cell('table_header', { colwidth: [150] }, '名前'), cell('table_header', { colwidth: [200] }, '説明'), cell('table_header', { colwidth: [120] }, '値')]),
      n('table_row', null, [cell('table_cell', { rowspan: 2, background: 'blue' }, '縦結合'), cell('table_cell', { colspan: 2, colwidth: [200, 120], background: 'yellow' }, '横結合')]),
      n('table_row', null, [cell('table_cell', null, '説明二'), n('table_cell', null, [p(t('太字の値', 'strong')), n('bullet_list', null, [li(p(t('セル内リスト')))])])]),
    ]),
    n('table', null, [n('table_row', null, [cell('table_cell', null, '幅なし表A'), cell('table_cell', null, '幅なし表B')])]),
    n('image', { src: png, alt: '青い四角', width: 50, align: 'left' }),
    n('image', { src: webp, alt: 'WebP 画像', align: 'right' }),
    n('image', { src: 'idb:missing123' }),
    p(t('最後の段落です。'), n('footnote', { text: '二つ目の脚注' })),
  ]);
  doc.check();
  const decode = (src) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(src);
    const bin = atob(m[2]);
    return { bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)), type: m[1] };
  };
  const loads = [];
  const blob = await docToDocx(doc, {
    title: 'テスト文書',
    loadImage: async (src) => { loads.push(src.split(/[;,]/)[0]); return src.startsWith('data:') ? decode(src) : null; },
  });
  const buf = await blob.arrayBuffer();
  const back = await docxToDoc(buf);
  schema.nodeFromJSON(back.doc.toJSON()).check();
  let bin = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { type: blob.type, size: buf.byteLength, b64: btoa(bin), title: back.title, json: back.doc.toJSON(), loads };
});
const rtFile = path.join(dir, 'roundtrip.docx');
await writeFile(rtFile, Buffer.from(sample.b64, 'base64'));
const rt = sample.json;

await test('export: blob type, size and image loader calls', async () => {
  assert.equal(sample.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(sample.size > 2000);
  assert.deepEqual(sample.loads.sort(), ['data:image/png', 'data:image/webp', 'idb:missing123'].sort());
});

await test('round trip: title, headings and table of contents', async () => {
  assert.equal(sample.title, 'テスト文書');
  const hs = byType(rt, 'heading').map((h) => [h.attrs.level, text(h)]);
  assert.deepEqual(hs, [[1, '文書の題名'], [2, 'はじめに'], [3, '引用とコード'], [4, 'リスト']]);
  assert.equal(byType(rt, 'heading')[1].attrs.align, 'center');
  assert.equal(rt.content[1].type, 'toc');
  assert.equal(byType(rt, 'toc').length, 1);
});

await test('round trip: marks', async () => {
  assert.ok(marksOf(rt, '太字').strong);
  assert.ok(marksOf(rt, '斜体').em);
  assert.ok(marksOf(rt, '下線').underline);
  assert.ok(marksOf(rt, '取り消し').strike);
  assert.ok(marksOf(rt, 'コード').code);
  assert.deepEqual(marksOf(rt, '大きな文字').fontSize, { size: 18 });
  assert.deepEqual(marksOf(rt, '明朝体').fontFamily, { family: 'serif' });
  assert.deepEqual(marksOf(rt, '等幅').fontFamily, { family: 'mono' });
  assert.deepEqual(marksOf(rt, '赤い文字').color, { color: 'red' });
  assert.deepEqual(marksOf(rt, '黄色の蛍光').highlight, { color: 'yellow' });
  assert.deepEqual(marksOf(rt, '緑の蛍光').highlight, { color: 'green' });
  const sups = all(rt, (x) => x.type === 'text' && x.text === '2').map((x) => x.marks.map((m) => m.type).join());
  assert.deepEqual(sups, ['sup', 'sub']);
  assert.deepEqual(Object.keys(marksOf(rt, '普通の文章')), []);
});

await test('round trip: links, footnotes, hard break and tab', async () => {
  assert.deepEqual(marksOf(rt, 'リンク先').link, { href: 'https://example.com/パス?q=1&r=2' });
  const bold = marksOf(rt, '太字のリンク');
  assert.ok(bold.strong && bold.link && !bold.underline && !bold.color);
  assert.deepEqual(byType(rt, 'footnote').map((f) => f.attrs.text), ['一つ目の脚注です。', '見出しの脚注\n二行目', '二つ目の脚注']);
  const para = all(rt, (x) => x.type === 'paragraph' && text(x).startsWith('普通の文章'))[0];
  assert.ok(text(para).endsWith('の文。\n改行後\tタブの後'));
});

await test('round trip: paragraph attributes', async () => {
  const attrs = (s) => all(rt, (x) => x.type === 'paragraph' && text(x) === s)[0].attrs;
  assert.deepEqual(attrs('中央・字下げ2・行間1.5'), { align: 'center', indent: 2, lineHeight: '1.5' });
  assert.deepEqual(attrs('右寄せ'), { align: 'right', indent: 0, lineHeight: null });
  assert.deepEqual(attrs('両端揃えで行間2'), { align: 'justify', indent: 0, lineHeight: '2' });
  assert.deepEqual(attrs('最後の段落です。'), { align: null, indent: 0, lineHeight: null });
});

await test('round trip: quotes, code block, rule, page break', async () => {
  const q = byType(rt, 'blockquote')[0];
  assert.equal(text(q.content[0]), '引用の一段目');
  assert.equal(q.content[1].type, 'blockquote');
  assert.equal(text(q.content[1]), '入れ子の引用');
  assert.equal(text(byType(rt, 'code_block')[0]), 'function f() {\n  return "<a&b>";\n}\tタブ');
  assert.equal(byType(rt, 'horizontal_rule').length, 1);
  assert.equal(byType(rt, 'page_break').length, 1);
});

await test('round trip: lists, nesting, styles, numbering and checklist', async () => {
  const top = rt.content.filter((x) => /list$/.test(x.type));
  const summary = (l) => [l.type, l.attrs ? l.attrs.style : undefined, l.attrs && l.attrs.order, l.content.map((i) => text(i.content[0]))];
  assert.deepEqual(top.map(summary), [
    ['bullet_list', null, undefined, ['りんご', 'みかん']],
    ['ordered_list', 'lower-alpha', 3, ['三番目から', '次の項目']],
    ['ordered_list', null, 1, ['一番', '二番']],
    ['bullet_list', 'square', undefined, ['四角']],
    ['bullet_list', 'dash', undefined, ['ダッシュ']],
    ['ordered_list', 'cjk-ideographic', 1, ['漢数字']],
    ['checklist', undefined, undefined, ['未完了のタスク', '完了したタスク']],
  ]);
  const [fruit] = top;
  const nested = fruit.content[0].content[1];
  assert.equal(nested.type, 'bullet_list');
  assert.equal(nested.attrs.style, null);
  assert.deepEqual(nested.content.map((i) => text(i.content[0])), ['青りんご', '赤りんご']);
  const roman = nested.content[1].content[1];
  assert.equal(roman.type, 'ordered_list');
  assert.equal(roman.attrs.style, 'upper-roman');
  assert.deepEqual(fruit.content[1].content.map((x) => [x.type, text(x)]), [['paragraph', 'みかん'], ['paragraph', 'みかんの二段落目']]);
  const inner = top[2].content[1].content[1];
  assert.deepEqual([inner.type, inner.attrs.style, text(inner)], ['ordered_list', null, '入れ子の番号']);
  const checks = top[6];
  assert.deepEqual(checks.content.map((i) => i.attrs.checked), [false, true]);
  const sub = checks.content[1].content[1];
  assert.deepEqual([sub.type, sub.content[0].attrs.checked, text(sub)], ['checklist', true, '入れ子のタスク']);
});

await test('round trip: tables', async () => {
  const [t1, t2] = byType(rt, 'table');
  const rows = t1.content.map((r) => r.content.map((c) => [c.type, text(c), c.attrs.colspan, c.attrs.rowspan, c.attrs.background]));
  assert.deepEqual(rows, [
    [['table_header', '名前', 1, 1, null], ['table_header', '説明', 1, 1, null], ['table_header', '値', 1, 1, null]],
    [['table_cell', '縦結合', 1, 2, 'blue'], ['table_cell', '横結合', 2, 1, 'yellow']],
    [['table_cell', '説明二', 1, 1, null], ['table_cell', '太字の値セル内リスト', 1, 1, null]],
  ]);
  assert.deepEqual(t1.content[0].content.map((c) => c.attrs.colwidth), [[150], [200], [120]]);
  assert.deepEqual(t1.content[1].content[1].attrs.colwidth, [200, 120]);
  assert.equal(t1.content[2].content[1].content[1].type, 'bullet_list');
  assert.ok(marksOf(t1, '太字の値').strong);
  assert.deepEqual(t2.content[0].content.map((c) => c.attrs.colwidth), [null, null]);
});

await test('round trip: images', async () => {
  const imgs = byType(rt, 'image');
  assert.equal(imgs.length, 2);
  assert.match(imgs[0].attrs.src, /^data:image\/png;base64,/);
  assert.deepEqual([imgs[0].attrs.alt, imgs[0].attrs.width, imgs[0].attrs.align], ['青い四角', 50, 'left']);
  assert.match(imgs[1].attrs.src, /^data:image\/(jpeg|png);base64,/); // WebP is redrawn for older Word
  assert.equal(imgs[1].attrs.align, 'right');
  assert.equal(imgs[1].attrs.alt, 'WebP 画像');
  assert.equal(imgs[1].attrs.width, null, 'an image at its own size keeps no width');
  assert.equal(rt.content[rt.content.length - 1].type, 'paragraph');
});

await test('round trip: blocks nested in list items, quotes and cells come back unchanged', async () => {
  const r = await page.evaluate(async () => {
    const { schema, docToDocx, docxToDoc } = window.D;
    const n = (type, attrs, content) => schema.node(type, attrs, content);
    const P = (s) => n('paragraph', null, s ? [schema.text(s)] : []);
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    canvas.getContext('2d').fillRect(0, 0, 40, 40);
    const png = canvas.toDataURL('image/png');
    const doc = n('doc', null, [
      n('blockquote', null, [P('引用内の段落'), n('bullet_list', null, [n('list_item', null, [P('引用内リスト'), n('ordered_list', null, [n('list_item', null, [P('引用内の入れ子')])])])]), P('引用の最後')]),
      n('ordered_list', null, [
        n('list_item', null, [P('項目一'), n('blockquote', null, [P('項目内の引用'), n('blockquote', null, [P('さらに内側')])]), n('heading', { level: 3 }, [schema.text('項目内の見出し')]),
          n('code_block', null, [schema.text('code in item')]), n('image', { src: png, width: 30 }), n('horizontal_rule'), P('項目内の段落'),
          n('bullet_list', null, [n('list_item', null, [P('入れ子'), P('入れ子の二段落目')])]), P('外側に戻る')]),
        n('list_item', null, [P('項目二')]),
      ]),
      n('table', null, [n('table_row', null, [
        n('table_cell', null, [P('外側'), n('table', null, [n('table_row', null, [n('table_cell', null, [P('内側')]), n('table_cell', null, [n('image', { src: png, width: 100 })])])])]),
        n('table_cell', null, [n('checklist', null, [n('check_item', { checked: true }, [P('セル内タスク')])])]),
      ])]),
      n('code_block'), n('heading', { level: 2 }), P(''), n('horizontal_rule'), n('page_break'), n('toc'),
    ]);
    const back = await docxToDoc(await (await docToDocx(doc)).arrayBuffer());
    return { before: JSON.stringify(doc.toJSON()), after: JSON.stringify(back.doc.toJSON()) };
  });
  assert.equal(r.after, r.before);
});

await test('round trip: random documents stay valid and keep their text', async () => {
  const problems = await page.evaluate(async () => {
    const { schema, docToDocx, docxToDoc } = window.D;
    let seed = 20261105;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const words = ['日本語', 'テキスト', 'abc', ' 空白 ', 'x<y&z', '「引用」', '😀', 'タブ\tあり'];
    const marks = [[], ['strong'], ['em', 'underline'], ['strike'], ['sup'], ['sub'], ['code'], [['fontSize', { size: 14 }]], [['fontFamily', { family: 'serif' }]],
      [['color', { color: 'blue' }]], [['highlight', { color: 'green' }]], [['link', { href: 'https://example.com/' }]]];
    const canvas = document.createElement('canvas');
    canvas.width = 30;
    canvas.height = 20;
    canvas.getContext('2d').fillRect(0, 0, 30, 20);
    const png = canvas.toDataURL('image/png');
    const inline = () => Array.from({ length: Math.floor(rnd() * 4) }, () => {
      const r = rnd();
      if (r < 0.1) return schema.node('hard_break');
      if (r < 0.2) return schema.node('footnote', { text: pick(words) });
      return schema.text(pick(words), pick(marks).map((m) => (typeof m === 'string' ? schema.mark(m) : schema.mark(m[0], m[1]))));
    });
    const para = () => schema.node('paragraph', pick([null, { align: 'center' }, { indent: 1 }, { lineHeight: '1.5' }]), inline());
    const blocks = (d, n) => Array.from({ length: n }, () => block(d));
    const block = (d) => {
      const r = rnd();
      if (d > 3 || r < 0.35) return para();
      if (r < 0.42) return schema.node('heading', { level: 1 + Math.floor(rnd() * 4) }, inline());
      if (r < 0.5) return schema.node('blockquote', null, blocks(d + 1, 1 + Math.floor(rnd() * 2)));
      if (r < 0.55) return schema.node('code_block', null, rnd() < 0.5 ? [schema.text('code\n  x')] : []);
      if (r < 0.58) return schema.node(pick(['horizontal_rule', 'page_break', 'toc']));
      if (r < 0.62) return schema.node('image', { src: png, width: rnd() < 0.5 ? 40 : null, align: pick(['left', 'center', 'right']) });
      if (r < 0.78) {
        const type = pick(['bullet_list', 'ordered_list', 'checklist']), item = type === 'checklist' ? 'check_item' : 'list_item';
        const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => schema.node(item, item === 'check_item' ? { checked: rnd() < 0.5 } : null, [para(), ...blocks(d + 1, Math.floor(rnd() * 2))]));
        return schema.node(type, type === 'ordered_list' ? { order: 1 + Math.floor(rnd() * 5), style: pick([null, 'upper-roman']) } : type === 'bullet_list' ? { style: pick([null, 'dash']) } : null, items);
      }
      const cols = 1 + Math.floor(rnd() * 3);
      return schema.node('table', null, Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => schema.node('table_row', null,
        Array.from({ length: cols }, () => schema.node(i === 0 && rnd() < 0.5 ? 'table_header' : 'table_cell', { background: pick([null, 'gray']) }, blocks(d + 1, 1 + Math.floor(rnd() * 2)))))));
    };
    const count = (doc) => {
      const c = {};
      doc.descendants((n) => { if (!n.isText && !/^(paragraph|table_row|table_cell|table_header|list_item|check_item|bullet_list|ordered_list|checklist|blockquote|code_block)$/.test(n.type.name)) c[n.type.name] = (c[n.type.name] || 0) + 1; });
      return JSON.stringify(Object.entries(c).sort());
    };
    const out = [];
    for (let i = 0; i < 150; i++) {
      const doc = schema.node('doc', null, blocks(0, 1 + Math.floor(rnd() * 8)));
      try {
        const back = (await docxToDoc(await (await docToDocx(doc)).arrayBuffer())).doc;
        back.check();
        if (back.textContent.replace(/\s+/g, '') !== doc.textContent.replace(/\s+/g, '')) out.push(`#${i} text`);
        if (count(back) !== count(doc)) out.push(`#${i} ${count(doc)} -> ${count(back)}`);
      } catch (e) {
        out.push(`#${i} ${(e.cause && e.cause.stack) || e.stack}`);
      }
    }
    return out;
  });
  assert.deepEqual(problems, []);
});

// ---------- the exported file outside the browser ----------
await test('exported file: zip integrity (unzip -t)', async () => {
  if (!has('unzip')) return skip('unzip -t', 'unzip not installed');
  const r = sh('unzip', ['-t', rtFile]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No errors detected/);
  const list = sh('unzip', ['-Z1', rtFile]).stdout.split('\n');
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'word/document.xml', 'word/styles.xml',
    'word/numbering.xml', 'word/footnotes.xml', 'word/settings.xml', 'word/_rels/document.xml.rels', 'word/media/image1.png']) assert.ok(list.includes(part), part);
  assert.match(sh('unzip', ['-v', rtFile]).stdout, /Defl:N/);
  // both test images are 120×60; sizes come from the file header or the redrawn WebP
  const extents = [...sh('unzip', ['-p', rtFile, 'word/document.xml']).stdout.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)];
  assert.equal(extents.length, 2);
  for (const [, cx, cy] of extents) assert.ok(Math.abs(cx / cy - 2) < 0.01, `aspect ratio ${cx}/${cy}`);
  // every XML part is well formed
  for (const part of list.filter((f) => /\.(xml|rels)$/.test(f))) {
    const xml = sh('unzip', ['-p', rtFile, part.replace(/\[/g, '[[]')]).stdout; // [ is a wildcard for unzip
    const ok = await page.evaluate((s) => !new DOMParser().parseFromString(s, 'application/xml').getElementsByTagName('parsererror').length, xml);
    assert.ok(ok, `${part} is not well-formed XML`);
  }
});

const expectInText = (out, label) => {
  for (const s of ['文書の題名', 'はじめに', '太字', 'りんご', '青りんご', '三番目から', '未完了のタスク', '縦結合', '横結合', 'セル内', '最後の段落です。']) {
    assert.ok(out.includes(s), `${label}: missing "${s}"`);
  }
};

await test('exported file: LibreOffice converts it to PDF and text', async () => {
  if (!has('soffice')) return skip('LibreOffice', 'soffice not installed');
  await rm(path.join(dir, 'roundtrip.pdf'), { force: true });
  let r = soffice('--convert-to', 'pdf', '--outdir', dir, rtFile);
  assert.equal(r.status, 0, r.stderr);
  const pdf = await stat(path.join(dir, 'roundtrip.pdf'));
  assert.ok(pdf.size > 5000, `pdf is only ${pdf.size} bytes`);
  if (has('pdftotext')) {
    const out = sh('pdftotext', ['-layout', path.join(dir, 'roundtrip.pdf'), '-']).stdout;
    expectInText(out, 'pdftotext');
    assert.ok(out.includes('一つ目の脚注です。'), 'footnote text in the PDF');
    assert.ok(/目次[\s\S]*文書の題名[\s\S]*はじめに/.test(out), 'the TOC lists the headings');
  }
  await rm(path.join(dir, 'roundtrip.txt'), { force: true });
  r = soffice('--convert-to', 'txt:Text (encoded):UTF8', '--outdir', dir, rtFile);
  assert.equal(r.status, 0, r.stderr);
  const txt = await readFile(path.join(dir, 'roundtrip.txt'), 'utf8');
  expectInText(txt, 'soffice txt');
  assert.ok(txt.includes('脚注つき1の文'), 'footnote reference in the text export'); // the notes themselves are only in the PDF
  assert.match(txt, /c\.\s*三番目から/); // lower-alpha list starting at 3
  assert.match(txt, /☐ 未完了のタスク/);
});

await test('exported file: pandoc reads it', async () => {
  if (!has('pandoc')) return skip('pandoc', 'pandoc not installed');
  const r = sh('pandoc', [rtFile, '-t', 'markdown', '--wrap=none']);
  assert.equal(r.status, 0, r.stderr);
  const md = r.stdout;
  expectInText(md, 'pandoc');
  assert.match(md, /^# 文書の題名/m);
  assert.match(md, /^## はじめに/m);
  assert.match(md, /\*\*太字\*\*/);
  assert.match(md, /\[\^1\]: 一つ目の脚注です。/);
  assert.match(md, /\[リンク先[^\]]*\]\(https:\/\/example\.com\//); // both links share one URL, so one w:hyperlink
  assert.match(md, /^-\s+りんご/m);
  assert.match(md, /^\s+-\s+青りんご/m);
  assert.match(md, /^c\.\s+三番目から/m);
  assert.match(md, /^> 引用の一段目/m);
});

// ---------- files from other programs ----------
const MD = `---
title: パンドック文書
---

# 大見出し

段落に *強調* と **太字** と \`code\` と [リンク](https://example.org/x?a=1)。注釈[^n]。

## 小見出し

- 一つ目
    - 入れ子
- 二つ目

3. 三
4. 四

- [ ] やること
- [x] 済み

> 引用文

\`\`\`
code 1
  code 2
\`\`\`

| 名前 | 値 |
|------|----|
| 太郎 | 20 |

---

[^n]: 注釈の本文。
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>LO 文書</title></head><body>
<h1>リブレ見出し</h1>
<p>普通と<em>斜体</em>と<strong>太字</strong>と<u>下線</u>と<a href="https://example.net/y">リンク</a>と<code>コード</code>。</p>
<h2>中見出し</h2>
<ul><li>外側<ul><li>内側</li></ul></li><li>外側二</li></ul>
<ol start="5"><li>五</li><li>六</li></ol>
<blockquote><p>引用です</p></blockquote>
<pre>pre 一行目
pre 二行目</pre>
<table border="1"><thead><tr><th>見出しA</th><th>見出しB</th></tr></thead><tbody><tr><td colspan="2">結合セル</td></tr><tr><td>左</td><td>右</td></tr></tbody></table>
<hr>
<p>おわり</p>
</body></html>`;

const importFile = (name) => page.evaluate(async (file) => {
  const buf = await (await fetch('/' + file)).arrayBuffer();
  const r = await window.D.docxToDoc(buf);
  return { title: r.title, json: r.doc.toJSON() };
}, name);

await test('import: pandoc-made .docx', async () => {
  if (!has('pandoc')) return skip('pandoc import', 'pandoc not installed');
  await writeFile(path.join(dir, 'in.md'), MD);
  const r = sh('pandoc', ['in.md', '-o', 'pandoc.docx'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const { title, json } = await importFile('pandoc.docx');
  assert.equal(title, 'パンドック文書');
  assert.deepEqual(byType(json, 'heading').map((h) => [h.attrs.level, text(h)]), [[1, 'パンドック文書'], [1, '大見出し'], [2, '小見出し']]);
  assert.ok(marksOf(json, '強調').em);
  assert.ok(marksOf(json, '太字').strong);
  assert.ok(marksOf(json, 'code').code);
  assert.deepEqual(marksOf(json, 'リンク').link, { href: 'https://example.org/x?a=1' });
  assert.deepEqual(byType(json, 'footnote').map((f) => f.attrs.text), ['注釈の本文。']);
  const lists = json.content.filter((x) => /list$/.test(x.type));
  assert.deepEqual(lists.map((l) => [l.type, l.content.map((i) => text(i.content[0]))]), [
    ['bullet_list', ['一つ目', '二つ目']], ['ordered_list', ['三', '四']], ['checklist', ['やること', '済み']],
  ]);
  assert.equal(lists[0].content[0].content[1].type, 'bullet_list');
  assert.equal(text(lists[0].content[0].content[1]), '入れ子');
  assert.equal(lists[1].attrs.order, 3);
  assert.deepEqual(lists[2].content.map((i) => i.attrs.checked), [false, true]);
  assert.equal(text(byType(json, 'blockquote')[0]), '引用文');
  assert.equal(text(byType(json, 'code_block')[0]), 'code 1\n  code 2');
  const table = byType(json, 'table')[0];
  assert.deepEqual(table.content.map((r) => r.content.map((c) => [c.type, text(c)])), [[['table_header', '名前'], ['table_header', '値']], [['table_cell', '太郎'], ['table_cell', '20']]]);
  assert.equal(byType(json, 'horizontal_rule').length, 1);
});

await test('import: LibreOffice-made .docx', async () => {
  if (!has('soffice')) return skip('LibreOffice import', 'soffice not installed');
  await writeFile(path.join(dir, 'lo.html'), HTML);
  await rm(path.join(dir, 'lo.docx'), { force: true });
  const r = soffice('--convert-to', 'docx:MS Word 2007 XML', '--outdir', dir, path.join(dir, 'lo.html'));
  assert.equal(r.status, 0, r.stderr);
  const { json } = await importFile('lo.docx');
  assert.deepEqual(byType(json, 'heading').map((h) => [h.attrs.level, text(h)]), [[1, 'リブレ見出し'], [2, '中見出し']]);
  assert.ok(marksOf(json, '斜体').em);
  assert.ok(marksOf(json, '太字').strong);
  assert.ok(marksOf(json, '下線').underline);
  assert.ok(marksOf(json, 'コード').code);
  assert.deepEqual(marksOf(json, 'リンク').link, { href: 'https://example.net/y' });
  assert.deepEqual(Object.keys(marksOf(json, '普通と')), []);
  const lists = json.content.filter((x) => /list$/.test(x.type));
  assert.deepEqual(lists.map((l) => [l.type, l.content.map((i) => text(i.content[0]))]), [['bullet_list', ['外側', '外側二']], ['ordered_list', ['五', '六']]]);
  assert.equal(text(lists[0].content[0].content[1]), '内側');
  assert.equal(lists[1].attrs.order, 5);
  assert.equal(text(byType(json, 'blockquote')[0]), '引用です');
  assert.equal(text(byType(json, 'code_block')[0]), 'pre 一行目\npre 二行目');
  const table = byType(json, 'table')[0];
  assert.deepEqual(table.content.map((r) => r.content.map((c) => [c.type, text(c), c.attrs.colspan])), [
    [['table_header', '見出しA', 1], ['table_header', '見出しB', 1]], [['table_cell', '結合セル', 2]], [['table_cell', '左', 1], ['table_cell', '右', 1]],
  ]);
  assert.equal(byType(json, 'horizontal_rule').length, 1);
  assert.equal(text(json.content[json.content.length - 1]), 'おわり');
});

await test('import: LibreOffice round trip of our own file', async () => {
  if (!has('soffice')) return skip('LibreOffice re-save', 'soffice not installed');
  await mkdir(path.join(dir, 'resaved'), { recursive: true });
  const r = soffice('--convert-to', 'docx:MS Word 2007 XML', '--outdir', path.join(dir, 'resaved'), rtFile);
  assert.equal(r.status, 0, r.stderr);
  await writeFile(path.join(dir, 'resaved.docx'), await readFile(path.join(dir, 'resaved', 'roundtrip.docx')));
  const { json } = await importFile('resaved.docx');
  assert.deepEqual(byType(json, 'heading').map((h) => text(h)), ['文書の題名', 'はじめに', '引用とコード', 'リスト']);
  assert.ok(byType(json, 'toc').length === 1, 'TOC survives LibreOffice');
  assert.ok(marksOf(json, '太字').strong);
  assert.deepEqual(marksOf(json, '赤い文字').color, { color: 'red' });
  assert.deepEqual(marksOf(json, '黄色の蛍光').highlight, { color: 'yellow' });
  assert.equal(byType(json, 'footnote').length, 3);
  assert.equal(byType(json, 'table').length, 2);
  assert.equal(byType(json, 'image').length, 2);
  assert.deepEqual(byType(json, 'checklist')[0].content.map((i) => i.attrs.checked), [false, true]);
});

// ---------- edge cases ----------
await test('errors: unreadable files throw a Japanese message', async () => {
  const msgs = await page.evaluate(async () => {
    const tryRead = (x) => window.D.docxToDoc(x).then(() => 'resolved', (e) => e.message);
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    return [await tryRead(new Uint8Array([1, 2, 3]).buffer), await tryRead(new TextEncoder().encode('PK not really').buffer), await tryRead(ole.buffer)];
  });
  assert.equal(msgs[0], 'Word ファイルを読み込めませんでした');
  assert.equal(msgs[1], 'Word ファイルを読み込めませんでした');
  assert.match(msgs[2], /^Word ファイルを読み込めませんでした（.*\.doc/);
});

await test('fallbacks: STORE without CompressionStream, error without DecompressionStream', async () => {
  const r = await page.evaluate(async () => {
    const { schema, docToDocx, docxToDoc } = window.D;
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('圧縮なし')])]);
    const saved = [window.CompressionStream, window.DecompressionStream];
    window.CompressionStream = undefined;
    const buf = await (await docToDocx(doc)).arrayBuffer();
    window.CompressionStream = saved[0];
    const methods = [];
    const v = new DataView(buf);
    for (let i = 0; i + 4 < buf.byteLength; i++) if (v.getUint32(i, true) === 0x04034b50) methods.push(v.getUint16(i + 8, true));
    const back = await docxToDoc(buf);
    window.DecompressionStream = undefined;
    const packed = await (await docToDocx(doc)).arrayBuffer();
    const err = await docxToDoc(packed).then(() => 'resolved', (e) => e.message);
    window.DecompressionStream = saved[1];
    return { methods, text: back.doc.textContent, err };
  });
  assert.ok(r.methods.length >= 8 && r.methods.every((m) => m === 0), String(r.methods));
  assert.equal(r.text, '圧縮なし');
  assert.equal(r.err, 'Word ファイルを読み込めませんでした');
});

// A package written by hand, for markup that pandoc and LibreOffice do not produce.
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
async function makeDocx(name, parts) {
  const tmp = path.join(dir, name + '.parts');
  await rm(tmp, { recursive: true, force: true });
  const all = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ...parts,
  };
  for (const [p, data] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(tmp, p)), { recursive: true });
    await writeFile(path.join(tmp, p), data);
  }
  await rm(path.join(dir, name), { force: true });
  const r = sh('zip', ['-q', '-X', path.join(dir, name), ...Object.keys(all)], { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
}

await test('import: Word-style markup (fields, revisions, content controls, text boxes, VML, sections)', async () => {
  if (!has('zip')) return skip('Word-style import', 'zip not installed');
  const rel = (id, type, target, ext) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${ext ? ' TargetMode="External"' : ''}/>`;
  const p = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
  const r = (text, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const num = (id, lvl) => `<w:pStyle w:val="a3"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${id}"/></w:numPr>`;
  const body = [
    p(r('第一章'), '<w:pStyle w:val="1"/>'),
    p(r('箇条書き'), num(1, 0)), p(r('二段目'), num(1, 1)),
    p(r('番号1'), num(2, 0)), p(r('途中の段落')), p(r('番号2'), num(2, 0)),
    p(r('複合フィールドの')
      + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.jp/a" \\o "tip" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + r('リンク', '<w:rStyle w:val="a4"/><w:color w:val="0563C1"/><w:u w:val="single"/>') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
      + '<w:fldSimple w:instr=" HYPERLINK &quot;https://example.jp/b&quot; ">' + r('簡易') + '</w:fldSimple>'
      + '<w:fldSimple w:instr=" PAGE ">' + r('7') + '</w:fldSimple>'
      + `<w:smartTag w:uri="x" w:element="y">${r('スマート')}</w:smartTag><w:ins w:id="1" w:author="a">${r('挿入')}</w:ins>`
      + '<w:del w:id="2" w:author="a"><w:r><w:delText>削除</w:delText></w:r></w:del>'
      + r('蛍光', '<w:highlight w:val="yellow"/>') + r('赤14', '<w:color w:val="FF0000"/><w:sz w:val="28"/>') + r('黒', '<w:color w:val="000000"/>')
      + r('明朝', '<w:rFonts w:ascii="ＭＳ 明朝" w:eastAsia="ＭＳ 明朝" w:hAnsi="ＭＳ 明朝"/>') + r('クーリエ', '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')
      + r('二重線', '<w:dstrike/>') + r('隠し', '<w:vanish/>') + r('普通', '<w:b w:val="0"/><w:sz w:val="21"/>')
      + `<w:r><w:ruby><w:rubyPr><w:rubyAlign w:val="distributeSpace"/></w:rubyPr><w:rt>${r('かんじ')}</w:rt><w:rubyBase>${r('漢字')}</w:rubyBase></w:ruby></w:r>`),
    '<w:p><w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☒</w:t></w:r></w:sdtContent></w:sdt>' + r(' 済み') + '</w:p>',
    p('<w:r><w:sym w:font="Wingdings" w:char="F0A8"/></w:r>' + r(' 未')),
    p(r('文の前') + '<w:r><w:br w:type="page"/></w:r>' + r('改ページ後')),
    p(r('前で改ページ'), '<w:pageBreakBefore/>'),
    p(r('テキストボックスの前') + '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="100" cy="100"/><wp:docPr id="5" name="t"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>'
      + p(r('箱の中')) + '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="width:100pt;height:50pt"><v:textbox><w:txbxContent>'
      + p(r('箱の中')) + '</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>'),
    p('<w:r><w:pict><v:shape style="width:72pt;height:36pt"><v:imagedata r:id="rIdPng" o:title="VML画像"/></v:shape></w:pict></w:r>'),
    p('<w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH><wp:extent cx="1800000" cy="900000"/><wp:docPr id="7" name="p" descr="右の図"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdPng"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
      + '<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="8" name="e"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdEmf"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'),
    p(r('章の終わり'), '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'),
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>'
      + `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/><w:shd w:val="clear" w:color="auto" w:fill="FDE8E5"/></w:tcPr>${p(r('縦'))}</w:tc><w:tc>${p(r('B1'))}</w:tc><w:tc>${p(r('C1'))}</w:tc></w:tr>`
      + `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p(r('BC2'))}</w:tc></w:tr>`
      + `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr><w:tc>${p(r('B3'))}</w:tc></w:tr></w:tbl>`,
    p('<m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>'),
    p(r('脚注') + '<w:r><w:rPr><w:rStyle w:val="a5"/></w:rPr><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r>'),
  ].join('');
  await makeDocx('word.docx', {
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="w14"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1985" w:right="1701" w:bottom="1701" w:left="1701"/></w:sectPr></w:body></w:document>`,
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + rel('rIdS', 'styles', 'styles.xml') + rel('rIdN', 'numbering', 'numbering.xml') + rel('rIdF', 'footnotes', 'footnotes.xml') + rel('rIdE', 'endnotes', 'endnotes.xml')
      + rel('rIdPng', 'image', 'media/image1.png') + rel('rIdEmf', 'image', 'media/image2.emf') + '</Relationships>',
    // Japanese Word: style ids are numbers, Normal is justified, the default size is 10.5pt
    'word/styles.xml': `<?xml version="1.0"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>`
      + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:pPr><w:jc w:val="both"/></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="a3"><w:name w:val="List Paragraph"/><w:basedOn w:val="a"/><w:pPr><w:ind w:leftChars="400" w:left="840"/></w:pPr></w:style>'
      + '<w:style w:type="character" w:styleId="a4"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
      + '<w:style w:type="character" w:styleId="a5"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style></w:styles>',
    'word/numbering.xml': `<?xml version="1.0"?><w:numbering ${NS}>`
      + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\uf06c"/><w:rPr><w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings"/></w:rPr></w:lvl>'
      + '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\uf0a7"/></w:lvl></w:abstractNum>'
      + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimalFullWidth"/><w:lvlText w:val="%1．"/></w:lvl></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
    'word/footnotes.xml': `<?xml version="1.0"?><w:footnotes ${NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${r(' 脚注の文')}</w:p></w:footnote></w:footnotes>`,
    'word/endnotes.xml': `<?xml version="1.0"?><w:endnotes ${NS}><w:endnote w:id="1"><w:p><w:r><w:endnoteRef/></w:r>${r(' 文末脚注')}</w:p></w:endnote></w:endnotes>`,
    'word/media/image1.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
    'word/media/image2.emf': Buffer.from([1, 0, 0, 0, 108, 0, 0, 0, 0, 0, 0, 0, 0x20, 0x45, 0x4d, 0x46]),
  });
  const { json } = await importFile('word.docx');
  const blocks = json.content.map((b) => [b.type, text(b)]);
  assert.deepEqual(byType(json, 'heading').map((h) => [h.attrs.level, text(h)]), [[1, '第一章']]);
  const [bullets] = json.content.filter((x) => x.type === 'bullet_list');
  assert.deepEqual([bullets.attrs.style, text(bullets.content[0].content[0])], [null, '箇条書き']);
  assert.deepEqual([bullets.content[0].content[1].type, bullets.content[0].content[1].attrs.style], ['bullet_list', 'square']);
  const ordered = json.content.filter((x) => x.type === 'ordered_list');
  assert.deepEqual(ordered.map((l) => [l.attrs.order, text(l)]), [[1, '番号1'], [2, '番号2']]); // numbering goes on after the paragraph
  assert.deepEqual(marksOf(json, 'リンク'), { link: { href: 'https://example.jp/a' } });
  assert.deepEqual(marksOf(json, '簡易'), { link: { href: 'https://example.jp/b' } });
  assert.deepEqual(marksOf(json, '蛍光').highlight, { color: 'yellow' });
  assert.deepEqual(marksOf(json, '赤14'), { color: { color: 'red' }, fontSize: { size: 14 } });
  assert.deepEqual(marksOf(json, '明朝'), { fontFamily: { family: 'serif' } });
  assert.deepEqual(marksOf(json, 'クーリエ'), { fontFamily: { family: 'mono' } });
  assert.ok(marksOf(json, '二重線').strike);
  const fieldPara = all(json, (x) => x.type === 'paragraph' && text(x).startsWith('複合'))[0];
  assert.equal(text(fieldPara), '複合フィールドのリンク簡易7スマート挿入蛍光赤14黒明朝クーリエ二重線普通漢字');
  assert.equal(fieldPara.attrs.align, null, 'the justified Normal style is not a format');
  assert.deepEqual(Object.keys(marksOf(json, '黒')), []);
  assert.deepEqual(Object.keys(marksOf(json, '普通')), []);
  const checks = json.content.find((x) => x.type === 'checklist');
  assert.deepEqual(checks.content.map((i) => [i.attrs.checked, text(i)]), [[true, '済み'], [false, '未']]);
  const at = (s) => blocks.findIndex(([, t]) => t === s);
  assert.deepEqual(blocks.slice(at('文の前'), at('前で改ページ') + 1).map(([type]) => type), ['paragraph', 'page_break', 'paragraph', 'page_break', 'paragraph']);
  assert.deepEqual(blocks.slice(at('テキストボックスの前'), at('テキストボックスの前') + 2), [['paragraph', 'テキストボックスの前'], ['paragraph', '箱の中']]);
  assert.equal(all(json, (x) => x.type === 'text' && x.text === '箱の中').length, 1, 'text box read once');
  const imgs = byType(json, 'image');
  assert.deepEqual(imgs.map((i) => [i.attrs.alt, i.attrs.width, i.attrs.align]), [['VML画像', 16.9, 'left'], ['右の図', 33.3, 'right']]);
  assert.equal(blocks[at('章の終わり') + 1][0], 'page_break', 'a section break starts a new page');
  const table = byType(json, 'table')[0];
  assert.deepEqual(table.content.map((row) => row.content.map((c) => [text(c), c.attrs.colspan, c.attrs.rowspan, c.attrs.background])), [
    [['縦', 1, 2, 'red'], ['B1', 1, 1, null], ['C1', 1, 1, null]],
    [['BC2', 2, 1, null]],
    [['', 1, 1, null], ['B3', 1, 1, null], ['', 1, 1, null]],
  ]);
  assert.deepEqual(table.content[0].content.map((c) => c.attrs.colwidth), [[100], [100], [100]]);
  assert.ok(blocks.some(([, t]) => t === 'x+1'), 'equation text');
  assert.deepEqual(byType(json, 'footnote').map((f) => f.attrs.text), ['脚注の文', '文末脚注']);
});

await test('import: an empty body gives one empty paragraph', async () => {
  if (!has('zip')) return skip('empty body', 'zip not installed');
  await makeDocx('empty.docx', { 'word/document.xml': `<?xml version="1.0"?><w:document ${NS}><w:body><w:sectPr/></w:body></w:document>` });
  const { json, title } = await importFile('empty.docx');
  assert.equal(title, '');
  assert.deepEqual(json, { type: 'doc', content: [{ type: 'paragraph', attrs: { align: null, indent: 0, lineHeight: null } }] });
});

await test('no page errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
