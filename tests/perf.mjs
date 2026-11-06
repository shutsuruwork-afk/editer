// Performance check with a long document: node tests/perf.mjs (after npm run build).
// Measures opening, typing (per keystroke, including the toolbar/count refresh), counting, saving
// and reloading. EDITER_HTML=path tests another build; SIZE=n sets the paragraph count.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(process.env.EDITER_HTML || path.join(root, 'index.html'));
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;
const SIZE = +process.env.SIZE || 3000;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => window.editer && window.editer.docs.session.current);

// A long document: ~100 characters per paragraph, headings every 60 paragraphs, some lists,
// a table and footnotes.
const created = await page.evaluate(async (size) => {
  const { schema, docs } = window.editer;
  const N = schema.nodes;
  const line = '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。';
  const blocks = [];
  for (let i = 0; i < size; i++) {
    if (i % 60 === 0) blocks.push(N.heading.create({ level: 2 }, schema.text(`第${i / 60 + 1}章`)));
    if (i % 200 === 100) {
      blocks.push(N.bullet_list.create(null, [1, 2, 3].map((k) => N.list_item.create(null, N.paragraph.create(null, schema.text(`項目${k}：${line.slice(0, 30)}`))))));
      continue;
    }
    if (i % 500 === 250) {
      const row = (t) => N.table_row.create(null, [0, 1, 2].map((c) => (t === 'h' ? N.table_header : N.table_cell).create(null, N.paragraph.create(null, schema.text(`セル${c}`)))));
      blocks.push(N.table.create(null, [row('h'), row('c'), row('c')]));
      continue;
    }
    const parts = [schema.text(line.slice(i % 7) + line.slice(0, i % 7))];
    if (i % 300 === 7) parts.push(N.footnote.create({ text: `注 ${i}` }));
    blocks.push(N.paragraph.create(null, parts));
  }
  const doc = N.doc.create(null, blocks);
  const t0 = performance.now();
  await docs.newDoc({ doc, title: '長い文書', focus: true });
  return { ms: performance.now() - t0, chars: doc.textContent.length, blocks: blocks.length };
}, SIZE);

// Open it again from storage (what a reload costs).
await page.reload();
await page.waitForFunction(() => window.editer && window.editer.docs.session.current && window.editer.view.state.doc.childCount > 100);
const nav = await page.evaluate(() => {
  const e = performance.getEntriesByType('navigation')[0];
  return { domContentLoaded: e.domContentLoadedEventEnd, load: e.loadEventEnd };
});
const openMs = await page.evaluate(async () => {
  const { docs, store } = window.editer;
  const id = docs.session.current.id;
  const other = await docs.newDoc({ focus: false });
  const t0 = performance.now();
  await docs.openDoc(id);
  const ms = performance.now() - t0;
  void other;
  return ms;
});

// Typing in the middle: time from each transaction to the end of the next frame (editor update
// + toolbar, count, bubble refresh).
const typing = await page.evaluate(async () => {
  const { view } = window.editer;
  const { TextSelection } = window.editer.pm;
  const mid = Math.floor(view.state.doc.content.size / 2);
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(mid))));
  await new Promise((r) => requestAnimationFrame(() => r()));
  const times = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    view.dispatch(view.state.tr.insertText('あ'));
    const sync = performance.now() - t0;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    times.push({ sync, frame: performance.now() - t0 });
  }
  const pick = (k) => times.map((t) => t[k]).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const s = pick('sync'), f = pick('frame');
  return { syncMedian: q(s, 0.5), syncP95: q(s, 0.95), frameMedian: q(f, 0.5), frameP95: q(f, 0.95) };
});

// Counting the whole document: first time (nothing cached) and after one edit (cached).
const counting = await page.evaluate(() => {
  const { view, docs } = window.editer;
  void docs;
  const json = view.state.doc.toJSON();
  const fresh = window.editer.schema.nodeFromJSON(json);
  const { stats } = window.editer.text;
  let t0 = performance.now();
  stats(fresh);
  const cold = performance.now() - t0;
  view.dispatch(view.state.tr.insertText('い'));
  t0 = performance.now();
  stats(view.state.doc);
  const warm = performance.now() - t0;
  return { cold, warm };
});

// Saving: one save of the long document, and its parts.
const saving = await page.evaluate(async () => {
  const { view, docs } = window.editer;
  const doc = view.state.doc;
  let t0 = performance.now();
  const json = doc.toJSON();
  const toJSON = performance.now() - t0;
  t0 = performance.now();
  const size = JSON.stringify(json).length;
  const stringify = performance.now() - t0;
  view.dispatch(view.state.tr.insertText('う'));
  t0 = performance.now();
  await docs.save();
  const save = performance.now() - t0;
  return { toJSON, stringify, save, jsonKB: Math.round(size / 1024) };
});

// Far parts of the document are still reachable (blocks off screen are not laid out until needed).
const reach = await page.evaluate(async () => {
  const { view } = window.editer;
  const sc = document.querySelector('#scroller');
  const inView = (el) => { const a = el.getBoundingClientRect(), b = sc.getBoundingClientRect(); return a.top >= b.top - 2 && a.top < b.bottom; };
  const heads = Array.from(view.dom.querySelectorAll('h2'));
  const target = heads[heads.length - 3];
  const { TextSelection } = window.editer.pm;
  const pos = view.posAtDOM(target, 0);
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))).scrollIntoView());
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const caretShown = inView(target);
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView());
  view.dispatch(view.state.tr.insertText('末尾に追加'));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const last = view.dom.lastElementChild.previousElementSibling && view.dom.lastElementChild.matches('section') ? view.dom.lastElementChild.previousElementSibling : view.dom.lastElementChild;
  return { caretShown, endShown: inView(last) || last.getBoundingClientRect().bottom <= sc.getBoundingClientRect().bottom + 2, endText: view.state.doc.lastChild.textContent.endsWith('末尾に追加') };
});

// Typing fast in a long document (new paragraphs and lists made by keystrokes) loses nothing.
await page.evaluate(() => {
  const { view, schema } = window.editer;
  const { TextSelection } = window.editer.pm;
  const end = view.state.doc.content.size;
  const tr = view.state.tr.insert(end, schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, end + 1));
  view.focus();
  view.dispatch(tr.scrollIntoView());
});
await page.waitForTimeout(100);
await page.keyboard.type('- りんご');
await page.keyboard.press('Enter');
await page.keyboard.type('みかん');
await page.keyboard.press('Enter');
await page.keyboard.press('Enter');
await page.keyboard.type('## 見出し');
await page.keyboard.press('Enter');
await page.keyboard.type('おわり');
const fastTyping = await page.evaluate(() => {
  const md = window.editer.toMarkdown(window.editer.view.state.doc);
  const body = md.split(/\n\n\[\^1\]: /)[0];
  return /\n- りんご\n- みかん\n\n## 見出し\n\nおわり\n*$/.test(body) ? 'ok' : body.slice(-120);
});

const r = (n) => Math.round(n * 10) / 10;
console.log(`document: ${created.blocks} blocks, ${created.chars.toLocaleString()} characters (created + first save ${r(created.ms)} ms)`);
console.log(`page: DOMContentLoaded ${r(nav.domContentLoaded)} ms, load ${r(nav.load)} ms; opening the document from storage ${r(openMs)} ms`);
console.log(`typing: per keystroke ${r(typing.syncMedian)} ms (p95 ${r(typing.syncP95)}), until the next frame ${r(typing.frameMedian)} ms (p95 ${r(typing.frameP95)})`);
console.log(`counting: whole document ${r(counting.cold)} ms uncached, ${r(counting.warm)} ms after an edit`);
console.log(`saving: ${r(saving.save)} ms (toJSON ${r(saving.toJSON)} ms, JSON ${saving.jsonKB} KB)`);
console.log(`typing fast at the end of the long document: ${fastTyping}`);
console.log(`reaching far parts: heading scrolled into view ${reach.caretShown}, end of document shown ${reach.endShown}, typed at the end ${reach.endText}`);
if (errors.length) console.log('errors:', errors);
await browser.close();
server.close();
