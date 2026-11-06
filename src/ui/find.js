// Find and replace (Ctrl+F / Ctrl+H).
import {
  SearchQuery, setSearchState, getSearchState, getMatchHighlights,
  findNext, findPrev, replaceNext, replaceAll,
} from 'prosemirror-search';
import { ctx, $, fmt } from '../app/ctx.js';
import { closePop } from './pop.js';
import { toast } from './toast.js';

let bar, input, replaceInput;
const opts = { caseSensitive: false, wholeWord: false, regexp: false };

export function isFindOpen() { return bar && !bar.hidden; }

function query() {
  return new SearchQuery({ search: input.value, replace: replaceInput.value, ...opts });
}

export function pushQuery() {
  if (!isFindOpen()) return;
  const q = query();
  input.classList.toggle('bad', !!input.value && !q.valid);
  ctx.view.dispatch(setSearchState(ctx.view.state.tr, q));
}

export function openFind(replace) {
  closePop();
  const s = ctx.view.state;
  const { from, to, empty } = s.selection;
  if (!empty && s.selection.$from.sameParent(s.selection.$to)) {
    const t = s.doc.textBetween(from, to);
    if (t.length <= 100) input.value = t;
  }
  bar.hidden = false;
  const r = !!replace || !$('#replaceRow').hidden;
  $('#replaceRow').hidden = !r;
  $('#findToggleReplace').setAttribute('aria-pressed', String(r));
  pushQuery();
  input.focus();
  input.select();
}

export function closeFind(focusEditor = true) {
  if (!isFindOpen()) return false;
  bar.hidden = true;
  ctx.view.dispatch(setSearchState(ctx.view.state.tr, new SearchQuery({ search: '' })));
  if (focusEditor) ctx.view.focus();
  return true;
}

const matches = () => getMatchHighlights(ctx.view.state).find();

export function updateFindCount() {
  if (!isFindOpen()) return;
  const q = getSearchState(ctx.view.state);
  const out = $('#findCount');
  if (!q || !q.query.valid) { out.textContent = input.value && opts.regexp ? '式が不正' : ''; return; }
  const list = matches();
  const { from, to } = ctx.view.state.selection;
  const i = list.findIndex((d) => d.from === from && d.to === to);
  out.textContent = list.length ? (i >= 0 ? `${i + 1} / ${list.length}` : `${list.length} 件`) : 'なし';
}

function step(back) {
  (back ? findPrev : findNext)(ctx.view.state, (tr) => ctx.view.dispatch(tr.scrollIntoView()));
}

function doReplace() {
  if (!matches().length) return;
  replaceNext(ctx.view.state, (tr) => ctx.view.dispatch(tr.scrollIntoView()));
}

export function initFind() {
  bar = $('#findbar');
  input = $('#findInput');
  replaceInput = $('#replaceInput');
  input.addEventListener('input', pushQuery);
  replaceInput.addEventListener('input', pushQuery);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); step(e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doReplace(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('#findNext').addEventListener('click', () => step(false));
  $('#findPrev').addEventListener('click', () => step(true));
  $('#findClose').addEventListener('click', () => closeFind());
  const toggle = (id, key) => $(id).addEventListener('click', (e) => {
    opts[key] = !opts[key];
    e.currentTarget.setAttribute('aria-pressed', String(opts[key]));
    pushQuery();
  });
  toggle('#findCase', 'caseSensitive');
  toggle('#findWord', 'wholeWord');
  toggle('#findRegex', 'regexp');
  $('#findToggleReplace').addEventListener('click', (e) => {
    const on = $('#replaceRow').hidden;
    $('#replaceRow').hidden = !on;
    e.currentTarget.setAttribute('aria-pressed', String(on));
    if (on) replaceInput.focus();
  });
  $('#replaceOne').addEventListener('click', doReplace);
  $('#replaceAll').addEventListener('click', () => {
    const n = matches().length;
    if (!n) { toast('見つかりません'); return; }
    replaceAll(ctx.view.state, ctx.view.dispatch);
    toast(`${fmt(n)} 件を置換しました`);
  });
  $('#btnFind').addEventListener('click', () => (isFindOpen() ? closeFind() : openFind(false)));
}
