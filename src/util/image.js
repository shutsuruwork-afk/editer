// Large photos are scaled down before they go into a document; small images are kept as they are.
const MAX_SIDE = 1600;
const KEEP_AS_IS = 300 * 1024;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

function hasAlpha(ctx, w, h) {
  const step = Math.max(1, Math.floor((w * h) / 40000));
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4 * step) if (data[i] < 250) return true;
  return false;
}

// Returns a Blob ready to be stored (possibly the file itself).
export async function prepareImage(file) {
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return file; // keep vectors and animations
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error('decode');
    if (file.size <= KEEP_AS_IS && Math.max(w0, h0) <= MAX_SIDE && /^image\/(png|jpeg|webp)$/.test(file.type)) return file;
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    let out = await toBlob(canvas, 'image/webp', 0.85);
    if (!out || out.type !== 'image/webp') out = hasAlpha(ctx, w, h) ? await toBlob(canvas, 'image/png') : await toBlob(canvas, 'image/jpeg', 0.85);
    return out && out.size < file.size ? out : file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Natural size from the file header (PNG, JPEG, GIF, WebP); null when unknown.
export function imageSize(bytes) {
  const b = bytes;
  const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b[0] === 0x89 && b[1] === 0x50) return { width: u32(16), height: u32(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
    return null;
  }
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}
