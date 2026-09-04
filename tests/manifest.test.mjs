import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  const content = await fs.readFile(path.join(root, relativePath), 'utf8');
  return JSON.parse(content);
}

test('manifest declares the v0.6 reader page with guarded resource access', async () => {
  const manifest = await readJson('manifest.json');

  assert.equal(manifest.id, 'hana-reader');
  assert.equal(manifest.version, '0.6.0');
  assert.equal(manifest.trust, 'full-access');
  assert.deepEqual(manifest.capabilities, ['resource.read', 'resource.write']);
  assert.equal(manifest.contributes.page.route, '/page');
  assert.ok(manifest.ui.hostCapabilities.includes('resource.pick'));
  assert.ok(manifest.dev.scenarios.some((scenario) => scenario.id === 'open-page'));
});

test('reader source, built assets, and cache-busting route are present', async () => {
  for (const relativePath of [
    'README.md',
    'COLLABORATION.md',
    'routes/ui.js',
    'src/panel.js',
    'src/markdown-engine.js',
    'src/markdown-editor.js',
    'docs/S2_EDITOR_VALIDATION.md',
    'docs/S3_SAFE_WRITE.md',
    'docs/S4_CODE_HTML.md',
    'docs/S5_MAPLE_LAYOUT.md',
    'tests/write-route.test.mjs',
    'assets/hana-bridge.js',
    'assets/panel.js',
    'assets/panel.css',
  ]) {
    await fs.access(path.join(root, relativePath));
  }

  const manifest = await readJson('manifest.json');
  assert.ok(manifest.capabilities.includes('resource.write'));

  const panelSource = await fs.readFile(path.join(root, 'src/panel.js'), 'utf8');
  const panelBundle = await fs.readFile(path.join(root, 'assets/panel.js'), 'utf8');
  const route = await fs.readFile(path.join(root, 'routes/ui.js'), 'utf8');
  const css = await fs.readFile(path.join(root, 'assets/panel.css'), 'utf8');
  assert.ok(!panelSource.includes("from './hana-bridge.js'"));
  assert.match(panelSource, /render\(\);\s*hana\.ready\(/);
  assert.match(panelBundle, /markdown-it/);
  assert.match(route, /unhandledrejection/);
  assert.match(route, /const token = c\.req\.query\('token'\)/);
  assert.match(route, /ASSET_REVISION = '0\.6\.0'/);
  assert.match(route, /withAssetQuery/);
  assert.match(route, /params\.set\('token', token\)/);
  assert.match(route, /app\.post\('\/resources\/write'/);
  assert.match(route, /writeExpectedVersion/);
  assert.match(panelSource, /const PLUGIN_VERSION = '0\.6\.0'/);
  assert.match(panelSource, /mountMarkdownEditor/);
  assert.match(panelSource, /resources\/write/);
  assert.doesNotMatch(panelSource, /createLineDiff/);
  assert.doesNotMatch(panelSource, /showEditorDiff/);
  assert.match(panelSource, /scheduleAutoSave/);
  assert.match(panelSource, /undoLastWrite/);
  assert.match(panelSource, /source-editor/);
  assert.match(panelSource, /setRangeText\('  '/);
  assert.match(panelSource, /sandbox title="安全 HTML 预览"/);
  assert.match(panelSource, /sanitizeHtmlPreview/);
  assert.match(panelSource, /toggle-html-preview/);
  assert.match(panelSource, /MAX_EDIT_BYTES = 512 \* 1024/);
  assert.match(panelSource, /超过 512 KB，仅只读预览/);
  assert.match(panelSource, /data-action="read-mode"/);
  assert.match(panelSource, /只读/);
  assert.match(panelSource, /编辑/);
  assert.match(panelSource, /回撤/);
  assert.match(panelSource, /编辑自动保存/);
  assert.match(panelSource, /reader-modebar/);
  assert.match(panelSource, /panel-resizer/);
  assert.match(panelSource, /toggle-left/);
  assert.match(panelSource, /toggle-right/);
  assert.match(panelSource, /pointerdown/);
  assert.doesNotMatch(panelSource, /<header class=\"topbar\"/);
  assert.match(css, /grid-template-columns: var\(--left-panel-width\)/);
  assert.match(css, /height: 100vh/);
  assert.match(css, /overflow: hidden/);
});

test('reader persists and restores the last workspace, file, and scroll position', async () => {
  const panel = await fs.readFile(path.join(root, 'src/panel.js'), 'utf8');

  assert.match(panel, /hana-reader:last-session:v1/);
  assert.match(panel, /window\.localStorage\.getItem\(SESSION_STORAGE_KEY\)/);
  assert.match(panel, /window\.localStorage\.setItem\(SESSION_STORAGE_KEY, JSON\.stringify\(snapshot\)\)/);
  assert.match(panel, /currentPath: state\.current\?\.node\?\.relativePath/);
  assert.match(panel, /scrollTop: state\.current\?\.scrollTop/);
  assert.match(panel, /viewer\.addEventListener\('scroll'/);
  assert.match(panel, /restoreSession\(\);/);
});

test('mature Markdown and syntax engines are locally bundled with safe defaults', async () => {
  const engine = await fs.readFile(path.join(root, 'src/markdown-engine.js'), 'utf8');
  const css = await fs.readFile(path.join(root, 'assets/panel.css'), 'utf8');
  const packageJson = await readJson('package.json');

  assert.ok(packageJson.dependencies['markdown-it']);
  assert.ok(packageJson.dependencies['highlight.js']);
  assert.ok(packageJson.dependencies.dompurify);
  assert.ok(packageJson.dependencies['markdown-it-task-lists']);
  assert.ok(packageJson.dependencies['@milkdown/kit']);
  assert.match(engine, /html: false/);
  assert.match(engine, /ALLOWED_URI_REGEXP/);
  assert.match(engine, /markdown\.use\(taskLists/);
  assert.match(engine, /sanitizeHtmlPreview/);
  assert.match(engine, /FORBID_TAGS/);
  assert.match(engine, /highlight\.js/);
  assert.match(css, /\.code-viewer \.hljs-keyword/);
  assert.match(css, /\.markdown-body \.hljs-string/);
});
