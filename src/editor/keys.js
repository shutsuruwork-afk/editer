import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, exitCode, joinUp, joinDown, selectParentNode } from 'prosemirror-commands';
import { undo, redo } from 'prosemirror-history';
import { splitListItem } from 'prosemirror-schema-list';
import { goToNextCell } from 'prosemirror-tables';
import {
  inputRules, wrappingInputRule, textblockTypeInputRule, InputRule, undoInputRule,
} from 'prosemirror-inputrules';
import { Fragment } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { schema, safeHref } from './schema.js';
import * as C from './commands.js';

const N = schema.nodes;
const M = schema.marks;
const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

// A new checklist item starts unchecked; Enter on an empty item leaves the list.
const splitCheckItem = splitListItem(N.check_item, { checked: false });

export function buildKeymap(app) {
  const k = {};
  const bind = (key, cmd) => { k[key] = cmd; };

  bind('Mod-z', undo);
  bind('Shift-Mod-z', redo);
  if (!mac) bind('Mod-y', redo);
  bind('Backspace', undoInputRule);

  bind('Mod-b', C.toggleBold);
  bind('Mod-i', C.toggleItalic);
  bind('Mod-u', C.toggleUnderline);
  bind('Alt-Shift-5', C.toggleStrike);
  bind('Mod-Shift-x', C.toggleStrike);
  bind('Mod-e', C.toggleCode);
  bind('Mod-\\', C.clearFormatting);

  bind('Mod-Alt-0', C.setStyle('paragraph'));
  for (let i = 1; i <= 4; i++) bind('Mod-Alt-' + i, C.setStyle('h' + i));

  bind('Mod-Shift-7', C.toggleList('ordered_list'));
  bind('Mod-Shift-8', C.toggleList('bullet_list'));
  bind('Mod-Shift-9', C.toggleList('checklist'));

  bind('Mod-Shift-l', C.setAlign('left'));
  bind('Mod-Shift-e', C.setAlign('center'));
  bind('Mod-Shift-r', C.setAlign('right'));
  bind('Mod-Shift-j', C.setAlign('justify'));

  bind('Mod-.', C.toggleSup);
  bind('Mod-,', C.toggleSub);
  bind('Mod-Shift-.', C.stepFontSize(1));
  bind('Mod-Shift-,', C.stepFontSize(-1));
  bind('Mod-]', C.changeIndent(1));
  bind('Mod-[', C.changeIndent(-1));

  bind('Alt-ArrowUp', joinUp);
  bind('Alt-ArrowDown', joinDown);
  bind('Escape', (state, dispatch) => (app.onEscape ? app.onEscape() : false) || selectParentNode(state, dispatch));

  bind('Shift-Enter', chainCommands(exitCode, (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView());
    return true;
  }));
  // Ctrl+Enter: page break (and leaves a code block, as before)
  bind('Mod-Enter', chainCommands(exitCode, C.insertPageBreak));

  bind('Enter', chainCommands(splitListItem(N.list_item), splitCheckItem));
  bind('Tab', chainCommands(C.nextCellOrNewRow, C.indent, (state, dispatch) => {
    // outside lists and tables, Tab types a full-width space at the start of a line and a tab elsewhere
    if (dispatch) dispatch(state.tr.insertText(state.selection.$from.parentOffset === 0 ? '\u3000' : '\t').scrollIntoView());
    return true;
  }));
  bind('Shift-Tab', chainCommands(goToNextCell(-1), C.outdent, () => true));

  const call = (name) => () => { if (app[name]) app[name](); return true; };
  bind('Mod-k', call('openLinkEditor'));
  bind('Mod-f', () => { app.openFind(false); return true; });
  bind('Mod-h', () => { app.openFind(true); return true; });
  bind('Mod-s', call('saveNow'));
  bind('Mod-Shift-c', call('showCounts'));
  bind('Mod-Alt-f', call('insertFootnote'));
  bind('Mod-Alt-c', call('copyFormat'));
  bind('Mod-Alt-v', call('pasteFormat'));
  bind('Mod-/', call('showShortcuts'));
  bind('Mod-Alt-Shift-h', call('openHistory'));

  return [keymap(k), keymap(baseKeymap)];
}

// ---------- typing shortcuts (Markdown-style) ----------

function markRule(regexp, markType) {
  return new InputRule(regexp, (state, match, start, end) => {
    const inner = match[2];
    if (!inner || /^\s|\s$/.test(inner)) return null;
    const lead = match[1] || '';
    const tr = state.tr;
    const textStart = start + lead.length;
    tr.replaceWith(textStart, end, schema.text(inner, [markType.create(), ...state.doc.resolve(start).marks()]));
    tr.removeStoredMark(markType);
    return tr;
  });
}

const URL_RE = /(^|[\s(（「])((?:https?:\/\/|www\.)[^\s<>()（）「」]+[^\s<>()（）「」.,;:!?、。])[\s)）」]$/;
const autolink = new InputRule(URL_RE, (state, match, start, end) => {
  const href = safeHref(match[2].startsWith('www.') ? 'https://' + match[2] : match[2]);
  if (!href) return null;
  const from = start + match[1].length;
  const to = from + match[2].length;
  if (state.doc.rangeHasMark(from, to, M.link) || state.doc.resolve(from).parent.type.spec.code) return null;
  const tr = state.tr.addMark(from, to, M.link.create({ href }));
  tr.insertText(match[0].slice(-1), end); // keep the typed space / bracket
  tr.removeStoredMark(M.link);
  return tr;
});

export function buildInputRules() {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,4})\s$/, N.heading, (m) => ({ level: m[1].length })),
      wrappingInputRule(/^\s*([-+*・])\s$/, N.bullet_list),
      wrappingInputRule(/^(\d+)[.．)]\s$/, N.ordered_list, (m) => ({ order: +m[1] }), (m, node) => node.childCount + node.attrs.order === +m[1]),
      wrappingInputRule(/^\s*\[( |x|X)?\]\s$/, N.checklist),
      wrappingInputRule(/^\s*[>＞]\s$/, N.blockquote),
      textblockTypeInputRule(/^```$/, N.code_block),
      new InputRule(/^(?:---|ーーー|———|－－－)$/, (state, match, start) => {
        const $s = state.doc.resolve(start);
        if ($s.parent.type !== N.paragraph || $s.parentOffset !== 0 || $s.parent.content.size !== match[0].length - 1) return null;
        const d = $s.depth;
        const nodes = Fragment.from([N.horizontal_rule.create(), N.paragraph.create()]);
        if (!$s.node(d - 1).canReplace($s.index(d - 1), $s.index(d - 1) + 1, nodes)) return null;
        const before = $s.before();
        const tr = state.tr.replaceWith(before, $s.after(), nodes);
        return tr.setSelection(TextSelection.create(tr.doc, before + 2));
      }),
      markRule(/(^|[^*])\*\*([^*]+)\*\*$/, M.strong),
      markRule(/(^|[^*\w])\*([^*\s][^*]*)\*$/, M.em),
      markRule(/(^|[^~])~~([^~]+)~~$/, M.strike),
      markRule(/(^|[^`])`([^`]+)`$/, M.code),
      autolink,
    ],
  });
}
