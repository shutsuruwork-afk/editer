// One popover at a time (menus, palettes, pickers), anchored under the button that opened it.
import { icon } from './icons.js';

const pop = () => document.getElementById('pop');
let anchor = null;
let onClose = null;

export function isPopOpen() { return !!anchor; }

export function closePop() {
  if (!anchor) return false;
  pop().hidden = true;
  pop().innerHTML = '';
  anchor.setAttribute('aria-expanded', 'false');
  anchor = null;
  const f = onClose;
  onClose = null;
  if (f) f();
  return true;
}

export function openPop(el, render, opts = {}) {
  if (anchor === el) { closePop(); return; }
  closePop();
  const p = pop();
  p.innerHTML = '';
  p.setAttribute('role', opts.role || 'menu');
  render(p);
  p.hidden = false;
  anchor = el;
  onClose = opts.onClose || null;
  el.setAttribute('aria-expanded', 'true');
  place(el, p, opts.align);
  const first = p.querySelector('[aria-checked="true"], button');
  if (opts.focus && first) first.focus();
}

function place(el, p, align) {
  const r = el.getBoundingClientRect();
  const w = p.offsetWidth, h = p.offsetHeight;
  const vw = window.innerWidth, vh = window.visualViewport ? window.visualViewport.height + window.visualViewport.offsetTop : window.innerHeight;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  let top = r.bottom + 4;
  if (top + h > vh - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
  p.style.left = left + 'px';
  p.style.top = Math.max(8, top) + 'px';
}

export function menuItem({ icon: ic, label, kbd, checked, danger, cls, onClick, html }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'menu-item' + (danger ? ' danger' : '') + (cls ? ' ' + cls : '');
  b.setAttribute('role', checked == null ? 'menuitem' : 'menuitemradio');
  if (checked != null) b.setAttribute('aria-checked', String(!!checked));
  b.innerHTML = (ic ? icon(ic) : '') + '<span></span>' + (kbd ? `<span class="kbd">${kbd}</span>` : '');
  if (html) b.children[ic ? 1 : 0].innerHTML = html; else b.children[ic ? 1 : 0].textContent = label;
  b.addEventListener('click', (e) => { e.preventDefault(); closePop(); onClick(); });
  return b;
}

export function menuSep() {
  const d = document.createElement('div');
  d.className = 'menu-sep';
  return d;
}

export function menuLabel(text) {
  const d = document.createElement('div');
  d.className = 'menu-label';
  d.textContent = text;
  return d;
}

// Keep the editor's focus (and the phone keyboard) when tapping buttons that act on the text.
export function keepFocus(el) {
  const stop = (e) => { if (e.button === 0 || e.pointerType === 'touch') e.preventDefault(); };
  el.addEventListener('pointerdown', stop);
  el.addEventListener('mousedown', stop);
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (!anchor) return;
    const p = pop();
    if (p.contains(e.target) || anchor.contains(e.target)) return;
    closePop();
  }, true);
  window.addEventListener('resize', () => closePop());
}
