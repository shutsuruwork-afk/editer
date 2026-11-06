// Stand-in for the "entities" package that markdown-it imports: the browser already knows every
// HTML entity, so decoding goes through a <textarea> (its content is never parsed as markup) instead
// of shipping ~75 KB of entity tables.
let box = null;
export function decodeHTML(str) {
  if (!str || str.indexOf('&') < 0) return str;
  box = box || document.createElement('textarea');
  box.innerHTML = str;
  return box.value;
}
// markdown-it only calls this on complete "&name;" references, where both behave the same
export const decodeHTMLStrict = decodeHTML;
