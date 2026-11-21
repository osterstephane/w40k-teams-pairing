// Bundles the app into self-contained HTML files that need no server and no
// network (code, worker, fonts and icon inlined):
//   dist/index.html     full document: open it locally, offline
//   dist/artifact.html  same content without <html>/<head>/<body> wrappers
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Order matters: dependencies first.
const CORE = ['src/rules.js', 'src/matrixgame.js', 'src/engine.js', 'src/pairing.js', 'src/advisor.js', 'src/matrix.js', 'src/shared.js'];

function strip(src, file) {
  const out = src
    .replace(/^import [^;]+;\s*$/gm, '')
    .replace(/^export (?=(async )?function|const|let|class)/gm, '');
  if (/^\s*(import|export)\b/m.test(out)) throw new Error(`Unsupported import/export form in ${file}`);
  return `// ---- ${file}\n${out}`;
}

const core = CORE.map((f) => strip(read(f), f)).join('\n');
const workerSource = `${core}\n${strip(read('src/worker.js'), 'src/worker.js')}`;
const ui = strip(read('src/ui.js'), 'src/ui.js');
const safe = (s) => s.replace(/<\/(script)/gi, '<\\/$1');

// Fonts and icon as data: URIs, so the file works without any network.
const fontCss = read('assets/fonts/fonts.css').replace(/url\("([^"]+\.woff2)"\)/g, (_, f) =>
  `url("data:font/woff2;base64,${readFileSync(join(root, 'assets/fonts', f)).toString('base64')}")`);
const iconUri = `data:image/svg+xml;base64,${Buffer.from(read('assets/icons/icon.svg')).toString('base64')}`;

function replaceOnce(text, find, by) {
  if (!text.includes(find)) throw new Error(`Not found in index.html: ${find}`);
  return text.replace(find, () => by);
}

let html = read('index.html');
html = replaceOnce(html, '<link rel="stylesheet" href="assets/fonts/fonts.css">', `<style>\n${fontCss}</style>`);
html = replaceOnce(html, '<link rel="icon" href="assets/icons/icon.svg" type="image/svg+xml">', `<link rel="icon" href="${iconUri}" type="image/svg+xml">`);
// Installable-app links only make sense on the hosted version.
html = replaceOnce(html, '<link rel="manifest" href="manifest.webmanifest">\n', '');
html = replaceOnce(html, '<link rel="apple-touch-icon" href="assets/icons/icon-192.png">\n', '');
const tag = '<script type="module" src="src/ui.js"></script>';
if (!html.includes(tag)) throw new Error('ui.js script tag not found in index.html');
const inline = `<script>window.__CORE_SOURCE__ = ${safe(JSON.stringify(workerSource))};</script>\n<script type="module">\n${safe(core)}\n${safe(ui)}\n</script>`;
const full = html.replace(tag, () => inline);

const artifact = full
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '')
  .replace(/<\/html>\s*/i, '')
  .replace(/<head>\s*/i, '')
  .replace(/<\/head>\s*/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .replace(/<body>\s*/i, '')
  .replace(/<\/body>\s*/i, '');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/index.html'), full);
writeFileSync(join(root, 'dist/artifact.html'), artifact);
console.log(`dist/index.html ${(full.length / 1024).toFixed(0)} KB, dist/artifact.html ${(artifact.length / 1024).toFixed(0)} KB`);
