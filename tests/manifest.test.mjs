import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  const content = await fs.readFile(path.join(root, relativePath), 'utf8');
  return JSON.parse(content);
}

test('manifest declares the v2.0.0 reader page with guarded resource access', async () => {
  const manifest = await readJson('manifest.json');
  const packageJson = await readJson('package.json');
  const lockJson = await readJson('package-lock.json');

  assert.equal(manifest.id, 'hana-reader');
  assert.equal(manifest.version, '2.0.0');
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
    'docs/PLUGIN_LOADING.md',
    'docs/MAPLE_REUSE_AUDIT.md',
    'tests/write-route.test.mjs',
    'assets/hana-bridge.js',
    'assets/panel.js',
    'assets/panel.css',
    'assets/native-knob.svg',
    'assets/collapse-wave.png',
    'assets/reader-empty.png',
    'assets/copilot-empty.png',
    'assets/file-panel-header.svg',
    'assets/notebook-note.png',
    'assets/notebook-bg.png',
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
  const nativeKnob = await fs.readFile(path.join(root, 'assets/native-knob.svg'), 'utf8');
  const vectorAssets = await Promise.all(['file-panel-header.svg'].map((name) => fs.readFile(path.join(root, 'assets', name), 'utf8')));
  const collapseWave = await fs.readFile(path.join(root, 'assets', 'collapse-wave.png'));
  const route = await fs.readFile(path.join(root, 'routes/ui.js'), 'utf8');
  const css = await fs.readFile(path.join(root, 'assets/panel.css'), 'utf8');
  assert.ok(!panelSource.includes("from './hana-bridge.js'"));
  assert.match(panelSource, /render\(\);\s*hana\.ready\(/);
  assert.match(panelSource, /notebook-note\.png/);
  assert.match(panelSource, /notebook-bg\.png/);
  assert.match(panelBundle, /markdown-it/);
  assert.match(route, /unhandledrejection/);
  assert.match(route, /const token = c\.req\.query\('token'\)/);
  assert.match(route, /ASSET_REVISION = '2\.0\.0'/);
  assert.match(route, /withAssetQuery/);
  assert.match(route, /params\.set\('token', token\)/);
  assert.match(route, /app\.post\('\/resources\/search'/);
  assert.match(route, /MAX_SEARCH_DIRECTORIES = 1000/);
  assert.match(route, /MAX_SEARCH_TOTAL_BYTES = 8 \* 1024 \* 1024/);
  assert.match(route, /app\.post\('\/resources\/write'/);
  assert.match(route, /app\.post\('\/copilot\/ask'/);
  assert.match(route, /model:sample-text/);
  assert.match(route, /writeExpectedVersion/);
  assert.match(panelSource, /const PLUGIN_VERSION = '2.0.0'/);
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
  assert.match(panelSource, /data-action="toggle-reader-mode"/);
  assert.match(panelSource, /pluginAssetUrl\('native-knob\.svg'\)/);
  assert.match(panelSource, /setEmbeddedKnobState/);
  assert.match(panelSource, /transitionend/);
  assert.match(panelSource, /onSettled/);
  assert.match(panelSource, /ensureWorkspaceShell/);
  assert.match(panelSource, /workspaceBody/);
  assert.match(panelSource, /reader-mode-mount/);
  assert.doesNotMatch(panelSource, /id="editor-status" class="editor-status"/);
  assert.match(nativeKnob, /id="slider-wrap"/);
  assert.match(nativeKnob, /id="knob-motion"/);
  assert.match(nativeKnob, /data-state="left"/);
  assert.match(nativeKnob, /prefers-reduced-motion/);
  vectorAssets.forEach((asset) => {
    assert.match(asset, /<path/);
    assert.doesNotMatch(asset, /<image|<filter|drop-shadow/);
  });
  assert.deepEqual([...collapseWave.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(collapseWave.readUInt32BE(16), 229);
  assert.equal(collapseWave.readUInt32BE(20), 1536);
  assert.ok(collapseWave.length > 100000);
  assert.match(panelSource, /只读/);
  assert.match(panelSource, /编辑/);
  assert.match(panelSource, /reader-floating-toolbar/);
  assert.match(panelSource, /panel-resizer/);
  assert.match(panelSource, /treeIconSvg/);
  assert.match(panelSource, /NOTEBOOK_STORAGE_KEY/);
  assert.match(panelSource, /show-notebook/);
  assert.match(panelSource, /data-notebook/);
  assert.match(panelSource, /applyAnnotationMarks/);
  assert.match(panelSource, /sliceAnnotation/);
  assert.match(panelSource, /selection\.rawStart/);
  assert.match(panelSource, /annotationActionIcon/);
  assert.match(panelSource, /annotation-action-icon/);
  assert.match(panelSource, /pendingWaveEntrances/);
  assert.match(panelSource, /is-entering/);
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
  assert.match(panelSource, /tree-root/);
  assert.match(panelSource, /COLLAPSED_PANEL_WIDTH = 96/);
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
  assert.match(panelSource, /\['highlight', 'underline', 'erase'\]/);
  assert.match(panelSource, /kind === 'underline'/);
  assert.doesNotMatch(panelSource, /data-annotation-action="underline">下划线/);
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
  assert.match(panel, /assistant-collapse/);
  assert.match(panel, /side-collapse-control/);
  assert.match(panel, /file-panel-expand/);
  assert.match(panel, /data-action="toggle-left"/);
  assert.match(panel, /file-panel-header\.svg/);
  assert.match(panel, /collapse-wave\.png/);
  assert.match(panel, /reader-empty\.png/);
  assert.match(panel, /copilot-empty\.png/);
  assert.match(panel, /function renderCollapseIcon/);
  assert.match(panel, /panel-collapse-icon/);
  assert.match(panel, /function requestStableSurfaceResize/);
  assert.match(panel, /Number\(window\.innerHeight\)/);
  assert.match(panel, /side-collapse-slot/);
  assert.doesNotMatch(panel, /root\.scrollHeight/);
  assert.doesNotMatch(panel, /collapse-left\.png|collapse-right\.png/);
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
  assert.match(css, /\.reader-mode-knob/);
  assert.match(css, /::selection/);
  assert.match(css, /\.assistant-switcher/);
  assert.match(css, /\.notebook-tab/);
  assert.match(css, /width: clamp\(110px, 11\.4vw, 125px\)/);
  assert.match(css, /\.collapse-waves/);
  assert.match(css, /width: min\(100%, 1220px\)/);
  assert.match(css, /height: 120%/);
  assert.match(css, /collapse-wave-art/);
  assert.match(css, /collapse-wave-surge-left/);
  assert.match(css, /collapse-wave-surge-right/);
  assert.match(css, /\.collapse-waves-left\.is-entering/);
  assert.match(css, /\.collapse-waves-right\.is-entering/);
  assert.match(css, /grid-template-columns: 96px 0/);
  assert.match(css, /right: 4px/);
  assert.match(css, /left: 4px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /animation: wave/);
  assert.match(css, /transition: right 280ms/);
  assert.match(css, /padding-inline: clamp\(40px, 7\.7vw, 128px\)/);
  assert.match(css, /z-index: 4/);
  assert.match(css, /border-right-color: transparent/);
  assert.match(css, /border-left-color: transparent/);
  assert.match(css, /:has\(\+ \.copilot-panel\.is-collapsed\)/);
  assert.match(css, /\.reader-mode-knob-art/);
  assert.match(css, /\.reader-mode-mount/);
  assert.match(css, /\.workspace-shell/);
  assert.match(css, /overflow: visible/);
  assert.match(css, /transition: grid-template-columns/);
  assert.match(css, /\.file-panel-expand[\s\S]*top: 22px/);
  assert.match(css, /\.file-panel\.is-collapsed > \.panel-heading[\s\S]*visibility: hidden/);
  assert.match(css, /\.side-collapse-slot/);
  assert.doesNotMatch(css, /\.file-panel\.is-collapsed \.panel-heading > div:first-child/);
  assert.match(css, /\.file-panel-expand/);
  assert.match(css, /\.file-panel\.is-collapsed \.panel-heading-actions/);
  assert.match(css, /\.annotation-comment/);
  assert.match(css, /--reader-scroll-thumb/);
  assert.match(css, /--reader-middle-bg: #ffffff/);
  assert.match(css, /--reader-side-bg: #f7f7f5/);
  assert.match(css, /--reader-selection: rgba\(160, 194, 255, 0\.32\)/);
  assert.match(css, /height: 26px/);
  assert.match(css, /transform: translateY\(-1px\)/);
  assert.match(css, /\.assistant-switcher > \.assistant-collapse/);
  assert.match(css, /flex: 0 0 32px/);
  assert.match(css, /\.side-collapse-control/);
  assert.match(css, /height: 60px/);
  assert.match(css, /height: 54px/);
  assert.match(css, /padding: 17px 0 5px 4px/);
  assert.match(css, /right: 4px/);
  assert.match(css, /left: 4px/);
  assert.match(css, /background: inherit/);
  assert.match(css, /padding: 22px 14px 6px/);
  assert.match(css, /rgba\(215, 230, 255, 0\.32\)/);
  assert.match(css, /\.notebook-wrap \{/);
  assert.match(css, /\.markdown-body \.markdown-code \{/);
  assert.match(css, /\.heading-number[\s\S]*font-family: inherit/);
  assert.match(css, /\.notebook-toolbar \{[\s\S]*flex-wrap: nowrap/);
  assert.match(css, /background: #ffffff/);
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

test('quiet motion v2 tokens stay local, token-based, and reduced-motion aware', async () => {
  const panel = await fs.readFile(path.join(root, 'src/panel.js'), 'utf8');
  const css = await fs.readFile(path.join(root, 'assets/panel.css'), 'utf8');

  assert.match(panel, /runQuietEntrances/);
  assert.match(panel, /quietReadingSwap/);
  assert.match(panel, /quietRightPaneSwap/);
  assert.match(panel, /quietNotebookBodySwap/);
  assert.match(panel, /currentPassExpandedDirs/);
  assert.match(panel, /expandedDirsRendered/);
  assert.match(panel, /lastReadingFingerprint/);
  assert.match(panel, /baseSha256/);
  assert.match(panel, /hasRenderedOnce/);
  assert.doesNotMatch(panel, /QUIET_ENTRANCE_GUARD_MS|lastQuietEntranceAt/);
  assert.match(panel, /quiet-tree-enter/);
  assert.match(panel, /quiet-tree-exit/);
  assert.match(panel, /collapsingDirs/);
  assert.match(panel, /QUIET_TREE_COLLAPSE_MS = 210/);
  assert.match(panel, /quiet-selection-enter/);
  assert.match(panel, /lastSelectedNodeId/);
  assert.match(panel, /quiet-view-enter/);
  assert.match(panel, /quiet-pane-enter/);
  assert.match(panel, /quiet-notebook-body-enter/);
  assert.match(panel, /notebook-pane-body/);
  assert.match(panel, /assistant-pane-slot/);
  assert.match(panel, /notebook-pane-slot/);
  assert.match(panel, /preserveAssistantShell/);
  assert.match(panel, /classList\.add\('q-exit-to'\)/);
  assert.match(css, /@starting-style/);

  const quietSection = css.slice(css.indexOf('Quiet motion v2'));
  assert.match(css, /--ease-out: cubic-bezier\(\.23, 1, \.32, 1\)/);
  assert.match(css, /--ease-in-out: cubic-bezier\(\.77, 0, \.175, 1\)/);
  assert.match(css, /\.tree-nested-shell/);
  assert.match(css, /grid-template-rows 210ms/);
  assert.match(css, /\.quiet-tree-enter/);
  assert.match(css, /\.quiet-tree-exit/);
  assert.match(css, /\.quiet-view-enter/);
  assert.match(css, /\.quiet-pane-enter/);
  assert.match(css, /\.quiet-notebook-body-enter/);
  assert.match(css, /\.assistant-pane-slot/);
  assert.match(css, /\.notebook-pane-slot/);
  assert.match(css, /\.notebook-pane-body/);
  assert.match(quietSection, /@starting-style/);
  assert.doesNotMatch(quietSection, /@keyframes/);
  assert.doesNotMatch(quietSection, /transition:\s*all\s*;/);
  assert.doesNotMatch(quietSection, /scale\(0\)/);
  assert.doesNotMatch(quietSection, /requestAnimationFrame/);
  assert.match(css, /transition: opacity var\(--quiet-duration\) var\(--ease-out\), transform var\(--quiet-duration\) var\(--ease-out\)/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.quiet-tree-enter,[\s\S]*transition: none/);
});
