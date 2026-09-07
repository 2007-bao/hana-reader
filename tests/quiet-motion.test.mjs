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
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

test('Quiet CSS starting styles and exit handoff actually run in Chromium', async (t) => {
  const browser = findChrome();
  if (!browser) {
    t.skip('No Chromium-compatible browser found');
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-reader-quiet-'));
  const htmlPath = path.join(tempDir, 'case.html');
  const css = await fs.readFile(path.join(root, 'assets/panel.css'), 'utf8');
  await fs.writeFile(htmlPath, `<!doctype html><html><head><style>${css}</style></head><body><main id="root"></main><script>
    const root = document.querySelector('#root');
    const tree = document.createElement('div');
    tree.className = 'tree-nested-shell quiet-tree-enter';
    tree.innerHTML = '<div class="tree-nested"><button class="tree-row">file.md</button></div>';
    root.append(tree);
    const pane = document.createElement('div');
    pane.className = 'quiet-pane-enter';
    pane.textContent = 'Notebook';
    root.append(pane);
    setTimeout(() => {
      document.documentElement.dataset.treeMidOpacity = getComputedStyle(tree).opacity;
      document.documentElement.dataset.treeMidRows = getComputedStyle(tree).gridTemplateRows;
      document.documentElement.dataset.paneMidOpacity = getComputedStyle(pane).opacity;
      void document.documentElement.offsetWidth;
      tree.classList.remove('q-enter-from');
      pane.classList.remove('q-enter-from');
    }, 45);
    setTimeout(() => {
      document.documentElement.dataset.treeEndOpacity = getComputedStyle(tree).opacity;
      document.documentElement.dataset.paneEndOpacity = getComputedStyle(pane).opacity;
      tree.classList.add('quiet-tree-exit', 'q-exit-to');
      setTimeout(() => {
        document.documentElement.dataset.exitOpacity = getComputedStyle(tree).opacity;
      }, 45);
    }, 300);
  </script></body></html>`, 'utf8');

  const profilePath = path.join(tempDir, 'profile');
  const dom = execFileSync(browser, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--virtual-time-budget=500',
    `--user-data-dir=${profilePath}`,
    '--dump-dom',
    pathToFileURL(htmlPath).href,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });

  assert.match(dom, /data-tree-mid-opacity="[^"]+"/);
  assert.match(dom, /data-tree-mid-rows="[^"]+"/);
  assert.match(dom, /data-pane-mid-opacity="[^"]+"/);
  assert.match(dom, /data-tree-end-opacity="[^"]+"/);
  assert.match(dom, /data-pane-end-opacity="[^"]+"/);
  assert.match(dom, /data-exit-opacity="[^"]+"/);
});
