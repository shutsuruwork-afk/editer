// End-to-end check in a real browser: node tests/smoke.mjs (after npm run build)
// Set SHOTS=dir to also save screenshots.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Playwright is preinstalled globally in some environments; fall back to a local install.
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(root, 'index.html'));
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;
const shots = process.env.SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const browser = await chromium.launch();
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); }
}

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForSelector('.ProseMirror');
const md = () => page.evaluate(() => window.editer.toMarkdown(window.editer.view.state.doc));
const ed = page.locator('.ProseMirror');
const mod = 'Control';

await test('loads without errors', async () => {
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('.toolbar .icon').count() > 20, true);
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
  const out = await md();
  assert.match(out, /^# 見出しです$/m);
  assert.match(out, /これは \*\*太字\*\* と \*斜体\* です。/);
  assert.match(out, /^- りんご\n- みかん$/m);
  assert.match(out, /^- \[ \] 買い物$/m);
  assert.match(out, /^> 引用文$/m);
  assert.match(out, /^---$/m);
  assert.match(out, /^おわり$/m);
});

await test('toolbar: bold/italic toggles and style menu', async () => {
  await page.keyboard.press('Enter');
  await page.locator('button[aria-label="太字"]').click();
  await page.keyboard.type('ボタン太字');
  await page.locator('button[aria-label="太字"]').click();
  await page.keyboard.type(' 普通');
  assert.match(await md(), /\*\*ボタン太字\*\* 普通/);
  await page.locator('.style-btn').click();
  await page.locator('.menu-item', { hasText: '見出し 2' }).click();
  assert.match(await md(), /^## \*\*ボタン太字\*\* 普通$/m);
  assert.equal(await page.locator('#styleLabel').textContent(), '見出し 2');
});

await test('keyboard: Ctrl+Alt+0 back to normal text, Ctrl+Shift+8 bullet list', async () => {
  await page.keyboard.press(`${mod}+Alt+0`);
  assert.match(await md(), /^\*\*ボタン太字\*\* 普通$/m);
  await page.keyboard.press(`${mod}+Shift+8`);
  assert.match(await md(), /^- \*\*ボタン太字\*\* 普通$/m);
  await page.keyboard.press(`${mod}+Shift+8`);
  assert.match(await md(), /^\*\*ボタン太字\*\* 普通$/m);
});

await test('table: insert from picker, type, add row', async () => {
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.locator('button[aria-label="表を挿入"]').click();
  await page.locator('.grid-pick button[data-r="2"][data-c="3"]').click();
  await page.keyboard.type('名前');
  await page.keyboard.press('Tab');
  await page.keyboard.type('年');
  assert.equal(await page.locator('.table-tools').isVisible(), true);
  await page.locator('button[aria-label="下に行を挿入"]').click();
  const out = await md();
  assert.match(out, /\| 名前 \| 年 \|\s+\|/);
  assert.equal((out.match(/^\|/gm) || []).length, 4); // header, divider, 2 rows
});

await test('link: Ctrl+K dialog', async () => {
  await page.locator('.ProseMirror > p').last().click();
  await page.waitForTimeout(50); // let the editor pick up the click's caret position
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${mod}+k`);
  await page.fill('#linkText', 'サイト');
  await page.fill('#linkUrl', 'example.com');
  await page.keyboard.press('Enter');
  assert.match(await md(), /\[サイト\]\(https:\/\/example\.com\)/);
});

await test('find and replace', async () => {
  await page.keyboard.press(`${mod}+h`);
  await page.fill('#findInput', 'りんご');
  await page.waitForFunction(() => document.querySelector('#findCount').textContent.includes('1'));
  await page.fill('#replaceInput', 'ぶどう');
  await page.click('#replaceAll');
  assert.match(await md(), /- ぶどう/);
  await page.click('#findClose');
});

await test('saves and survives reload', async () => {
  await page.fill('#docTitle', 'テスト文書');
  await page.waitForFunction(() => document.querySelector('#saveText').textContent === '保存済み', null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const before = await md();
  await page.reload();
  await page.waitForSelector('.ProseMirror');
  await page.waitForFunction(() => document.querySelector('#docTitle').value === 'テスト文書');
  assert.equal(await md(), before);
});

await test('multiple documents: new, switch, delete', async () => {
  await page.click('#btnMore');
  await page.locator('.menu-item', { hasText: '新しい文書' }).click();
  await ed.click();
  await page.keyboard.type('二つめの文書');
  await page.waitForFunction(() => document.querySelector('#saveText').textContent === '保存済み');
  await page.click('#btnDrawer');
  await page.waitForSelector('.doc-item');
  assert.equal(await page.locator('.doc-item').count(), 2);
  await page.locator('.doc-open', { hasText: 'テスト文書' }).click();
  await page.waitForFunction(() => document.querySelector('#docTitle').value === 'テスト文書');
  await page.click('#btnDrawer');
  await page.locator('.doc-item', { hasText: '二つめの文書' }).locator('.icon').click();
  await page.locator('.menu-item', { hasText: '削除' }).click();
  await page.click('#confirmOk');
  await page.waitForTimeout(400);
  const left = await page.evaluate(async () => (await window.editer.store.listDocs()).length);
  assert.equal(left, 1);
});

await test('empty new document is not kept', async () => {
  await page.keyboard.press('Escape');
  await page.click('#btnMore');
  await page.locator('.menu-item', { hasText: '新しい文書' }).click();
  await page.click('#btnDrawer');
  await page.locator('.doc-open', { hasText: 'テスト文書' }).click();
  await page.waitForTimeout(300);
  const left = await page.evaluate(async () => (await window.editer.store.listDocs()).length);
  assert.equal(left, 1);
});

await test('paste from Google Docs-like HTML keeps formatting but not the wrapper bold', async () => {
  await page.locator('.ProseMirror > p').last().click();
  await page.waitForTimeout(50); // let the editor pick up the click's caret position
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700">強い</span><span style="font-weight:400">普通</span><span style="font-style:italic">傾き</span></p><ul><li><p>項目A</p></li></ul></b>');
    dt.setData('text/plain', '強い普通傾き\n項目A');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector('.ProseMirror').dispatchEvent(ev);
  });
  const out = await md();
  assert.match(out, /\*\*強い\*\*普通\*傾き\*/);
  assert.match(out, /^- 項目A$/m);
});

await test('markdown import round trip', async () => {
  const out = await page.evaluate(() => {
    const src = '# T\n\n- [x] done\n- [ ] todo\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~消す~~ と `code`\n';
    return window.editer.toMarkdown(window.editer.fromMarkdown(src));
  });
  assert.match(out, /^- \[x\] done\n- \[ \] todo$/m);
  assert.match(out, /^\| a \| b \|$/m);
  assert.match(out, /~~消す~~ と `code`/);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKUlEQVR4nO3OMQEAAAgDoGv/0hnDQwNJAAAAAAAAAAAAAAAAAAAAeLgbtgABQ3mTCAAAAABJRU5ErkJggg==', 'base64');

await test('image: insert from file, resize presets', async () => {
  await page.locator('.ProseMirror > p').last().click();
  await page.waitForTimeout(50);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.setInputFiles('#fileImage', { name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.ProseMirror figure.img img');
  await page.locator('.ProseMirror figure.img').click();
  await page.waitForSelector('#bubble:not([hidden])');
  await page.locator('#bubble .tbtn', { hasText: '中' }).click();
  const w = await page.evaluate(() => { let w = null; window.editer.view.state.doc.descendants((n) => { if (n.type.name === 'image') w = n.attrs.width; }); return w; });
  assert.equal(w, 50);
  assert.match(await md(), /!\[pic\]\(data:image\/png;base64,/);
});

await test('checklist: clicking the box checks it; undo reverts', async () => {
  await page.locator('.ProseMirror .check').first().click();
  assert.match(await md(), /^- \[x\] 買い物$/m);
  await page.locator('.ProseMirror > p').last().click();
  await page.keyboard.press(`${mod}+z`);
  assert.match(await md(), /^- \[ \] 買い物$/m);
});

await test('clicking below the text puts the caret at the end', async () => {
  await page.locator('#scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const box = await page.locator('#page').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  await page.waitForTimeout(50);
  await page.keyboard.type('末尾');
  const out = await md();
  assert.match(out.trim(), /末尾$/);
});

await test('open a Markdown file as a new document', async () => {
  const before = await page.evaluate(async () => (await window.editer.store.listDocs()).length);
  await page.setInputFiles('#fileImport', { name: 'メモ.md', mimeType: 'text/markdown', buffer: Buffer.from('# 読み込んだ題\n\n本文 **太い**\n\n1. いち\n2. に\n') });
  await page.waitForFunction(() => document.querySelector('#docTitle').value === '読み込んだ題');
  const out = await md();
  assert.match(out, /本文 \*\*太い\*\*/);
  assert.match(out, /^1\. いち\n2\. に$/m);
  const after = await page.evaluate(async () => (await window.editer.store.listDocs()).length);
  assert.equal(after, before + 1);
});

await test('no errors along the way', async () => { assert.deepEqual(errors, []); });

// the previous app's manuscript is brought over once
{
  const c2 = await browser.newContext();
  await c2.addInitScript(() => {
    if (!localStorage.getItem('genkocho/v2')) localStorage.setItem('genkocho/v2', JSON.stringify({ v: 2, title: '雨の古書店', md: '# 第一章\n　駅前の商店街。\n「いらっしゃい」', pristine: false }));
  });
  const p2 = await c2.newPage();
  await p2.goto(url);
  await p2.waitForSelector('.ProseMirror');
  await test('migrates the 原稿帳 manuscript', async () => {
    await p2.waitForFunction(() => document.querySelector('#docTitle').value === '雨の古書店');
    const out = await p2.evaluate(() => window.editer.toMarkdown(window.editer.view.state.doc));
    assert.match(out, /^# 第一章$/m);
    assert.match(out, /駅前の商店街。/);
    await p2.reload();
    await p2.waitForSelector('.ProseMirror');
    await p2.waitForTimeout(300);
    const n = await p2.evaluate(async () => (await window.editer.store.listDocs()).length);
    assert.equal(n, 1);
  });
  await c2.close();
}

if (shots) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(shots, 'desktop.png') });
  await page.click('#btnDrawer');
  await page.click('#tabOutline');
  await page.screenshot({ path: path.join(shots, 'desktop-outline.png') });
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(shots, 'desktop-dark.png') });
}

// phone
const phone = await browser.newContext({ ...devices['iPhone 13'] });
const pp = await phone.newPage();
const perr = [];
pp.on('pageerror', (e) => perr.push(e.message));
await pp.goto(url);
await pp.waitForSelector('.ProseMirror');
await test('phone: loads, toolbar scrolls, typing works', async () => {
  await pp.locator('.ProseMirror').tap();
  await pp.keyboard.type('スマホで入力');
  const out = await pp.evaluate(() => window.editer.toMarkdown(window.editer.view.state.doc));
  assert.match(out, /スマホで入力/);
  const sw = await pp.evaluate(() => { const t = document.querySelector('#toolbar'); return t.scrollWidth > t.clientWidth; });
  assert.equal(sw, true);
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  assert.deepEqual(perr, []);
});
if (shots) await pp.screenshot({ path: path.join(shots, 'phone.png') });

await browser.close();
server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
