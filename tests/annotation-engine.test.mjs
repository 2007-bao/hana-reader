import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

test('annotation engine restores text anchors and wraps non-overlapping ranges', async (t) => {
  const browser = findChrome();
  if (!browser) {
    t.skip('No Chromium-compatible browser found');
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-reader-annotation-'));
  const entryPath = path.join(tempDir, 'entry.mjs');
  const bundlePath = path.join(tempDir, 'annotation.mjs');
  const htmlPath = path.join(tempDir, 'case.html');
  const profilePath = path.join(tempDir, 'profile');
  await fs.writeFile(entryPath, `
    import { applyAnnotationMarks, selectionAnchor } from ${JSON.stringify(path.join(root, 'src/annotation-engine.js'))};
    const article = document.createElement('article');
    article.innerHTML = '<p>Hello <strong>world</strong> and Hana.</p><p>Second paragraph.</p>';
    document.body.append(article);
    const world = article.querySelector('strong').firstChild;
    const range = document.createRange();
    range.setStart(world, 0);
    range.setEnd(world, world.nodeValue.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const anchor = selectionAnchor(article, selection);
    const rendered = applyAnnotationMarks(article, [
      { id: 'world', kind: 'highlight', quote: 'world', prefix: 'Hello ', suffix: ' and Hana.' },
      { id: 'second', kind: 'underline', quote: 'Second paragraph.' },
    ]);
    document.body.dataset.anchor = anchor?.quote || '';
    document.body.dataset.rendered = String(rendered.size);
    document.body.dataset.highlight = String(Boolean(article.querySelector('[data-annotation-id="world"]')));
    document.body.dataset.underline = String(Boolean(article.querySelector('[data-annotation-id="second"]')));
  `, 'utf8');
  execFileSync(process.execPath, [
    path.join(root, 'node_modules/esbuild/bin/esbuild'),
    entryPath,
    '--bundle',
    '--format=esm',
    '--target=es2020',
    `--outfile=${bundlePath}`,
  ], { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true });
  await fs.writeFile(htmlPath, `<!doctype html><body><script type="module" src="${pathToFileURL(bundlePath).href}"></script></body>`, 'utf8');

  try {
    const dom = execFileSync(browser, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--allow-file-access-from-files',
      '--virtual-time-budget=1000',
      `--user-data-dir=${profilePath}`,
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });

    assert.match(dom, /data-anchor="world"/);
    assert.match(dom, /data-rendered="2"/);
    assert.match(dom, /data-highlight="true"/);
    assert.match(dom, /data-underline="true"/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
