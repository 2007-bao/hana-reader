import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  const content = await fs.readFile(path.join(root, relativePath), 'utf8');
  return JSON.parse(content);
}

test('manifest declares a full-access reader page with read-only resource access', async () => {
  const manifest = await readJson('manifest.json');

  assert.equal(manifest.id, 'hana-reader');
  assert.equal(manifest.version, '0.1.6');
  assert.equal(manifest.trust, 'full-access');
  assert.deepEqual(manifest.capabilities, ['resource.read']);
  assert.equal(manifest.contributes.page.route, '/page');
  assert.ok(manifest.ui.hostCapabilities.includes('resource.pick'));
  assert.ok(manifest.dev.scenarios.some((scenario) => scenario.id === 'open-page'));
});

test('M0 files exist and no write capability is declared', async () => {
  for (const relativePath of [
    'README.md',
    'COLLABORATION.md',
    'routes/ui.js',
    'assets/hana-bridge.js',
    'assets/panel.js',
    'assets/panel.css',
  ]) {
    await fs.access(path.join(root, relativePath));
  }

  const manifest = await readJson('manifest.json');
  assert.ok(!manifest.capabilities.includes('resource.write'));

  const panel = await fs.readFile(path.join(root, 'assets/panel.js'), 'utf8');
  const route = await fs.readFile(path.join(root, 'routes/ui.js'), 'utf8');
  assert.ok(!panel.includes("from './hana-bridge.js'"));
  assert.match(panel, /render\(\);\s*hana\.ready\(/);
  assert.match(route, /unhandledrejection/);
  assert.match(route, /const token = c\.req\.query\('token'\)/);
  assert.match(route, /withToken/);
});

test('reader persists and restores the last workspace, file, and scroll position', async () => {
  const panel = await fs.readFile(path.join(root, 'assets/panel.js'), 'utf8');

  assert.match(panel, /hana-reader:last-session:v1/);
  assert.match(panel, /window\.localStorage\.getItem\(SESSION_STORAGE_KEY\)/);
  assert.match(panel, /window\.localStorage\.setItem\(SESSION_STORAGE_KEY, JSON\.stringify\(snapshot\)\)/);
  assert.match(panel, /currentPath: state\.current\?\.node\?\.relativePath/);
  assert.match(panel, /scrollTop: state\.current\?\.scrollTop/);
  assert.match(panel, /viewer\.addEventListener\('scroll'/);
  assert.match(panel, /restoreSession\(\);/);
});

test('Markdown reader supports common GFM reading elements with safe external links', async () => {
  const panel = await fs.readFile(path.join(root, 'assets/panel.js'), 'utf8');
  const css = await fs.readFile(path.join(root, 'assets/panel.css'), 'utf8');

  assert.match(panel, /parseMarkdownTableRow/);
  assert.match(panel, /task-item/);
  assert.match(panel, /safeMarkdownUrl/);
  assert.match(panel, /codeSpans/);
  assert.match(panel, /noopener noreferrer/);
  assert.match(panel, /output\.push\('<hr>'\)/);
  assert.match(panel, /char === '\/' && next === '\*'/);
  assert.match(css, /\.markdown-table-wrap/);
  assert.match(css, /\.task-item/);
  assert.match(css, /\.markdown-code \{/);
  assert.match(css, /\.token-comment \{[\s\S]*?color: #87968e;/);
});
