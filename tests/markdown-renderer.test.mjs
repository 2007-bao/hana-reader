import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { highlightCode, renderMarkdown } from '../src/markdown-engine.js';

const root = path.resolve(import.meta.dirname, '..');

test('mature renderer isolates inline code, links, and emphasis', () => {
  const output = renderMarkdown('`_not_italic_` and [`docs/PLUGIN_LOADING.md`](docs/PLUGIN_LOADING.md) with _real emphasis_.');

  assert.match(output, /<code>_not_italic_<\/code>/);
  assert.match(output, /<a href="docs\/PLUGIN_LOADING\.md"><code>docs\/PLUGIN_LOADING\.md<\/code><\/a>/);
  assert.match(output, /<em>real emphasis<\/em>/);
  assert.doesNotMatch(output, /@@HANA|\uE000|\uE001/);
});

test('README directory heading remains a normal heading', async () => {
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  const output = renderMarkdown(readme);

  assert.match(output, /<h2>目录结构<\/h2>/);
  assert.doesNotMatch(output, /<h2><em>目录结构<\/em><\/h2>/);
  assert.doesNotMatch(output, /<em>/);
});

test('GFM tables, task lists, and raw HTML are handled safely', () => {
  const output = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] done\n- [ ] next\n\n<script>alert(1)</script>');

  assert.match(output, /<table>/);
  assert.match(output, /contains-task-list/);
  assert.match(output, /task-list-item-checkbox/);
  assert.match(output, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(output, /<script>/);
});

test('code highlighting uses a mature grammar engine', () => {
  const output = highlightCode('const answer = 42; // ready', 'javascript');

  assert.match(output, /hljs-keyword/);
  assert.match(output, /hljs-number/);
  assert.match(output, /hljs-comment/);
});

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

test('Chromium DOM keeps README blocks outside emphasis elements', async (t) => {
  const browser = findChrome();
  if (!browser) {
    t.skip('No Chromium-compatible browser found');
    return;
  }

  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  const output = renderMarkdown(readme);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-reader-markdown-'));
  const htmlPath = path.join(tempDir, 'case.html');
  const profilePath = path.join(tempDir, 'profile');
  await fs.writeFile(htmlPath, `<!doctype html><article class="markdown-body">${output}</article>`, 'utf8');

  try {
    const dom = execFileSync(browser, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profilePath}`,
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });

    assert.match(dom, /<h2>目录结构<\/h2>/);
    assert.match(dom, /<pre class="markdown-code"><code class="language-text">/);
    assert.match(dom, /<h2>权限边界<\/h2>/);
    assert.doesNotMatch(dom, /<h2><em>/);
    assert.doesNotMatch(dom, /<pre><em>/);
    assert.doesNotMatch(dom, /<ul><em>/);
    assert.doesNotMatch(dom, /\uE000|\uE001|@@HANA/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
