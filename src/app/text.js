// Counting and plain text, cached per node. ProseMirror reuses unchanged nodes between edits, so a
// keystroke only recounts the paragraph it touched (and the containers above it), not the whole
// document — what keeps the live character count cheap in long documents.
const cache = new WeakMap();
const textCache = new WeakMap();

// The characters JavaScript's \s matches (incl. the full-width space), by code.
function isSpace(c) {
  return c <= 32 ? c === 32 || (c >= 9 && c <= 13)
    : c === 0x3000 || c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f;
}
// Latin letters, digits, apostrophes and hyphens make up words; any other character that is not a
// space or punctuation (kanji, kana…) counts as a word of its own, as Docs counts them.
const isWordChar = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || (c >= 0xc0 && c <= 0x24f) || c === 39 || c === 0x2019 || c === 45;
const PUNCT = new Set([0x3001, 0x3002, 0xff0c, 0xff0e, 44, 46, 33, 63, 0xff01, 0xff1f, 0x300c, 0x300d, 0x300e, 0x300f, 0xff08, 0xff09, 40, 41, 0x2026, 0x30fb, 0xff1a, 58, 0xff1b, 59]);

// Counts code points (an emoji is one character), not UTF-16 units — in one pass, without
// building strings, since this runs for every edited paragraph.
export function countText(text) {
  let noSpace = 0, all = 0, words = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) continue; // second half of a surrogate pair
    if (c === 10) { inWord = false; continue; }
    all++;
    if (isSpace(c)) { inWord = false; continue; }
    noSpace++;
    if (isWordChar(c)) { if (!inWord) { words++; inWord = true; } }
    else { inWord = false; if (!PUNCT.has(c)) words++; }
  }
  return { noSpace, all, words };
}

const leaf = (node) => (node.type.spec.leafText ? node.type.spec.leafText(node) : '');

function textblockText(node) {
  return node.textBetween(0, node.content.size, '', leaf);
}

// { noSpace, all, words, paras } for any node.
export function stats(node) {
  let s = cache.get(node);
  if (s) return s;
  if (node.isTextblock) {
    const c = countText(textblockText(node));
    s = { ...c, paras: node.content.size ? 1 : 0 };
  } else if (node.isLeaf) {
    s = { noSpace: 0, all: 0, words: 0, paras: 0 };
  } else {
    s = { noSpace: 0, all: 0, words: 0, paras: 0 };
    node.forEach((child) => {
      const c = stats(child);
      s.noSpace += c.noSpace; s.all += c.all; s.words += c.words; s.paras += c.paras;
    });
  }
  cache.set(node, s);
  return s;
}

// Plain text with one line per paragraph (for searching and exports).
export function plainText(node) {
  let t = textCache.get(node);
  if (t != null) return t;
  if (node.isTextblock) t = textblockText(node);
  else if (node.isLeaf) t = '';
  else {
    const parts = [];
    node.forEach((child) => { const c = plainText(child); if (c || child.isTextblock) parts.push(c); });
    t = parts.join('\n');
  }
  textCache.set(node, t);
  return t;
}

export function selectionText(state) {
  const { from, to } = state.selection;
  return state.doc.textBetween(from, to, '\n', leaf);
}

// What to call a document without a title: its first line.
export function firstLine(doc) {
  let t = '';
  doc.descendants((n) => {
    if (t) return false;
    if (n.isTextblock) { const s = n.textContent.trim(); if (s) t = s; return false; }
    return true;
  });
  return t.slice(0, 60);
}
