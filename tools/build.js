// Bundles the app into self-contained HTML files (no server, no network needed
// except Google Fonts):
//   dist/index.html     full document (open locally or host on GitHub Pages)
//   dist/artifact.html  same content without <html>/<head>/<body> wrappers
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Order matters: dependencies first.
const CORE = ['src/rules.js', 'src/matrixgame.js', 'src/engine.js', 'src/pairing.js', 'src/advisor.js', 'src/matrix.js'];

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

const html = read('index.html');
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
