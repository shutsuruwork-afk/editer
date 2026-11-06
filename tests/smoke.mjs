// End-to-end checks in a real browser: node tests/smoke.mjs (after npm run build).
// EDITER_HTML=path tests another build; SHOTS=dir also saves screenshots; ONLY=text runs matching tests.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Playwright is preinstalled globally in some environments; fall back to a local install.
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(process.env.EDITER_HTML || path.join(root, 'index.html'));
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;
const shots = process.env.SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'editer-test-'));

const browser = await chromium.launch();
let failed = 0, passed = 0;
async function test(name, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) {
    failed++;
    console.log('FAIL', name, '\n     ', String(e.message).split('\n').slice(0, 8).join('\n      '));
    if (e instanceof TypeError) console.log('     ', String(e.stack).split('\n').slice(1, 3).join('\n      '));
    if (process.env.VERBOSE) console.log(e.message);
  }
}

async function open(opts = { viewport: { width: 1280, height: 860 } }, context = null) {
  const ctx = context || await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForSelector('#editor .ProseMirror');
  await page.waitForFunction(() => window.editer && window.editer.docs.session.current);
  return { ctx, page, errors };
}

const md = (page) => page.evaluate(() => window.editer.toMarkdown(window.editer.view.state.doc));
const docJSON = (page) => page.evaluate(() => window.editer.view.state.doc.toJSON());
const settle = (page) => page.waitForTimeout(60);
async function calm(page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  if (await page.locator('#drawer').isVisible()) await page.click('#drawerClose');
}
async function endOfDoc(page) {
  await page.evaluate(() => {
    const { view } = window.editer;
    const { TextSelection } = window.editer.pm;
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  });
}
// a fresh top-level paragraph at the end, with the caret in it
async function newParagraph(page) {
  await page.evaluate(() => {
    const { view, schema } = window.editer;
    const { TextSelection } = window.editer.pm;
    const end = view.state.doc.content.size;
    const tr = view.state.tr.insert(end, schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, end + 1));
    view.focus();
    view.dispatch(tr);
  });
  await page.waitForTimeout(30);
}
async function newDoc(page) {
  await calm(page);
  await page.evaluate(() => window.editer.docs.newDoc({ focus: true }));
  await page.waitForFunction(() => window.editer.view.state.doc.textContent === '');
  await page.locator('#editor .ProseMirror').click();
}
const saved = (page) => page.waitForFunction(() => !window.editer.docs.session.dirty && !window.editer.docs.session.saving && document.querySelector('#saveText').textContent === '保存済み', null, { timeout: 8000 });
const marksOf = (json, text) => {
  let found = null;
  const walk = (n) => { if (n.type === 'text' && n.text.includes(text)) found = (n.marks || []); (n.content || []).forEach(walk); };
  walk(json);
  return found;
};
const nodesOf = (json, type) => {
  const out = [];
  const walk = (n) => { if (n.type === type) out.push(n); (n.content || []).forEach(walk); };
  walk(json);
  return out;
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKUlEQVR4nO3OMQEAAAgDoGv/0hnDQwNJAAAAAAAAAAAAAAAAAAAAeLgbtgABQ3mTCAAAAABJRU5ErkJggg==', 'base64');

// =====================================================================================
// Editing
// =====================================================================================
{
  const { page, errors, ctx } = await open();
  const ed = page.locator('#editor .ProseMirror');
  const mod = 'Control';

  await test('loads without errors', async () => {
    assert.deepEqual(errors, []);
    assert.ok(await page.locator('.toolbar .icon').count() > 25);
  });

  await test('typing shortcuts: heading, bold, list, checklist, quote, rule', async () => {
    await ed.click();
    await page.keyboard.type('# 見出しです');
    await page.keyboard.press('Enter');
    await page.keyboard.type('これは **太字** と *斜体* です。');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- りんご');
    await page.keyboard.press('Enter');
    await page.keyboard.type('みかん');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('[] 買い物');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('> 引用文');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('---');
    await page.keyboard.type('おわり');
    const out = await md(page);
    assert.match(out, /^# 見出しです$/m);
    assert.match(out, /これは \*\*太字\*\* と \*斜体\* です。/);
    assert.match(out, /^- りんご\n- みかん$/m);
    assert.match(out, /^- \[ \] 買い物$/m);
    assert.match(out, /^> 引用文$/m);
    assert.match(out, /^---$/m);
    assert.match(out, /^おわり$/m);
  });

  await test('toolbar: bold toggles and style menu', async () => {
    await page.keyboard.press('Enter');
    await page.locator('button[aria-label="太字"]').click();
    await page.keyboard.type('ボタン太字');
    await page.locator('button[aria-label="太字"]').click();
    await page.keyboard.type(' 普通');
    assert.match(await md(page), /\*\*ボタン太字\*\* 普通/);
    await page.locator('.style-btn').click();
    await page.locator('.menu-item', { hasText: '見出し 2' }).click();
    assert.match(await md(page), /^## \*\*ボタン太字\*\* 普通$/m);
    assert.equal(await page.locator('.style-btn .lbl').textContent(), '見出し 2');
  });

  await test('keyboard: Ctrl+Alt+0 back to normal text, Ctrl+Shift+8 bullet list', async () => {
    await page.keyboard.press(`${mod}+Alt+0`);
    assert.match(await md(page), /^\*\*ボタン太字\*\* 普通$/m);
    await page.keyboard.press(`${mod}+Shift+8`);
    assert.match(await md(page), /^- \*\*ボタン太字\*\* 普通$/m);
    await page.keyboard.press(`${mod}+Shift+8`);
    assert.match(await md(page), /^\*\*ボタン太字\*\* 普通$/m);
  });

  await test('table: insert from picker, Tab adds a row at the end, add row, distribute', async () => {
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.locator('button[aria-label="表を挿入"]').click();
    await page.locator('.grid-pick button[data-r="2"][data-c="2"]').click();
    await page.keyboard.type('名前');
    await page.keyboard.press('Tab');
    await page.keyboard.type('年');
    assert.equal(await page.locator('.table-tools').isVisible(), true);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab'); // last cell → new row
    await page.keyboard.type('追加行');
    let out = await md(page);
    assert.match(out, /\| 名前 \| 年 \|/);
    assert.match(out, /\| 追加行 \|/);
    assert.equal((out.match(/^\|/gm) || []).length, 4); // header, divider, 2 rows... + new row
    await page.locator('button[aria-label="下に行を挿入"]').click();
    out = await md(page);
    assert.equal((out.match(/^\|/gm) || []).length, 5);
    await page.locator('button[aria-label="列の幅を揃える"]').click();
  });

  await test('link: Ctrl+K dialog', async () => {
    await endOfDoc(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${mod}+k`);
    await page.fill('#linkText', 'サイト');
    await page.fill('#linkUrl', 'example.com');
    await page.keyboard.press('Enter');
    assert.match(await md(page), /\[サイト\]\(https:\/\/example\.com\)/);
  });

  await test('find and replace', async () => {
    await page.keyboard.press(`${mod}+h`);
    await page.fill('#findInput', 'りんご');
    await page.waitForFunction(() => document.querySelector('#findCount').textContent.includes('1'));
    await page.fill('#replaceInput', 'ぶどう');
    await page.click('#replaceAll');
    assert.match(await md(page), /- ぶどう/);
    await page.click('#findClose');
  });

  await test('font size, font, superscript, line spacing, indent', async () => {
    await newParagraph(page);
    await page.keyboard.type('大きな文字');
    await page.keyboard.press('Shift+Home');
    await settle(page);
    await page.locator('button[aria-label="フォントサイズを大きく"]').click();
    await page.locator('.font-btn').click();
    await page.locator('.menu-item', { hasText: '明朝' }).click();
    let marks = marksOf(await docJSON(page), '大きな文字');
    assert.ok(marks && marks.find((m) => m.type === 'fontSize') && marks.find((m) => m.type === 'fontFamily'), 'marks: ' + JSON.stringify(marks));
    assert.deepEqual(marks.find((m) => m.type === 'fontSize').attrs, { size: 12 });
    assert.deepEqual(marks.find((m) => m.type === 'fontFamily').attrs, { family: 'serif' });
    assert.equal(await page.locator('.size-btn .lbl').textContent(), '12');
    await page.keyboard.press(`${mod}+Shift+.`);
    marks = marksOf(await docJSON(page), '大きな文字');
    assert.equal(marks.find((m) => m.type === 'fontSize').attrs.size, 14);
    await page.keyboard.press('End');
    await settle(page);
    await page.keyboard.press(`${mod}+.`);
    await page.keyboard.type('2');
    marks = marksOf(await docJSON(page), '2');
    assert.ok(marks.some((m) => m.type === 'sup'));
    await page.locator('button[aria-label="行間隔"]').click();
    await page.locator('.menu-item', { hasText: '1.5' }).click();
    await page.keyboard.press(`${mod}+]`);
    const all = await docJSON(page);
    const para = all.content.find((n) => (n.content || []).some((t) => t.text && t.text.includes('大きな文字')));
    assert.ok(para, JSON.stringify(all.content.slice(-3)));
    assert.equal(para.attrs.lineHeight, '1.5');
    assert.equal(para.attrs.indent, 1);
    await page.keyboard.press(`${mod}+[`);
    const para2 = (await docJSON(page)).content.find((n) => (n.content || []).some((t) => t.text && t.text.includes('大きな文字')));
    assert.equal(para2.attrs.indent, 0);
  });

  await test('page break, footnote, table of contents', async () => {
    await newParagraph(page);
    await page.keyboard.type('脚注を付ける文');
    await page.keyboard.press(`${mod}+Alt+f`);
    await page.waitForSelector('#footnoteDialog[open]');
    await page.fill('#footnoteText', '出典の説明');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#footnoteDialog').open);
    await page.keyboard.type('。続き');
    await page.keyboard.press(`${mod}+Enter`);
    await page.keyboard.type('次のページ');
    const json = await docJSON(page);
    assert.equal(nodesOf(json, 'footnote')[0].attrs.text, '出典の説明');
    assert.equal(nodesOf(json, 'page_break').length, 1);
    assert.equal(await page.locator('.ProseMirror .footnotes li').first().textContent(), '出典の説明');
    const out = await md(page);
    assert.match(out, /脚注を付ける文\[\^1\]。続き/);
    assert.match(out, /^\[\^1\]: 出典の説明$/m);
    // table of contents at the top
    await page.evaluate(() => { const { view } = window.editer; const { TextSelection } = window.editer.pm; view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc))); view.focus(); });
    await page.keyboard.press('End');
    await page.locator('button[aria-label="挿入"]').click();
    await page.locator('.menu-item', { hasText: '目次' }).click();
    await page.waitForSelector('.ProseMirror nav.toc li');
    assert.equal(await page.locator('.ProseMirror nav.toc li').first().textContent(), '見出しです');
    await page.locator('.ProseMirror nav.toc a').first().click();
    await settle(page);
    assert.equal(await page.evaluate(() => window.editer.view.state.selection.$from.parent.type.name), 'heading');
    assert.match(await md(page), /^\[TOC\]$/m);
  });

  await test('paint format and copy/paste format', async () => {
    await newParagraph(page);
    await page.keyboard.type('AAA BBB CCC');
    // make AAA bold + red
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await settle(page);
    await page.keyboard.press(`${mod}+b`);
    await page.locator('button[aria-label="文字の色"]').click();
    await page.locator('.swatch[aria-label="赤"]').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    await page.locator('button[aria-label^="書式のコピー"]').click();
    await page.waitForTimeout(300);
    await page.locator('.ProseMirror p', { hasText: 'AAA BBB CCC' }).getByText('AAA BBB CCC').dblclick({ position: { x: 60, y: 8 } });
    await page.waitForTimeout(100);
    let json = await docJSON(page);
    const bbb = marksOf(json, 'BBB');
    assert.ok(bbb && bbb.some((m) => m.type === 'strong') && bbb.some((m) => m.type === 'color'), 'brush applied to BBB: ' + JSON.stringify(bbb));
    // keyboard: Ctrl+Alt+C on AAA, select CCC, Ctrl+Alt+V
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    await page.keyboard.press(`${mod}+Alt+c`);
    await page.keyboard.press('End');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
    await settle(page);
    await page.keyboard.press(`${mod}+Alt+v`);
    json = await docJSON(page);
    const ccc = marksOf(json, 'CCC');
    assert.ok(ccc && ccc.some((m) => m.type === 'strong'), 'pasted format on CCC');
  });

  await test('list styles and restarting numbers', async () => {
    await newParagraph(page);
    await page.keyboard.type('1. 一つめ');
    await page.keyboard.press('Enter');
    await page.keyboard.type('二つめ');
    await page.keyboard.press('Enter');
    await page.keyboard.type('三つめ');
    await page.locator('button[aria-label="番号の形式"]').click();
    await page.locator('.menu-item', { hasText: /^a\. b\. c\.$/ }).click();
    let lists = nodesOf(await docJSON(page), 'ordered_list');
    assert.equal(lists[lists.length - 1].attrs.style, 'lower-alpha');
    await page.keyboard.press('ArrowUp');
    await settle(page);
    await page.locator('button[aria-label="番号の形式"]').click();
    await page.locator('.menu-item', { hasText: 'ここから番号を振り直す' }).click();
    lists = nodesOf(await docJSON(page), 'ordered_list');
    assert.equal(lists.length, 2);
    assert.equal(lists[1].attrs.order, 1);
    assert.equal(lists[1].content.length, 2);
  });

  await test('image: stored once as a blob, resize and align', async () => {
    await newParagraph(page);
    await page.setInputFiles('#fileImage', { name: 'pic.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('.ProseMirror figure.img img[src^="blob:"]');
    await endOfDoc(page);
    await page.setInputFiles('#fileImage', { name: 'pic2.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror figure.img').length === 2);
    const imgs = nodesOf(await docJSON(page), 'image');
    assert.match(imgs[0].attrs.src, /^idb:[0-9a-f]+$/);
    assert.equal(imgs[0].attrs.src, imgs[1].attrs.src, 'same picture → same stored image');
    const blobs = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('editer'); r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').count(); q.onsuccess = () => res(q.result); }; }));
    assert.equal(blobs, 1);
    await page.locator('.ProseMirror figure.img').first().click();
    await page.waitForSelector('#bubble:not([hidden])');
    await page.locator('#bubble .tbtn', { hasText: '中' }).click();
    await page.locator('#bubble button[aria-label="右寄せ"]').click();
    const img = nodesOf(await docJSON(page), 'image')[0];
    assert.equal(img.attrs.width, 50);
    assert.equal(img.attrs.align, 'right');
    // exports carry the picture inline
    const html = await page.evaluate(() => window.editer.exportHtml());
    assert.match(html, /src="data:image\/png;base64,/);
  });

  await test('checklist: clicking the box checks it; undo reverts', async () => {
    await page.locator('.ProseMirror .check').first().click();
    assert.match(await md(page), /^- \[x\] 買い物$/m);
    await page.keyboard.press(`${mod}+z`);
    assert.match(await md(page), /^- \[ \] 買い物$/m);
  });

  await test('clicking below the text puts the caret at the end', async () => {
    await page.locator('#scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const box = await page.locator('#page').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
    await settle(page);
    await page.keyboard.type('末尾');
    assert.match((await md(page)).trim(), /末尾(\n\n\[\^1\]: .*)?$/);
  });

  await test('paste from Google Docs keeps formatting, sizes and page breaks, not the wrapper bold', async () => {
    await newParagraph(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr" style="line-height:1.38;margin-left:36pt"><span style="font-size:11pt;font-weight:700">強い</span><span style="font-size:11pt;font-weight:400">普通</span><span style="font-size:18pt;font-style:italic">傾き</span></p><hr style="page-break-before:always;display:none;"><ul><li><p>項目A</p></li></ul></b>');
      dt.setData('text/plain', '強い普通傾き\n項目A');
      document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const out = await md(page);
    assert.ok(/^- 項目A$/m.test(out), out.slice(-300));
    assert.match(out, /\*\*強い\*\*普通\*傾き\*/);
    assert.match(out, /^- 項目A$/m);
    const json = await docJSON(page);
    assert.equal(marksOf(json, '傾き').find((m) => m.type === 'fontSize').attrs.size, 18);
    assert.equal(marksOf(json, '強い').find((m) => m.type === 'fontSize'), undefined);
    assert.equal(nodesOf(json, 'page_break').length, 2);
    // paragraph indent / spacing from Docs (36pt per level; its default 1.38 spacing is ignored)
    const attrs = await page.evaluate(() => window.editer.fromHtml('<p style="line-height:1.38;margin-left:72pt">a</p><p style="line-height:1.5">b</p>').toJSON().content.map((n) => n.attrs));
    assert.equal(attrs[0].indent, 2);
    assert.equal(attrs[0].lineHeight, null);
    assert.equal(attrs[1].lineHeight, '1.5');
  });

  await test('markdown round trip incl. checklists, tables, footnotes, TOC', async () => {
    const out = await page.evaluate(() => {
      const src = '[TOC]\n\n# T\n\n- [x] done\n- [ ] todo\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~消す~~ と `code` と<sup>上</sup>[^n]\n\n[^n]: 注の文\n';
      return window.editer.toMarkdown(window.editer.fromMarkdown(src));
    });
    assert.match(out, /^\[TOC\]$/m);
    assert.match(out, /^- \[x\] done\n- \[ \] todo$/m);
    assert.match(out, /^\| a \| b \|$/m);
    assert.match(out, /~~消す~~ と `code` と<sup>上<\/sup>\[\^1\]/);
    assert.match(out, /^\[\^1\]: 注の文$/m);
    // HTML entities in Markdown are decoded (through the browser, see src/shims/entities.js)
    const text = await page.evaluate(() => window.editer.fromMarkdown('A &amp; B &copy; &#x3042; [x](https://e.com/?a=1&amp;b=2)').textContent);
    assert.equal(text, 'A & B © あ x');
    const href = await page.evaluate(() => JSON.stringify(window.editer.fromMarkdown('[x](https://e.com/?a=1&amp;b=2)').toJSON()));
    assert.match(href, /https:\/\/e\.com\/\?a=1&b=2/);
  });

  await test('view-only mode', async () => {
    const before = await md(page);
    await page.click('#btnMore');
    await page.locator('.menu-item', { hasText: '閲覧モード' }).click();
    assert.equal(await page.locator('#toolbar').isVisible(), false);
    assert.equal(await page.locator('#banner').isVisible(), true);
    await page.locator('.ProseMirror p').first().click();
    await page.keyboard.type('入力されない');
    assert.equal(await md(page), before);
    await page.click('#bannerAction');
    assert.equal(await page.locator('#toolbar').isVisible(), true);
  });

  await test('keyboard shortcuts list (Ctrl+/)', async () => {
    await page.locator('.ProseMirror p').first().click();
    await page.keyboard.press(`${mod}+/`);
    await page.waitForSelector('#shortcutsDialog[open]');
    assert.ok(await page.locator('#shortcutsList tr').count() > 20);
    await page.keyboard.press('Escape');
  });

  await test('no errors while editing', async () => { assert.deepEqual(errors, []); });

  if (shots) {
    await calm(page);
    await page.locator('#scroller').evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(shots, 'desktop.png') });
  }
  await ctx.close();
}

// =====================================================================================
// Documents and storage
// =====================================================================================
{
  const { page, errors, ctx } = await open();
  const mod = 'Control';

  await test('saves and survives reload', async () => {
    await page.locator('#editor .ProseMirror').click();
    await page.keyboard.type('最初の文書の本文');
    await page.fill('#docTitle', 'テスト文書');
    await saved(page);
    const before = await md(page);
    await page.reload();
    await page.waitForSelector('#editor .ProseMirror');
    await page.waitForFunction(() => document.querySelector('#docTitle').value === 'テスト文書');
    assert.equal(await md(page), before);
  });

  await test('keeps saving while typing without pauses', async () => {
    await page.locator('#editor .ProseMirror').click();
    await page.keyboard.press('End');
    const start = Date.now();
    let savedDuring = false;
    while (Date.now() - start < 6500) {
      await page.keyboard.type('あ', { delay: 0 });
      await page.waitForTimeout(150);
      const stored = await page.evaluate(async () => (await window.editer.store.getDoc(window.editer.docs.session.current.id)).updatedAt);
      if (stored > start) { savedDuring = true; break; }
    }
    assert.ok(savedDuring, 'a save happened within the max wait while typing');
    await saved(page);
  });

  await test('version history: the state before this visit is kept; preview and restore', async () => {
    await page.reload();
    await page.waitForFunction(() => window.editer.docs.session.current && document.querySelector('#docTitle').value === 'テスト文書');
    const original = await md(page);
    await page.locator('#editor .ProseMirror').click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type('全部書き換えた');
    await saved(page);
    await page.click('#btnHistory');
    await page.waitForSelector('#historyDialog[open] .hv');
    await page.waitForFunction(() => document.querySelectorAll('#historyList button.hv').length >= 2);
    await page.locator('#historyList button.hv').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#historyPreview').textContent.includes('最初の文書の本文'));
    await page.click('#historyRestore');
    await page.click('#confirmOk');
    await page.waitForFunction(() => !document.querySelector('#historyDialog').open);
    await page.waitForFunction(() => window.editer.view.state.doc.textContent.includes('最初の文書の本文'));
    await saved(page);
    assert.equal(await md(page), original);
    // the replaced text is in the history too
    await page.click('#btnHistory');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.hv-name')).some((e) => e.textContent.includes('復元する前')));
    await page.click('#historyName');
    await page.fill('#promptInput', '提出版');
    await page.click('#promptOk');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.hv-name')).some((e) => e.textContent === '提出版'));
    await page.click('#historyClose');
  });

  await test('documents: new, star, filter, search text, trash and undo', async () => {
    await newDoc(page);
    await page.keyboard.type('二つめの文書。りんごの話をします。');
    await page.fill('#docTitle', '二つめ');
    await saved(page);
    await page.click('#btnStar');
    await page.waitForFunction(() => document.querySelector('#btnStar').getAttribute('aria-pressed') === 'true');
    await page.click('#btnDrawer');
    await page.waitForSelector('.doc-item');
    assert.equal(await page.locator('.doc-item').count(), 2);
    await page.locator('.chip[data-view="starred"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 1);
    assert.match(await page.locator('.doc-item').textContent(), /二つめ/);
    await page.locator('.chip[data-view="all"]').click();
    await page.fill('#docsFilter', 'りんごの話');
    await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 1 && document.querySelector('.doc-meta mark'));
    await page.fill('#docsFilter', '');
    await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 2);
    await page.locator('.doc-item', { hasText: '二つめ' }).locator('.icon').click();
    await page.locator('.menu-item', { hasText: 'ゴミ箱に移動' }).click();
    await page.waitForSelector('.toast-action');
    await page.waitForFunction(() => document.querySelector('#docTitle').value === 'テスト文書');
    await page.click('.toast-action');
    await page.waitForFunction(() => document.querySelector('#docTitle').value === '二つめ');
    const trashed = await page.evaluate(async () => (await window.editer.store.listDocs()).filter((m) => m.trashedAt).length);
    assert.equal(trashed, 0);
  });

  await test('trash view: restore and delete for good', async () => {
    await calm(page);
    await page.click('#btnMore');
    await page.locator('.menu-item', { hasText: 'ゴミ箱に移動' }).click();
    await page.waitForFunction(() => document.querySelector('#docTitle').value === 'テスト文書');
    await page.click('#btnDrawer');
    await page.locator('.chip[data-view="trash"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.doc-item').length === 1);
    await page.locator('.doc-item .icon').click();
    await page.locator('.menu-item', { hasText: '完全に削除' }).click();
    await page.click('#confirmOk');
    await page.waitForFunction(async () => (await window.editer.store.listDocs()).length === 1);
    await page.locator('.chip[data-view="all"]').click();
    await calm(page);
  });

  await test('an empty new document is not kept', async () => {
    await newDoc(page);
    await page.evaluate(async () => { const l = await window.editer.store.listDocs(); await window.editer.docs.openDoc(l[0].id); });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(async () => (await window.editer.store.listDocs()).length), 1);
  });

  await test('a document from a newer/broken format opens repaired', async () => {
    await page.evaluate(async () => {
      await window.editer.store.saveDoc({
        id: 'broken1', title: '壊れた', preview: '', chars: 0, createdAt: Date.now(), updatedAt: Date.now(), images: [], text: '',
        settings: {}, content: { type: 'doc', content: [
          { type: 'mystery', content: [{ type: 'paragraph', content: [{ type: 'text', text: '中身は残る', marks: [{ type: 'sparkle' }] }] }] },
          { type: 'table', content: [{ type: 'paragraph', content: [{ type: 'text', text: '表の残骸' }] }] },
        ] },
      }, 0);
    });
    await page.evaluate(() => { location.hash = '#/d/broken1'; });
    await page.waitForFunction(() => document.querySelector('#docTitle').value === '壊れた');
    const text = await page.evaluate(() => window.editer.view.state.doc.textContent);
    assert.match(text, /中身は残る/);
    assert.match(text, /表の残骸/);
    assert.match(await page.locator('#toast').textContent(), /修復/);
    await page.evaluate(() => window.editer.docs.purgeDoc('broken1'));
  });

  await test('two tabs editing the same document: nothing is lost', async () => {
    const id = await page.evaluate(() => window.editer.docs.session.current.id);
    const b = await ctx.newPage();
    await b.goto(url + '#/d/' + id);
    await b.waitForFunction((i) => window.editer && window.editer.docs.session.current && window.editer.docs.session.current.id === i, id);
    // B starts typing (not saved yet), A types and saves at once
    await b.locator('#editor .ProseMirror').click();
    await b.keyboard.press('Control+End');
    await b.keyboard.type('B側の追記');
    await page.locator('#editor .ProseMirror').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('A側の追記');
    await page.keyboard.press(`${mod}+s`);
    await saved(page);
    await saved(b);
    const stored = await page.evaluate(async (i) => JSON.stringify((await window.editer.store.getDoc(i)).content), id);
    assert.match(stored, /B側の追記/);
    const versions = await page.evaluate(async (i) => {
      const list = await window.editer.store.listVersions(i);
      const v = list.find((x) => x.name === '別のタブで保存された内容');
      return v ? JSON.stringify(await window.editer.store.getVersionContent(v.vid)) : null;
    }, id);
    assert.ok(versions && versions.includes('A側の追記'), 'the other tab’s text is in the history');
    // A, which wasn't editing any more, follows B
    await page.waitForFunction(() => window.editer.view.state.doc.textContent.includes('B側の追記'));
    await b.close();
  });

  await test('open a Markdown file as a new document', async () => {
    const before = await page.evaluate(async () => (await window.editer.store.listDocs()).length);
    await page.setInputFiles('#fileImport', { name: 'メモ.md', mimeType: 'text/markdown', buffer: Buffer.from('# 読み込んだ題\n\n本文 **太い**\n\n1. いち\n2. に\n') });
    await page.waitForFunction(() => document.querySelector('#docTitle').value === '読み込んだ題');
    const out = await md(page);
    assert.match(out, /本文 \*\*太い\*\*/);
    assert.match(out, /^1\. いち\n2\. に$/m);
    await saved(page);
    assert.equal(await page.evaluate(async () => (await window.editer.store.listDocs()).length), before + 1);
  });

  await test('Word: download from the menu, open it again', async () => {
    await newDoc(page);
    await page.fill('#docTitle', 'ワード往復');
    await page.press('#docTitle', 'Enter'); // Enter in the title moves on to the text
    await page.keyboard.type('# 章の見出し');
    await page.keyboard.press('Enter');
    await page.keyboard.type('本文に **太字** と脚注');
    await page.keyboard.press(`${mod}+Alt+f`);
    await page.waitForSelector('#footnoteDialog[open]');
    await page.fill('#footnoteText', 'ワードの脚注');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#footnoteDialog').open);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- 箇条書き');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.setInputFiles('#fileImage', { name: 'pic.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('#editor .ProseMirror figure.img img[src^="blob:"]');
    await saved(page);
    await page.click('#btnMore');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.menu-item', { hasText: 'Microsoft Word' }).click()]);
    // the headless test browser replaces non-ASCII file names with "download"; real browsers keep them
    assert.match(download.suggestedFilename(), /^(ワード往復\.docx|download)$/);
    const file = path.join(tmp, 'roundtrip.docx');
    await download.saveAs(file);
    const before = await page.evaluate(() => window.editer.docs.session.current.id);
    await page.setInputFiles('#fileImport', file);
    await page.waitForFunction((id) => window.editer.docs.session.current.id !== id, before, { timeout: 10000 }).catch(async () => {
      throw new Error('no new document; toast: ' + await page.locator('#toast').textContent());
    });
    assert.equal(await page.inputValue('#docTitle'), 'ワード往復');
    const json = await docJSON(page);
    assert.equal(nodesOf(json, 'heading')[0].content[0].text, '章の見出し');
    assert.ok(marksOf(json, '太字').some((m) => m.type === 'strong'));
    assert.equal(nodesOf(json, 'footnote')[0].attrs.text, 'ワードの脚注');
    assert.equal(nodesOf(json, 'bullet_list').length, 1);
    assert.equal(nodesOf(json, 'image').length, 1);
    // the imported picture moves into the image store on the first save
    await saved(page);
    await page.evaluate(() => { window.editer.docs.markDirty(); return window.editer.docs.save(); });
    assert.match(nodesOf(await docJSON(page), 'image')[0].attrs.src, /^idb:/);
  });

  await test('backup and restore into another browser profile', async () => {
    await page.locator('#editor .ProseMirror').click();
    await page.setInputFiles('#fileImage', { name: 'pic.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('#editor .ProseMirror figure.img img[src^="blob:"]').catch(async (e) => {
      throw new Error(e.message.split('\n')[0] + ' / images: ' + await page.evaluate(() => JSON.stringify(Array.from(document.querySelectorAll('#editor figure.img')).map((f) => [f.className, f.querySelector('img').getAttribute('src')?.slice(0, 30), f.getBoundingClientRect().width]))));
    });
    await saved(page);
    await page.click('#btnMore');
    await page.locator('.menu-item', { hasText: '設定' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btnBackup')]);
    const file = path.join(tmp, 'backup.json');
    await download.saveAs(file);
    await calm(page);
    const other = await open();
    await other.page.click('#btnMore');
    await other.page.locator('.menu-item', { hasText: '設定' }).click();
    await other.page.setInputFiles('#fileBackup', file);
    await other.page.waitForFunction(() => /復元しました/.test(document.querySelector('#toast').textContent));
    const titles = await other.page.evaluate(async () => (await window.editer.store.listDocs()).map((m) => m.title).sort());
    assert.ok(titles.includes('テスト文書') && titles.includes('読み込んだ題'), JSON.stringify(titles));
    // a restored document with a picture shows it (the image came along in the backup)
    await other.page.evaluate(async () => {
      const m = (await window.editer.store.listDocs()).find((x) => x.images && x.images.length);
      await window.editer.docs.openDoc(m.id);
    });
    await other.page.waitForSelector('#editor .ProseMirror figure.img img[src^="blob:"]');
    // restoring the same file again adds nothing
    await other.page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
    await other.page.click('#btnMore');
    await other.page.locator('.menu-item', { hasText: '設定' }).click();
    await other.page.setInputFiles('#fileBackup', file);
    await other.page.waitForFunction(() => /0 件の文書を復元しました/.test(document.querySelector('#toast').textContent));
    await other.ctx.close();
  });

  await test('no errors in document management', async () => { assert.deepEqual(errors, []); });
  await ctx.close();
}

// =====================================================================================
// The previous app's manuscript is brought over once
// =====================================================================================
{
  const c2 = await browser.newContext();
  await c2.addInitScript(() => {
    if (!localStorage.getItem('genkocho/v2')) localStorage.setItem('genkocho/v2', JSON.stringify({ v: 2, title: '雨の古書店', md: '# 第一章\n　駅前の商店街。\n「いらっしゃい」', pristine: false }));
  });
  const { page } = await open(undefined, c2);
  await test('migrates the 原稿帳 manuscript', async () => {
    await page.waitForFunction(() => document.querySelector('#docTitle').value === '雨の古書店');
    const out = await md(page);
    assert.match(out, /^# 第一章$/m);
    assert.match(out, /駅前の商店街。/);
    await page.reload();
    await page.waitForSelector('#editor .ProseMirror');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(async () => (await window.editer.store.listDocs()).length), 1);
  });
  await c2.close();
}

// =====================================================================================
// Phone
// =====================================================================================
{
  const { page, errors, ctx } = await open({ ...devices['iPhone 13'] });
  await test('phone: loads, toolbar scrolls, typing works', async () => {
    await page.locator('#editor .ProseMirror').tap();
    await page.keyboard.type('スマホで入力');
    assert.match(await md(page), /スマホで入力/);
    assert.equal(await page.evaluate(() => { const t = document.querySelector('#toolbar'); return t.scrollWidth > t.clientWidth; }), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
  });
  if (shots) await page.screenshot({ path: path.join(shots, 'phone.png') });
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
