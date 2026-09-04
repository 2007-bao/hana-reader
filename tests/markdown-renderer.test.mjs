import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');

async function loadRenderer() {
  const source = await fs.readFile(path.join(root, 'assets/panel.js'), 'utf8');
  const start = source.indexOf('function safeMarkdownUrl');
  const end = source.indexOf('const keywordSets');
  const escapeHtml = `function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }\n`;
  const code = `${escapeHtml}${source.slice(start, end)}\nfunction highlightCode(source) { return escapeHtml(source); }\nglobalThis.renderMarkdownForTest = renderMarkdown;\nglobalThis.inlineMarkdownForTest = inlineMarkdown;`;
  const context = {
    window: { location: { href: 'https://example.com/api/plugins/hana-reader/page' } },
    URL,
    URLSearchParams,
  };
  vm.runInNewContext(code, context);
  return context;
}

test('inline code and links are isolated from emphasis parsing', async () => {
  const renderer = await loadRenderer();
  const output = renderer.inlineMarkdownForTest('`_not_italic_` and [`docs/PLUGIN_LOADING.md`](docs/PLUGIN_LOADING.md)');

  assert.match(output, /<code>_not_italic_<\/code>/);
  assert.match(output, /<a class="md-link" href="docs\/PLUGIN_LOADING\.md" target="_blank" rel="noopener noreferrer"><code>docs\/PLUGIN_LOADING\.md<\/code><\/a>/);
  assert.doesNotMatch(output, /<em>/);
  assert.doesNotMatch(output, /\uE000|\uE001/);
});

test('README directory heading remains a normal heading', async () => {
  const renderer = await loadRenderer();
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  const output = renderer.renderMarkdownForTest(readme);

  assert.match(output, /<h2>目录结构<\/h2>/);
  assert.doesNotMatch(output, /<h2><em>目录结构<\/em><\/h2>/);
  assert.doesNotMatch(output, /\uE000|\uE001/);
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

  const renderer = await loadRenderer();
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  const output = renderer.renderMarkdownForTest(readme);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-reader-markdown-'));
  const htmlPath = path.join(tempDir, 'case.html');
  const profilePath = path.join(tempDir, 'profile');
  const html = `<!doctype html><article class="markdown-body">${output}</article>`;
  await fs.writeFile(htmlPath, html, 'utf8');

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
    assert.match(dom, /<pre class="markdown-code"><code>/);
    assert.match(dom, /<h2>权限边界<\/h2>/);
    assert.doesNotMatch(dom, /<h2><em>/);
    assert.doesNotMatch(dom, /<pre><em>/);
    assert.doesNotMatch(dom, /<ul><em>/);
    assert.doesNotMatch(dom, /\uE000|\uE001|@@HANA/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
