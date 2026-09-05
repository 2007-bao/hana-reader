import assert from 'node:assert/strict';
import test from 'node:test';

import { annotationResourceKey, loadAnnotations, saveAnnotations } from '../src/annotation-store.js';
import { appendNotebookReference, loadNotebookStore, saveNotebookStore } from '../src/notebook-store.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('Notebook store migrates the v1 plain text value and supports references', () => {
  const storage = memoryStorage();
  storage.setItem('notes', JSON.stringify('旧笔记'));
  const store = loadNotebookStore(storage, 'notes', 100);
  assert.equal(store.notebooks.length, 1);
  assert.equal(store.notebooks[0].text, '旧笔记');

  const next = appendNotebookReference(store.notebooks[0], { fileName: 'README.md', quote: '关键结论', note: '复习' }, 200);
  assert.match(next.text, /README\.md/);
  assert.match(next.text, /关键结论/);
  assert.match(next.text, /复习/);
});

test('Notebook store persists multiple notes with active selection', () => {
  const storage = memoryStorage();
  const store = loadNotebookStore(storage, 'notes', 100);
  store.notebooks.push({ id: 'second', title: '第二份', text: '内容', createdAt: 100, updatedAt: 100 });
  store.activeId = 'second';
  assert.equal(saveNotebookStore(storage, 'notes', store), true);
  const loaded = loadNotebookStore(storage, 'notes', 300);
  assert.equal(loaded.activeId, 'second');
  assert.equal(loaded.notebooks.length, 2);
});

test('annotation store is keyed by stable resource identity and survives reload', () => {
  const storage = memoryStorage();
  const keyA = annotationResourceKey({ path: 'C:\\notes.md', kind: 'local-file' });
  const keyB = annotationResourceKey({ kind: 'local-file', path: 'C:\\notes.md' });
  assert.equal(keyA, keyB);
  const annotation = { id: 'a1', kind: 'highlight', quote: '文本', prefix: '', suffix: '', replies: [], resolved: false };
  assert.equal(saveAnnotations(storage, 'annotations', keyA, [annotation]), true);
  const loaded = loadAnnotations(storage, 'annotations', keyB);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].quote, '文本');
  assert.equal(loaded[0].kind, 'highlight');
});
