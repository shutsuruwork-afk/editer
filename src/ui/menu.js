// The ⋯ menu: new / open, export (Word, Markdown, HTML, text), print, history, counts, settings,
// view-only mode, full screen, trash.
import { ctx, $, MOD, ALT, SHIFT, UNTITLED } from '../app/ctx.js';
import { session, newDoc, trashDoc, emptyDoc } from '../app/docs.js';
import { firstLine } from '../app/text.js';
import { withInlineImages, loadImageBytes } from '../app/images.js';
import { fromMarkdown, fromHtml, fromText, decodeTextFile, toMarkdown, toHtml, toText } from '../editor/convert.js';
import { docToDocx, docxToDoc } from '../editor/docx.js';
import { openPop, menuItem, menuSep, menuLabel } from './pop.js';
import { toast } from './toast.js';

let actions = {};

function fileBase() {
  const cur = session.current;
  const t = (cur && (cur.title || firstLine(ctx.view.state.doc))) || UNTITLED;
  return t.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 60) || UNTITLED;
}

export async function saveFile(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime + ';charset=utf-8' });
  const c = window.claude;
  const dl = c && typeof c.use === 'function' ? await c.use('downloads').catch(() => null) : null;
  if (dl) {
    try {
      const payload = /^(text\/|application\/json)/.test(blob.type) ? await blob.text() : blob;
      await dl.save({ filename, data: payload });
      toast('書き出しました');
    } catch (e) { if (!e || e.code !== 'declined') toast('書き出せませんでした' + (e && e.message ? '：' + e.message : '')); }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportAs(kind) {
  const cur = session.current;
  const title = (cur && cur.title) || firstLine(ctx.view.state.doc) || UNTITLED;
  try {
    if (kind === 'docx') {
      const blob = await docToDocx(ctx.view.state.doc, { title, loadImage: loadImageBytes });
      await saveFile(`${fileBase()}.docx`, blob);
      return;
    }
    const doc = await withInlineImages(ctx.view.state.doc);
    if (kind === 'md') await saveFile(`${fileBase()}.md`, (cur && cur.title ? `# ${cur.title}\n\n` : '') + toMarkdown(doc), 'text/markdown');
    else if (kind === 'html') await saveFile(`${fileBase()}.html`, toHtml(doc, title), 'text/html');
    else await saveFile(`${fileBase()}.txt`, toText(doc), 'text/plain');
  } catch (err) {
    console.error(err);
    toast('書き出せませんでした');
  }
}

export async function importFile(file) {
  try {
    const name = file.name.replace(/\.[^.]+$/, '');
    let doc, title = name;
    if (/\.docx$/i.test(file.name)) {
      const r = await docxToDoc(await file.arrayBuffer());
      doc = r.doc;
      title = r.title || name;
    } else {
      const text = decodeTextFile(await file.arrayBuffer());
      if (/\.html?$/i.test(file.name)) doc = fromHtml(text);
      else if (/\.(md|markdown)$/i.test(file.name)) {
        // a leading "# Title" becomes the document title
        const m = /^# (.+)\n+/.exec(text);
        if (m) { title = m[1].trim(); doc = fromMarkdown(text.slice(m[0].length)); }
        else doc = fromMarkdown(text);
      } else doc = fromText(text);
    }
    if (!doc || !doc.childCount) doc = emptyDoc();
    await newDoc({ doc, title, focus: false });
    toast(`「${title}」を開きました`);
  } catch (err) {
    console.error(err);
    toast(err && err.message && /[ぁ-んァ-ン一-龥]/.test(err.message) ? err.message : 'このファイルは開けませんでした', 5000);
  }
}

export function initMenu(a) {
  actions = a;
  $('#fileImport').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) await importFile(file);
  });
  $('#btnMore').addEventListener('click', (e) => openPop(e.currentTarget, (p) => {
    const editable = ctx.view.editable;
    p.append(menuItem({ icon: 'plus', label: '新しい文書', onClick: () => newDoc({ focus: !ctx.touch.matches }) }));
    p.append(menuItem({ icon: 'upload', label: 'ファイルを開く（Word・Markdown・テキスト・HTML）', onClick: () => $('#fileImport').click() }));
    p.append(menuSep());
    p.append(menuLabel('ダウンロード'));
    p.append(menuItem({ icon: 'word', label: 'Microsoft Word（.docx）', onClick: () => exportAs('docx') }));
    p.append(menuItem({ icon: 'download', label: 'Markdown（.md）', onClick: () => exportAs('md') }));
    p.append(menuItem({ icon: 'download', label: 'Web ページ（.html）', onClick: () => exportAs('html') }));
    p.append(menuItem({ icon: 'download', label: 'テキスト（.txt）', onClick: () => exportAs('txt') }));
    p.append(menuItem({ icon: 'print', label: '印刷・PDF', kbd: `${MOD}P`, onClick: () => window.print() }));
    p.append(menuSep());
    p.append(menuItem({ icon: 'history', label: '変更履歴', kbd: `${MOD}${ALT}${SHIFT}H`, onClick: () => actions.openHistory() }));
    p.append(menuItem({ icon: 'count', label: '文字数', kbd: `${MOD}${SHIFT}C`, onClick: () => actions.openCounts() }));
    p.append(menuItem({ icon: 'eye', label: editable ? '閲覧モード（編集しない）' : '編集モードに戻る', onClick: () => actions.setReadOnly(editable) }));
    p.append(menuItem({ icon: 'keyboard', label: 'キーボード ショートカット', kbd: `${MOD}/`, onClick: () => actions.openShortcuts() }));
    p.append(menuItem({ icon: 'settings', label: '設定・バックアップ', onClick: () => actions.openSettings() }));
    if (document.fullscreenEnabled) {
      p.append(menuItem({ icon: 'external', label: document.fullscreenElement ? '全画面表示を終了' : '全画面表示', onClick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}) }));
    }
    p.append(menuSep());
    p.append(menuItem({ icon: 'trash', label: 'ゴミ箱に移動', danger: true, onClick: () => session.current && trashDoc(session.current.id) }));
  }, { align: 'end' }));
}

