// Fixed (light-theme) values for the named colors, used when a document leaves the app
// (HTML, Word). Inside the editor the colors come from CSS variables instead.
export const TEXT_HEX = { gray: '6b7280', red: 'c0362c', orange: 'c2610c', yellow: 'a17a00', green: '2e7d4f', blue: '2563b0', purple: '7c3aad' };
export const HIGHLIGHT_HEX = { gray: 'e5e7eb', red: 'fbd5d0', orange: 'fde0c2', yellow: 'fdf0a6', green: 'd3efd9', blue: 'd6e6fb', purple: 'e8dcf8' };
export const CELL_HEX = { gray: 'f1f2f4', red: 'fde8e5', orange: 'fdeedd', yellow: 'fdf6d3', green: 'e3f4e7', blue: 'e5effc', purple: 'f0e9fb' };

// Picks the named color nearest to an arbitrary hex value (for imported documents).
export function nearestColor(hex, table) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = rgb(m[1]);
  let best = null, bestD = Infinity;
  for (const [name, h] of Object.entries(table)) {
    const [r2, g2, b2] = rgb(h);
    const d = (r - r2) ** 2 * 0.3 + (g - g2) ** 2 * 0.59 + (b - b2) ** 2 * 0.11;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}
