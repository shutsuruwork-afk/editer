// One file with every document (and its images), and restoring from it. Restoring never
// overwrites: documents already here are skipped if they are the same or newer, otherwise the
// backup's copy is added next to them.
import * as store from '../store.js';
import { parseContent } from './docs.js';
import { stats, plainText, firstLine } from './text.js';
import { imageRefs, blobToDataUrl, dataUrlToBlob } from './images.js';

export async function makeBackup() {
  const metas = await store.listDocs();
  const docs = [];
  const hashes = new Set();
  for (const m of metas) {
    const d = await store.getDoc(m.id);
    if (!d) continue;
    docs.push({ id: d.id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, starred: !!d.starred, trashedAt: d.trashedAt || null, settings: d.settings, content: d.content });
    for (const h of d.images || []) hashes.add(h);
  }
  const images = {};
  for (const h of hashes) {
    const blob = await store.getBlob(h);
    if (blob) images[h] = await blobToDataUrl(blob);
  }
  const data = { format: 'editer-backup', version: 1, exportedAt: Date.now(), docs, images };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.format !== 'editer-backup' || !Array.isArray(data.docs)) throw new Error('editer のバックアップファイルではありません');
  for (const [hash, url] of Object.entries(data.images || {})) {
    const blob = dataUrlToBlob(url);
    if (blob && /^[0-9a-z]+$/.test(hash)) await store.putBlob(hash, blob);
  }
  const existing = new Map((await store.listDocs()).map((m) => [m.id, m]));
  let added = 0, skipped = 0;
  for (const d of data.docs) {
    const here = existing.get(d.id);
    if (here && (here.updatedAt || 0) >= (d.updatedAt || 0)) { skipped++; continue; }
    const { doc } = parseContent(d.content);
    const id = here ? store.newId() : String(d.id || store.newId());
    const title = here ? `${d.title || firstLine(doc) || '無題の文書'}（バックアップ）` : d.title || '';
    await store.saveDoc({
      id, title, preview: firstLine(doc), chars: stats(doc).noSpace,
      createdAt: d.createdAt || Date.now(), updatedAt: d.updatedAt || Date.now(),
      images: imageRefs(doc), content: doc.toJSON(), settings: d.settings || { writingMode: 'horizontal-tb' }, text: plainText(doc),
    }, 0, { force: true });
    if (d.starred || d.trashedAt) await store.patchMeta(id, { starred: !!d.starred, trashedAt: d.trashedAt || undefined });
    added++;
  }
  store.announce({ type: 'meta', id: '*' });
  return { added, skipped };
}
