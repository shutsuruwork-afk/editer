// Images are kept inside the document as data URLs, so large photos are scaled down first.
const MAX_SIDE = 1600;
const KEEP_AS_IS = 300 * 1024;

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}

function hasAlpha(ctx, w, h) {
  const step = Math.max(1, Math.floor((w * h) / 40000));
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4 * step) if (data[i] < 250) return true;
  return false;
}

export async function imageFileToDataUrl(file) {
  const original = await readAsDataUrl(file);
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return original; // keep vectors and animations
  const img = await loadImage(original);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error('decode');
  if (file.size <= KEEP_AS_IS && Math.max(w0, h0) <= MAX_SIDE) return original;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const webp = canvas.toDataURL('image/webp', 0.85);
  let out = webp.startsWith('data:image/webp') ? webp : (hasAlpha(ctx, w, h) ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85));
  if (out.length > original.length) out = original;
  return out;
}
