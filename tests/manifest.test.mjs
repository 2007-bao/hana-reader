import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  const content = await fs.readFile(path.join(root, relativePath), 'utf8');
  return JSON.parse(content);
}

test('manifest declares the v1.3.9 reader page with guarded resource access', async () => {
  const manifest = await readJson('manifest.json');
  const packageJson = await readJson('package.json');
  const lockJson = await readJson('package-lock.json');

  assert.equal(manifest.id, 'hana-reader');
  assert.equal(manifest.version, '1.3.9');
  assert.equal(packageJson.version, manifest.version);
  assert.equal(lockJson.version, manifest.version);
  assert.equal(manifest.trust, 'full-access');
  assert.deepEqual(manifest.capabilities, ['resource.read', 'resource.write', 'model.sample']);
  assert.equal(manifest.contributes.page.route, '/page');
  assert.ok(manifest.ui.hostCapabilities.includes('resource.pick'));
  assert.ok(manifest.ui.hostCapabilities.includes('resource.open'));
  assert.ok(manifest.dev.scenarios.some((scenario) => scenario.id === 'open-page'));
});

test('reader source, built assets, and cache-busting route are present', async () => {
  for (const relativePath of [
    'README.md',
    'COLLABORATION.md',
    'routes/ui.js',
    'scripts/check-version.mjs',
    'src/panel.js',
    'src/markdown-engine.js',
    'src/markdown-editor.js',
    'src/annotation-engine.js',
    'src/annotation-store.js',
    'src/notebook-store.js',
    'tests/annotation-engine.test.mjs',
    'tests/copilot-route.test.mjs',
    'tests/search-route.test.mjs',
    'tests/read-route.test.mjs',
    'tests/workspace-state.test.mjs',
    'docs/S2_EDITOR_VALIDATION.md',
    'docs/S3_SAFE_WRITE.md',
    'docs/S4_CODE_HTML.md',
    'docs/S5_MAPLE_LAYOUT.md',
    'tests/write-route.test.mjs',
    'assets/hana-bridge.js',
    'assets/panel.js',
    'assets/panel.css',
    'assets/fonts/MapleMono-Regular.woff2',
    'assets/fonts/MapleMono-Italic.woff2',
    'assets/fonts/OFL.txt',
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
  assert.match(route, /ASSET_REVISION = '1\.3\.9'/);
  assert.match(route, /withAssetQuery/);
  assert.match(route, /params\.set\('token', token\)/);
  assert.match(route, /app\.post\('\/resources\/search'/);
  assert.match(route, /MAX_SEARCH_DIRECTORIES = 1000/);
  assert.match(route, /MAX_SEARCH_TOTAL_BYTES = 8 \* 1024 \* 1024/);
  assert.match(route, /app\.post\('\/resources\/write'/);
  assert.match(route, /app\.post\('\/copilot\/ask'/);
  assert.match(route, /model:sample-text/);
  assert.match(route, /writeExpectedVersion/);
  assert.match(panelSource, /const PLUGIN_VERSION = '1.3.9'/);
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
  assert.match(panelSource, /reader-floating-toolbar/);
  assert.match(panelSource, /panel-resizer/);
  assert.match(panelSource, /treeIconSvg/);
  assert.match(panelSource, /NOTEBOOK_STORAGE_KEY/);
  assert.match(panelSource, /show-notebook/);
  assert.match(panelSource, /data-notebook/);
  assert.match(panelSource, /applyAnnotationMarks/);
  assert.doesNotMatch(panelSource, /data-annotation-filter/);
  assert.doesNotMatch(panelSource, /resolveVisibleAnnotations/);
  assert.match(panelSource, /copilot-submit/);
  assert.match(panelSource, /aria-live="polite"/);
  assert.match(panelSource, /retry-save/);
  assert.match(panelSource, /discard-draft/);
  assert.match(panelSource, /overwriteConflict/);
  assert.match(panelSource, /reloadConflict/);
  assert.doesNotMatch(panelSource, /已覆盖外部修改并自动保存/);
  assert.match(panelSource, /suppressEditorRemount/);
  assert.match(panelSource, /tree-nested.*nested-depth/);
  assert.match(panelSource, /fileIconType/);
  assert.match(panelSource, /previousTreeScroll/);
  assert.match(panelSource, /scheduleSessionSave/);
  assert.match(panelSource, /toggle-left/);
  assert.doesNotMatch(panelSource, /data-search-input/);
  assert.doesNotMatch(panelSource, /open-search-result/);
  assert.match(panelSource, /handleGlobalKeydown/);
  assert.doesNotMatch(panelSource, /RECENT_FILES_STORAGE_KEY/);
  assert.match(panelSource, /toggle-right/);
  assert.match(panelSource, /pointerdown/);
  assert.match(panelSource, /resources\.open/);
  assert.match(panelSource, /annotation-comment/);
  assert.match(panelSource, /showAnnotationBubble/);
  assert.match(panelSource, /data-annotation-action/);
  assert.match(panelSource, /data-annotation-action="erase"/);
  assert.doesNotMatch(panelSource, /<header class=\"topbar\"/);
  assert.match(css, /grid-template-columns: var\(--left-panel-width\)/);
  assert.match(css, /height: 100vh/);
  assert.match(css, /overflow: hidden/);
});

test('visual simplification keeps annotations, notebook, and Ctrl-Z paths local', async () => {
  const panel = await fs.readFile(path.join(root, 'src/panel.js'), 'utf8');
  const annotationEngine = await fs.readFile(path.join(root, 'src/annotation-engine.js'), 'utf8');
  const css = await fs.readFile(path.join(root, 'assets/panel.css'), 'utf8');

  assert.doesNotMatch(panel, /tree-root-name/);
  assert.doesNotMatch(panel, /bottom-bar/);
  assert.match(panel, /function handleGlobalKeydown/);
  assert.match(panel, /key === 'z'/);
  assert.match(panel, /annotationUndoAt/);
  assert.match(panel, /current\?\.undoAt/);
  assert.match(panel, /state\.editing \|\| isNativeEditingTarget/);
  assert.match(panel, /data-action="show-ai"/);
  assert.match(panel, /data-action="show-notebook"/);
  assert.match(panel, /file-panel-expand/);
  assert.match(panel, /data-action="toggle-left"/);
  assert.match(panel, /panel-heading-title.*文件栏/);
  assert.match(panel, /data-notebook/);
  assert.match(panel, /contextmenu/);
  assert.match(panel, /deleteNotebook/);
  assert.match(panel, /export-notebook-resource/);
  assert.match(panel, /cancelAnnotationComposer/);
  assert.match(panel, /activeSelectionRect/);
  assert.match(panel, /annotation-composer-actions/);
  assert.doesNotMatch(panel, /data-annotation-action="comment"/);
  assert.match(panel, /requestNotebookDelete/);
  assert.match(panel, /exportNotebookToResource/);
  assert.match(panel, /mode: 'file'/);
  assert.match(panel, /capability: 'resource.write'/);
  assert.doesNotMatch(panel, /window\.confirm/);
  assert.doesNotMatch(panel, /createObjectURL/);
  assert.match(panel, /!event\.shiftKey/);
  assert.match(panel, /readerScroll\.addEventListener\('scroll'/);
  assert.match(panel, /restoreEditorScroll/);
  assert.doesNotMatch(panel, /data-annotation-filter/);
  assert.doesNotMatch(panel, /annotation-sidebar/);
  assert.match(annotationEngine, /annotation-comment/);
  assert.match(annotationEngine, /dataset\.annotationNote/);
  assert.match(css, /\.reader-floating-toolbar/);
  assert.doesNotMatch(css, /\.file-panel\.is-collapsed \.panel-heading > div:first-child/);
  assert.match(css, /\.file-panel-expand/);
  assert.match(css, /\.file-panel\.is-collapsed \.panel-heading-actions/);
  assert.match(css, /\.annotation-comment/);
  assert.match(css, /--reader-scroll-thumb/);
  assert.match(css, /--reader-middle-bg: #ffffff/);
  assert.match(css, /--reader-side-bg: #f3efe7/);
  assert.match(css, /\.notebook-wrap \{/);
  assert.match(css, /background: #fffdf9/);
  assert.match(css, /\.code-viewer\[data-language="json"\]/);
  assert.match(css, /color: #20242a/);
  assert.match(css, /color: var\(--reader-heading\)/);
  assert.match(css, /background: #f5f6f7/);
  assert.match(css, /\.code-viewer\.markdown-code/);
  assert.match(css, /border-left: 0/);
  assert.match(css, /text-decoration: underline wavy #e49a55/);
  assert.match(css, /\.notebook-delete-prompt \{/);
  assert.match(css, /\.tree-icon\.markdown \{/);
  assert.match(css, /scrollbar-color: transparent transparent/);
  assert.match(panel, /bindTransientScrollbar/);
  assert.match(css, /text-decoration-skip-ink: none/);
});

test('reader persists and restores the last workspace, file, and scroll position', async () => {
  const panel = await fs.readFile(path.join(root, 'src/panel.js'), 'utf8');

  assert.match(panel, /hana-reader:last-session:v1/);
  assert.match(panel, /window\.localStorage\.getItem\(SESSION_STORAGE_KEY\)/);
  assert.match(panel, /window\.localStorage\.setItem\(SESSION_STORAGE_KEY, JSON\.stringify\(snapshot\)\)/);
  assert.match(panel, /currentPath: state\.current\?\.node\?\.relativePath/);
  assert.match(panel, /scrollTop: state\.current\?\.scrollTop/);
  assert.match(panel, /readerScroll\.addEventListener\('scroll'/);
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
  assert.match(css, /font-family: "Maple Mono"/);
  assert.match(css, /--maple-purple/);
  assert.match(css, /--maple-sea: #2f80ed/);
  assert.match(css, /--maple-galaxy: #2356d8/);
  assert.match(css, /--maple-morning: #9bc9ff/);
  assert.match(css, /--maple-stream: #5ea9ff/);
  assert.match(css, /--reader-code-plain: #20242a/);
  assert.match(css, /h1[\s\S]*color: var\(--maple-galaxy\)/);
  assert.match(css, /h2[\s\S]*color: var\(--maple-sea\)/);
  assert.match(css, /h3[\s\S]*color: var\(--reader-text\)/);
  assert.match(css, /h4[\s\S]*color: var\(--reader-text\)/);
  assert.match(css, /--reader-code-string: var\(--maple-lake\)/);
  assert.match(css, /border-left: 3px solid var\(--maple-galaxy\)/);
  assert.match(css, /tree-row\.directory/);
  assert.match(css, /body\[data-hana-theme="dark"\]/);
  assert.match(css, /--reader-code-keyword: var\(--maple-galaxy\)/);
  assert.match(css, /--maple-line-height-normal: 1\.45/);
  assert.match(css, /--maple-line-height-tight: 1\.35/);
  assert.match(css, /\.token-number,[\s\S]*font-family: var\(--reader-ui-font\)/);
  assert.match(css, /\.markdown-body \.hljs-string/);
});
