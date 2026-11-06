// Shared state between the app's modules, and a tiny event bus.
export const ctx = {
  view: null, // the EditorView
  makeState: null, // (doc) => EditorState with the editor's plugins
  touch: typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : { matches: false },
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, data) {
  for (const fn of listeners.get(event) || []) {
    try { fn(data); } catch (err) { console.error(err); }
  }
}

// Runs an editor command from a button; keeps the keyboard closed on phones when it was closed.
export function run(cmd) {
  const view = ctx.view;
  const focused = view.hasFocus();
  const ok = cmd(view.state, view.dispatch, view);
  if (focused || !ctx.touch.matches) view.focus();
  return ok;
}

export const $ = (s) => document.querySelector(s);
export const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';
export const ALT = isMac ? '⌥' : 'Alt+';
export const SHIFT = isMac ? '⇧' : 'Shift+';
export const fmt = (n) => n.toLocaleString('ja-JP');
export const UNTITLED = '無題の文書';

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
