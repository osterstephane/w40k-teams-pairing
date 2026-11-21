import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Files listed in sw.js FILES.
function cachedFiles() {
  const src = read('sw.js');
  const block = src.slice(src.indexOf('const FILES = ['), src.indexOf('];', src.indexOf('const FILES = [')));
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the service worker caches every file the hosted page loads', () => {
  const files = cachedFiles();
  const expected = [
    ...readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
    ...readdirSync(join(root, 'assets/fonts')).filter((f) => /\.(woff2|css)$/.test(f)).map((f) => `assets/fonts/${f}`),
    ...readdirSync(join(root, 'assets/icons')).map((f) => `assets/icons/${f}`),
    'index.html', 'manifest.webmanifest',
  ];
  for (const f of expected) assert.ok(files.includes(f), `sw.js does not cache ${f}`);
  for (const f of files) if (f !== './') assert.ok(existsSync(join(root, f)), `sw.js lists missing file ${f}`);
});

test('every font referenced by fonts.css exists', () => {
  for (const [, f] of read('assets/fonts/fonts.css').matchAll(/url\("([^"]+)"\)/g)) {
    assert.ok(existsSync(join(root, 'assets/fonts', f)), f);
  }
});

test('manifest icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  for (const icon of m.icons) assert.ok(existsSync(join(root, icon.src)), icon.src);
});

test('the standalone file loads nothing from the network or from other files', () => {
  const html = read('dist/index.html');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), 'no Google Fonts');
  assert.ok(!/(href|src)="(?!data:|#|https:\/\/osterstephane)[^"]+\.(css|js|png|svg|woff2|webmanifest)"/.test(html), 'no relative file');
  assert.ok(html.includes('data:font/woff2;base64,'), 'fonts are inlined');
});
