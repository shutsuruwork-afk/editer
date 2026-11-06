// 変更履歴: the saved versions of the open document — preview, restore, copy, name.
import { DOMSerializer } from 'prosemirror-model';
import { ctx, $, el, fmt } from '../app/ctx.js';
import { schema } from '../editor/schema.js';
import { session, save, listVersions, versionDoc, restoreVersion, nameCurrentVersion, renameVersion, newDoc, displayTitle } from '../app/docs.js';
import { stats } from '../app/text.js';
import { imageUrl, isLocal } from '../app/images.js';
import { promptBox, confirmBox } from './dialogs.js';
import { closePop } from './pop.js';
import { toast } from './toast.js';

let dlg;
let versions = [];
let selected = null; // version record, or 'current'

const dayFmt = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const timeFmt = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });

export async function openHistory() {
  if (!session.current) return;
  closePop();
  if (session.dirty) await save();
  dlg.classList.remove('showing');
  dlg.showModal();
  await renderList();
  select('current', false); // on phones the list shows first
}

async function renderList() {
  versions = session.current && session.current.persisted ? await listVersions() : [];
  const ul = $('#historyList');
  ul.innerHTML = '';
  const cur = el('li', {}, el('button', { type: 'button', class: 'hv' + (selected === 'current' ? ' on' : ''), 'data-key': 'current' },
    el('span', { class: 'hv-time', text: '現在の内容' }),
    el('span', { class: 'hv-meta', text: `${fmt(stats(ctx.view.state.doc).noSpace)} 字` })));
  ul.append(cur);
  let day = '';
  versions.forEach((v, i) => {
    const d = dayFmt.format(v.time);
    if (d !== day) { day = d; ul.append(el('li', { class: 'hv-day', text: d })); }
    const older = versions[i + 1];
    const delta = older ? v.chars - older.chars : null;
    const b = el('button', { type: 'button', class: 'hv' + (selected && selected.vid === v.vid ? ' on' : ''), 'data-key': String(v.vid) },
      el('span', { class: 'hv-time', text: timeFmt.format(v.time) }),
      v.name ? el('span', { class: 'hv-name', text: v.name }) : null,
      el('span', { class: 'hv-meta', text: `${fmt(v.chars)} 字${delta ? `（${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}）` : ''}` }));
    ul.append(el('li', {}, b));
  });
  if (!versions.length) ul.append(el('li', { class: 'muted hv-empty', text: '保存された版はまだありません。編集を続けると 10 分ごとに自動で残ります。' }));
  for (const b of ul.querySelectorAll('button.hv')) {
    b.addEventListener('click', () => {
      const key = b.dataset.key;
      select(key === 'current' ? 'current' : versions.find((v) => String(v.vid) === key));
    });
  }
}

async function select(v, show = true) {
  if (!v) return;
  selected = v;
  for (const b of $('#historyList').querySelectorAll('button.hv')) b.classList.toggle('on', b.dataset.key === (v === 'current' ? 'current' : String(v.vid)));
  const isCurrent = v === 'current';
  $('#historyActions').hidden = false;
  $('#historyWhen').textContent = isCurrent ? '現在の内容' : (v.name ? `${v.name} ・ ` : '') + fullFmt.format(v.time);
  for (const id of ['#historyRestore', '#historyCopy', '#historyRename']) $(id).hidden = isCurrent;
  if (show) dlg.classList.add('showing');
  const box = $('#historyPreview');
  box.innerHTML = '<p class="muted">読み込んでいます…</p>';
  const doc = isCurrent ? ctx.view.state.doc : await versionDoc(v.vid);
  if (selected !== v) return;
  box.innerHTML = '';
  if (!doc) { box.append(el('p', { class: 'muted', text: 'この版を読み込めませんでした。' })); return; }
  box.append(render(doc));
}

// A read-only rendering that looks like the editor.
function render(doc) {
  const div = el('div', { class: 'ProseMirror preview' });
  div.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  for (const img of div.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (isLocal(src)) { img.removeAttribute('src'); imageUrl(src).then((url) => { if (url) img.src = url; }); }
  }
  const heads = Array.from(div.querySelectorAll('h1,h2,h3,h4'));
  for (const nav of div.querySelectorAll('nav[data-type="toc"]')) {
    nav.append(el('div', { class: 'toc-title', text: '目次' }));
    const ul = el('ul');
    for (const h of heads) ul.append(el('li', { class: 'l' + h.tagName[1], text: h.textContent }));
    nav.append(ul);
  }
  const notes = Array.from(div.querySelectorAll('sup.footnote'));
  if (notes.length) {
    const ol = el('ol');
    notes.forEach((s, i) => { s.textContent = String(i + 1); ol.append(el('li', { text: s.getAttribute('data-footnote') || '' })); });
    div.append(el('section', { class: 'footnotes' }, ol));
  }
  return div;
}

export function initHistory() {
  dlg = $('#historyDialog');
  $('#historyClose').addEventListener('click', () => dlg.close());
  // drop the preview so a closed dialog holds no copy of the document
  dlg.addEventListener('close', () => { $('#historyPreview').innerHTML = ''; selected = null; });
  $('#historyBack').addEventListener('click', () => dlg.classList.remove('showing'));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#historyRestore').addEventListener('click', async () => {
    const v = selected;
    if (!v || v === 'current') return;
    if (!(await confirmBox('この版を復元', `${fullFmt.format(v.time)} の内容に戻します。今の内容は変更履歴に残ります。`, '復元'))) return;
    dlg.close();
    if (await restoreVersion(v.vid)) toast('復元しました（Ctrl/⌘+Z で取り消せます）', 5000);
    else toast('復元できませんでした');
  });
  $('#historyCopy').addEventListener('click', async () => {
    const v = selected;
    if (!v || v === 'current') return;
    const doc = await versionDoc(v.vid);
    if (!doc) return;
    dlg.close();
    await newDoc({ doc, title: `${displayTitle(session.current) || '無題の文書'}（${fullFmt.format(v.time)} の版）`, focus: false });
    toast('この版をコピーして新しい文書にしました');
  });
  $('#historyRename').addEventListener('click', async () => {
    const v = selected;
    if (!v || v === 'current') return;
    const name = await promptBox('版の名前', '名前（空にすると名前なし）', v.name || '');
    if (name == null) return;
    await renameVersion(v.vid, name.trim());
    await renderList();
    select(versions.find((x) => x.vid === v.vid) || 'current');
  });
  $('#historyName').addEventListener('click', async () => {
    const name = await promptBox('今の版に名前を付ける', '名前', fullFmt.format(Date.now()));
    if (name == null) return;
    await nameCurrentVersion(name.trim() || fullFmt.format(Date.now()));
    await renderList();
    toast('今の版を保存しました');
  });
}
