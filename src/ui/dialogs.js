// Dialogs: link, counts, settings (display / print / storage), confirm, prompt, footnote,
// keyboard shortcuts, image URL and alt text.
import { NodeSelection } from 'prosemirror-state';
import * as store from '../store.js';
import { ctx, run, $, el, fmt, MOD, ALT, SHIFT, isMac } from '../app/ctx.js';
import { settings, setSetting } from '../app/settings.js';
import { session } from '../app/docs.js';
import { stats, countText, selectionText } from '../app/text.js';
import { makeBackup, restoreBackup } from '../app/backup.js';
import * as C from '../editor/commands.js';
import { schema, safeHref, safeSrc } from '../editor/schema.js';
import { footnotesOf } from '../editor/plugins.js';
import { closePop } from './pop.js';
import { toast } from './toast.js';

let actions = {};

// ---------- confirm / prompt ----------

export function confirmBox(title, text, okLabel = 'OK') {
  const d = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

export function promptBox(title, label, value = '', { okLabel = 'OK', inputmode = 'text' } = {}) {
  const d = $('#promptDialog');
  $('#promptTitle').textContent = title;
  $('#promptLabel').textContent = label;
  $('#promptOk').textContent = okLabel;
  const input = $('#promptInput');
  input.value = value;
  input.inputMode = inputmode;
  d.returnValue = '';
  d.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? input.value : null), { once: true }));
}

// ---------- link ----------

export function openLinkDialog() {
  closePop();
  const s = ctx.view.state;
  const r = C.linkRange(s);
  const { from, to, empty } = s.selection;
  const text = r && empty ? s.doc.textBetween(r.from, r.to) : s.doc.textBetween(from, to, ' ');
  $('#linkText').value = text;
  $('#linkUrl').value = r ? r.href : '';
  $('#linkRemove').hidden = !r;
  $('#linkError').hidden = true;
  // the text field only makes sense inside one paragraph
  $('#linkText').closest('label').hidden = !s.selection.$from.sameParent(s.selection.$to) || s.selection instanceof NodeSelection;
  $('#linkDialog').showModal();
  (text ? $('#linkUrl') : $('#linkText')).focus();
}

// ---------- counts ----------

export function openCounts() {
  const s = ctx.view.state;
  const t = stats(s.doc);
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const rows = [
    ['文字数（空白を除く）', fmt(t.noSpace)],
    ['文字数（空白を含む）', fmt(t.all)],
    ['単語数', fmt(t.words)],
    ['段落数', fmt(t.paras)],
    ['原稿用紙換算（400字）', fmt(Math.ceil(t.noSpace / 400)) + ' 枚'],
    ['脚注', fmt(footnotesOf(s.doc).length)],
  ];
  if (!s.selection.empty && !(s.selection instanceof NodeSelection)) {
    const st = countText(selectionText(s));
    rows.unshift(['選択範囲（空白を除く）', fmt(st.noSpace)], ['選択範囲（空白を含む）', fmt(st.all)]);
  }
  const cur = session.current;
  if (cur) rows.push(['作成', fmtDate(cur.createdAt)], ['最終更新', fmtDate(cur.updatedAt)]);
  const table = $('#countTable');
  table.innerHTML = '';
  for (const [k, v] of rows) table.append(el('tr', {}, el('th', { text: k }), el('td', { text: v })));
  $('#countDialog').showModal();
}

// ---------- settings ----------

const SEGMENTS = [['#optFont', 'font'], ['#optSize', 'size', true], ['#optLine', 'line', true], ['#optPage', 'page'], ['#optTheme', 'theme'], ['#optPaper', 'paper'], ['#optOrientation', 'orientation'], ['#optMargin', 'margin']];

export function syncSettingsUi() {
  for (const [id, key] of SEGMENTS) {
    for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(settings[key])));
  }
  $('#optShowCount').checked = settings.showCount;
  $('#optShowCount2').checked = settings.showCount;
  $('#optSpell').checked = settings.spellcheck;
  $('#optPageNumbers').checked = settings.pageNumbers;
}

async function showStorageInfo() {
  const info = $('#storageInfo');
  const [est, persisted] = await Promise.all([store.storageEstimate(), store.isPersisted()]);
  const docs = (await store.listDocs()).filter((m) => !m.trashedAt).length;
  const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  const parts = [`文書 ${fmt(docs)} 件`];
  if (est && est.usage != null) parts.push(`使用量 ${mb(est.usage)}${est.quota ? ` / 上限の目安 ${mb(est.quota)}` : ''}`);
  if (!store.storeInfo.persistent) parts.push('このブラウザでは保存できません（書き出して保管してください）');
  else parts.push(persisted ? 'ブラウザの容量が足りなくなっても消されない設定です' : 'ブラウザの容量が足りなくなると消される可能性があります');
  info.textContent = parts.join(' ・ ');
  $('#btnPersist').hidden = persisted || !store.storeInfo.persistent;
}

export function openSettings() {
  closePop();
  syncSettingsUi();
  $('#settingsDialog').showModal();
  showStorageInfo();
}

// ---------- footnote ----------

let footnotePos = null, footnoteNew = false;

export function openFootnote(pos, isNew = false) {
  const node = ctx.view.state.doc.nodeAt(pos);
  if (!node || node.type !== schema.nodes.footnote) return;
  footnotePos = pos;
  footnoteNew = isNew;
  const n = footnotesOf(ctx.view.state.doc).findIndex((f) => f.pos === pos) + 1;
  $('#footnoteNo').textContent = n ? String(n) : '';
  $('#footnoteText').value = node.attrs.text;
  $('#footnoteDialog').returnValue = '';
  $('#footnoteDialog').showModal();
  $('#footnoteText').focus();
}

function removeFootnoteAt(pos) {
  const view = ctx.view;
  const node = view.state.doc.nodeAt(pos);
  if (node && node.type === schema.nodes.footnote) view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
}

export function insertFootnote() {
  run(C.insertFootnote('', (pos) => setTimeout(() => openFootnote(pos, true), 0)));
}

// ---------- shortcuts ----------

const SHORTCUTS = [
  ['よく使う操作', [
    ['元に戻す / やり直す', `${MOD}Z / ${isMac ? '⇧⌘Z' : 'Ctrl+Y'}`],
    ['保存', `${MOD}S`], ['検索 / 置換', `${MOD}F / ${MOD}H`], ['文字数', `${MOD}${SHIFT}C`],
    ['変更履歴', `${MOD}${ALT}${SHIFT}H`], ['このショートカット一覧', `${MOD}/`], ['書式なしで貼り付け', `${MOD}${SHIFT}V`],
  ]],
  ['文字の書式', [
    ['太字 / 斜体 / 下線', `${MOD}B / ${MOD}I / ${MOD}U`], ['取り消し線', `${MOD}${SHIFT}X, ${ALT}${SHIFT}5`],
    ['上付き / 下付き', `${MOD}. / ${MOD},`], ['コード', `${MOD}E`], ['フォントを大きく / 小さく', `${MOD}${SHIFT}. / ${MOD}${SHIFT},`],
    ['リンク', `${MOD}K`], ['書式をコピー / 貼り付け', `${MOD}${ALT}C / ${MOD}${ALT}V`], ['書式をクリア', `${MOD}\\`],
  ]],
  ['段落', [
    ['標準テキスト / 見出し 1〜4', `${MOD}${ALT}0 / ${MOD}${ALT}1〜4`], ['左 / 中央 / 右 / 両端揃え', `${MOD}${SHIFT}L / E / R / J`],
    ['番号付き / 箇条書き / チェックリスト', `${MOD}${SHIFT}7 / 8 / 9`], ['インデント', `${MOD}] / ${MOD}[、リストでは Tab / ${SHIFT}Tab`],
    ['段落内で改行', `${SHIFT}Enter`], ['改ページ', `${MOD}Enter`], ['脚注', `${MOD}${ALT}F`],
  ]],
  ['入力しながら', [
    ['見出し', '行頭で # 〜 ####'], ['箇条書き / 番号 / チェック', '行頭で - / 1. / []'], ['引用 / コード', '行頭で > / ```'],
    ['区切り線', '--- だけの行'], ['太字 / 斜体 / 取り消し / コード', '**文字** / *文字* / ~~文字~~ / `文字`'], ['自動の書式を取り消す', '直後に Backspace'],
  ]],
];

export function openShortcuts() {
  closePop();
  const box = $('#shortcutsList');
  if (!box.children.length) {
    for (const [group, rows] of SHORTCUTS) {
      const t = el('table', { class: 'counts' });
      for (const [k, v] of rows) t.append(el('tr', {}, el('th', { text: k }), el('td', {}, el('kbd', { text: v }))));
      box.append(el('section', {}, el('h3', { text: group }), t));
    }
  }
  $('#shortcutsDialog').showModal();
}

// ---------- images ----------

export async function imageFromUrl() {
  const url = await promptBox('URL で画像を挿入', '画像の URL（https://…）', '', { okLabel: '挿入', inputmode: 'url' });
  if (url == null) return;
  const src = safeSrc(url.trim());
  if (!src || !/^https:/.test(src)) { toast('https:// で始まる画像の URL を入力してください'); return; }
  if (!run(C.insertImage(src))) toast('ここには画像を挿入できません');
}

export async function editAlt(pos) {
  const node = ctx.view.state.doc.nodeAt(pos);
  if (!node) return;
  const alt = await promptBox('代替テキスト', '画像の説明（読み上げや、画像が表示できないときに使われます）', node.attrs.alt || '');
  if (alt != null) run(C.setNodeAttrs(pos, { alt: alt.trim() }));
}

// ---------- wiring ----------

export function initDialogs(a) {
  actions = a;

  // link
  $('#linkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#linkUrl').value.trim();
    if (!safeHref(url)) { $('#linkError').hidden = false; $('#linkUrl').focus(); return; }
    const textHidden = $('#linkText').closest('label').hidden;
    $('#linkDialog').close();
    ctx.view.focus();
    run(C.setLink(url, textHidden ? null : $('#linkText').value));
  });
  $('#linkCancel').addEventListener('click', () => { $('#linkDialog').close(); ctx.view.focus(); });
  $('#linkRemove').addEventListener('click', () => { $('#linkDialog').close(); ctx.view.focus(); run(C.removeLink); });

  // prompt
  $('#promptForm').addEventListener('submit', (e) => { e.preventDefault(); $('#promptDialog').close('ok'); });
  $('#promptCancel').addEventListener('click', () => $('#promptDialog').close('cancel'));

  // footnote
  $('#footnoteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#footnoteText').value.trim();
    $('#footnoteDialog').close('ok');
    if (footnotePos == null) return;
    if (!text && footnoteNew) removeFootnoteAt(footnotePos);
    else run(C.setNodeAttrs(footnotePos, { text }));
    footnotePos = null;
  });
  $('#footnoteCancel').addEventListener('click', () => $('#footnoteDialog').close('cancel'));
  $('#footnoteDialog').addEventListener('close', () => {
    if ($('#footnoteDialog').returnValue !== 'ok' && footnoteNew && footnotePos != null) removeFootnoteAt(footnotePos);
    footnotePos = null;
    ctx.view.focus();
  });
  $('#footnoteRemove').addEventListener('click', () => {
    const pos = footnotePos;
    footnoteNew = false;
    footnotePos = null;
    $('#footnoteDialog').close('remove');
    if (pos != null) removeFootnoteAt(pos);
  });
  // Enter confirms (footnotes are usually one line); Shift+Enter starts a new line
  $('#footnoteText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#footnoteForm').requestSubmit(); }
  });

  // settings
  for (const [id, key, num] of SEGMENTS) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) { setSetting(key, num ? +b.dataset.v : b.dataset.v); syncSettingsUi(); }
    });
  }
  const check = (id, key) => $(id).addEventListener('change', (e) => { setSetting(key, e.target.checked); syncSettingsUi(); });
  check('#optShowCount', 'showCount');
  check('#optShowCount2', 'showCount');
  check('#optSpell', 'spellcheck');
  check('#optPageNumbers', 'pageNumbers');
  $('#btnPersist').addEventListener('click', async () => {
    const ok = await store.requestPersist();
    toast(ok ? 'このブラウザのデータを消えにくくしました' : 'ブラウザに許可されませんでした。ときどきバックアップを作成してください', 5000);
    showStorageInfo();
  });
  $('#btnBackup').addEventListener('click', async () => {
    try {
      const blob = await makeBackup();
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      await actions.saveFile(`editer-backup-${stamp}.json`, blob);
    } catch { toast('バックアップを作成できませんでした'); }
  });
  $('#btnRestore').addEventListener('click', () => $('#fileBackup').click());
  $('#fileBackup').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { added, skipped } = await restoreBackup(file);
      toast(`${fmt(added)} 件の文書を復元しました${skipped ? `（同じか新しいものがある ${fmt(skipped)} 件は飛ばしました）` : ''}`, 6000);
      showStorageInfo();
    } catch (err) { toast(err.message || '復元できませんでした', 6000); }
  });

  // tapping outside a dialog closes it
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
  }
}
