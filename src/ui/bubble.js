// The small floating bar under a link (open / edit / remove) or a selected image (size, alignment,
// alt text, delete).
import { NodeSelection } from 'prosemirror-state';
import { ctx, run, $, el } from '../app/ctx.js';
import { icon } from './icons.js';
import { keepFocus } from './pop.js';
import * as C from '../editor/commands.js';
import { schema, safeHref } from '../editor/schema.js';

let bubble;
let key = '';
let actions = {};

export function initBubble(a) {
  actions = a;
  bubble = $('#bubble');
  keepFocus(bubble);
  $('#scroller').addEventListener('scroll', () => { key = key ? key + ' ' : ''; if (!bubble.hidden) updateBubble(); }, { passive: true });
}

export function hideBubble() { bubble.hidden = true; key = ''; }

function iconBtn(ic, label, onClick, pressed) {
  const b = el('button', { type: 'button', class: 'icon sm', title: label, 'aria-label': label, html: icon(ic) });
  if (pressed != null) b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

export function updateBubble() {
  const view = ctx.view;
  const s = view.state;
  const focused = view.hasFocus() || bubble.contains(document.activeElement);
  if (!focused || !view.editable) { hideBubble(); return; }
  const sel = s.selection;
  if (sel instanceof NodeSelection && sel.node.type === schema.nodes.image) {
    const { width, align } = sel.node.attrs;
    const k = `img:${sel.from}:${width}:${align}`;
    if (k !== key) {
      key = k;
      bubble.innerHTML = '';
      const pos = sel.from;
      for (const [v, label] of [[25, '小'], [50, '中'], [75, '大'], [null, '全幅']]) {
        const b = el('button', { type: 'button', class: 'tbtn', text: label, 'aria-pressed': String(width === v) });
        b.addEventListener('click', () => { run(C.setNodeAttrs(pos, { width: v })); });
        bubble.append(b);
      }
      bubble.append(el('span', { class: 'sep' }));
      for (const [v, ic, label] of [['left', 'imgLeft', '左寄せ'], ['center', 'imgCenter', '中央'], ['right', 'imgRight', '右寄せ']]) {
        bubble.append(iconBtn(ic, label, () => run(C.setNodeAttrs(pos, { align: v })), (align || 'center') === v));
      }
      bubble.append(el('span', { class: 'sep' }));
      bubble.append(iconBtn('alt', '代替テキスト', () => actions.editAlt(pos)));
      bubble.append(iconBtn('trash', '画像を削除', () => { view.dispatch(view.state.tr.deleteSelection()); view.focus(); }));
    }
    const dom = view.nodeDOM(sel.from);
    if (dom) place(dom.getBoundingClientRect());
    return;
  }
  const r = sel.empty ? C.linkRange(s) : null;
  if (r) {
    const k = 'link:' + r.from + ':' + r.href;
    if (k !== key) {
      key = k;
      bubble.innerHTML = '';
      const a = el('a', { href: safeHref(r.href), target: '_blank', rel: 'noopener noreferrer', title: r.href, text: r.href.replace(/^https?:\/\//, '') });
      a.insertAdjacentHTML('beforeend', icon('external'));
      bubble.append(a, iconBtn('edit', 'リンクを編集', () => actions.openLink()), iconBtn('unlink', 'リンクを解除', () => run(C.removeLink)));
    }
    const start = view.coordsAtPos(r.from);
    const end = view.coordsAtPos(r.to);
    place({ left: start.left, top: start.top, bottom: Math.max(start.bottom, end.bottom) });
    return;
  }
  hideBubble();
}

function place(rect) {
  bubble.hidden = false;
  const w = bubble.offsetWidth, h = bubble.offsetHeight;
  const area = $('#scroller').getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + h > area.bottom - 4) top = rect.top - h - 6;
  if (top < area.top || rect.bottom < area.top || rect.top > area.bottom) { bubble.hidden = true; return; }
  bubble.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)) + 'px';
  bubble.style.top = top + 'px';
}
