// 書式のコピー (paint format): click once to copy the formatting at the cursor and apply it to the
// next selection; double-click to keep applying until Esc. Ctrl+Alt+C / Ctrl+Alt+V copy and paste
// formatting without the brush.
import { ctx, emit, run } from '../app/ctx.js';
import * as C from '../editor/commands.js';
import { toast } from './toast.js';

export const paint = { fmt: null, sticky: false, copied: null };

export function startPaint(sticky = false) {
  paint.fmt = C.captureFormat(ctx.view.state);
  paint.sticky = sticky;
  emit('paint');
}

export function stopPaint() {
  if (!paint.fmt) return false;
  paint.fmt = null;
  paint.sticky = false;
  emit('paint');
  return true;
}

export function copyFormat() {
  paint.copied = C.captureFormat(ctx.view.state);
  toast('書式をコピーしました（Ctrl/⌘+Alt+V で貼り付け）');
}

export function pasteFormat() {
  if (!paint.copied) { toast('先に Ctrl/⌘+Alt+C で書式をコピーしてください'); return; }
  run(C.applyFormat(paint.copied));
}

// The word around the cursor (Docs paints the whole word when you just click into it).
function wordAt(state) {
  const { $from } = state.selection;
  const text = $from.parent.textContent;
  if (!text || typeof Intl === 'undefined' || !Intl.Segmenter) return null;
  const offset = $from.parentOffset;
  for (const seg of new Intl.Segmenter('ja', { granularity: 'word' }).segment(text)) {
    if (seg.index <= offset && offset <= seg.index + seg.segment.length && seg.isWordLike) {
      const start = $from.start();
      return { from: start + seg.index, to: start + seg.index + seg.segment.length };
    }
  }
  return null;
}

export function initPaint() {
  const dom = ctx.view.dom;
  dom.addEventListener('mouseup', () => setTimeout(apply, 0));
  dom.addEventListener('touchend', () => setTimeout(apply, 0));
  dom.classList.toggle('painting', false);
  function apply() {
    if (!paint.fmt) return;
    const state = ctx.view.state;
    const range = state.selection.empty ? wordAt(state) : { from: state.selection.from, to: state.selection.to };
    if (!range) return;
    run(C.applyFormat(paint.fmt, range));
    if (!paint.sticky) stopPaint();
  }
}
