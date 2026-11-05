// Bundles src/ into one self-contained index.html (open it in a browser, no server needed).
import * as esbuild from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

async function build() {
  const [js, css, html] = await Promise.all([
    esbuild.build({
      entryPoints: [path.join(root, 'src/main.js')],
      bundle: true,
      format: 'iife',
      target: ['es2020', 'safari15'],
      minify: true,
      legalComments: 'none',
      write: false,
      charset: 'utf8',
    }),
    esbuild.build({
      entryPoints: [path.join(root, 'src/styles.css')],
      bundle: true,
      minify: true,
      target: ['safari15', 'chrome100'],
      write: false,
      charset: 'utf8',
    }),
    readFile(path.join(root, 'src/index.html'), 'utf8'),
  ]);
  const jsText = js.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');
  const cssText = css.outputFiles[0].text.replace(/<\/(style)/gi, '<\\/$1');
  const out = html
    .replace('/*__CSS__*/', () => cssText.trim())
    .replace('/*__JS__*/', () => jsText.trim());
  await writeFile(path.join(root, 'index.html'), out);
  console.log(`index.html: ${(out.length / 1024).toFixed(0)} KB`);
}

await build();
if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let t = null;
  fsWatch(path.join(root, 'src'), { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => build().catch((e) => console.error(e.message)), 100);
  });
  console.log('watching src/ …');
}
