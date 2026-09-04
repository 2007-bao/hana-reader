import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');

async function loadRenderer() {
  const source = await fs.readFile(path.join(root, 'assets/panel.js'), 'utf8');
  const start = source.indexOf('function safeMarkdownUrl');
  const end = source.indexOf('const keywordSets');
  const escapeHtml = `function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }\n`;
  const code = `${escapeHtml}${source.slice(start, end)}\nfunction highlightCode(source) { return escapeHtml(source); }\nglobalThis.renderMarkdownForTest = renderMarkdown;\nglobalThis.inlineMarkdownForTest = inlineMarkdown;`;
  const context = { window: { location: { href: 'http://localhost/' } } };
  vm.runInNewContext(code, context);
  return context;
}

test('inline code and links are isolated from emphasis parsing', async () => {
  const renderer = await loadRenderer();
  const output = renderer.inlineMarkdownForTest('`_not_italic_` and [`docs/PLUGIN_LOADING.md`](docs/PLUGIN_LOADING.md)');

  assert.match(output, /<code>_not_italic_<\/code>/);
  assert.match(output, /<span class="md-link" title="docs\/PLUGIN_LOADING\.md"><code>docs\/PLUGIN_LOADING\.md<\/code><\/span>/);
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
