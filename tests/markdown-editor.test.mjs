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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

test('Milkdown editor mounts locally and round-trips Markdown in Chromium', async (t) => {
  const browser = findChrome();
  if (!browser) {
    t.skip('No Chromium-compatible browser found');
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-reader-editor-'));
  const entryPath = path.join(root, 'tests/.tmp-markdown-editor-entry.mjs');
  const bundlePath = path.join(tempDir, 'editor.mjs');
  const htmlPath = path.join(tempDir, 'case.html');
  const profilePath = path.join(tempDir, 'profile');
  const fence = 'String.fromCharCode(96).repeat(3)';
  await fs.writeFile(entryPath, `
    import { editorViewCtx } from '@milkdown/kit/core';
    import { mountMarkdownEditor, serializeMarkdown } from '../src/markdown-editor.js';
    (async () => {
      const container = document.createElement('div');
      document.body.append(container);
      const editor = await mountMarkdownEditor(container, '# Title\\n\\n- [x] task\\n', {
        onMarkdownChange(markdown) { document.body.dataset.changed = markdown; },
      });
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      view.dispatch(view.state.tr.insertText(' edited', 6));
      await new Promise((resolve) => setTimeout(resolve, 80));
      document.body.dataset.ready = String(Boolean(container.querySelector('.ProseMirror')));
      document.body.dataset.serialized = serializeMarkdown(editor);
      document.body.dataset.heading = container.querySelector('h1')?.textContent || '';
      await editor.destroy();
      container.innerHTML = '';

      const fixtures = [
        '# Heading\\n',
        'Plain paragraph with **strong** and *emphasis*.\\n',
        String.fromCharCode(96) + 'inline code' + String.fromCharCode(96) + ' and [a link](https://example.com).\\n',
        '> quoted text\\n',
        '* one\\n* two\\n',
        '1. first\\n2. second\\n',
        '* parent\\n  * child\\n',
        '- [ ] todo\\n- [x] done\\n',
        '| A | B |\\n| --- | --- |\\n| 1 | 2 |\\n',
        ${fence} + 'javascript\\nconst value = 1;\\n' + ${fence} + '\\n',
        ${fence} + 'text\\nplain text\\n' + ${fence} + '\\n',
        '---\\n',
        '~~deleted~~\\n',
        '中文标题\\n========\\n',
        'first  \\nsecond\\n',
        '## One\\n\\n### Two\\n\\nparagraph\\n',
        '![alt](image.png)\\n',
        'A paragraph\\n\\n> quote\\n\\n* [x] task\\n',
        ${fence} + '\\n<not-html> & safe\\n' + ${fence} + '\\n',
        '#### final heading\\n\\n- item with ' + String.fromCharCode(96) + 'code' + String.fromCharCode(96) + '\\n',
      ];
      let roundTripCount = 0;
      for (const fixture of fixtures) {
        const firstEditor = await mountMarkdownEditor(container, fixture);
        const first = serializeMarkdown(firstEditor);
        await firstEditor.destroy();
        container.innerHTML = '';
        const secondEditor = await mountMarkdownEditor(container, first);
        const second = serializeMarkdown(secondEditor);
        if (first === second) roundTripCount += 1;
        await secondEditor.destroy();
        container.innerHTML = '';
      }
      document.body.dataset.roundtrip = String(roundTripCount);
    })();
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

    assert.match(dom, /data-ready="true"/);
    assert.match(dom, /data-heading="Title edited"/);
    assert.match(dom, /data-serialized="[^"]*edited/);
    assert.match(dom, /data-serialized="[^"]*\* \[x\] task/);
    assert.match(dom, /data-roundtrip="20"/);
  } finally {
    await fs.rm(entryPath, { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
