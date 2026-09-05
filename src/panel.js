import { highlightCode, renderMarkdown, sanitizeHtmlPreview } from './markdown-engine.js';
import { mountMarkdownEditor } from './markdown-editor.js';
import { applyAnnotationMarks, findAnnotationPosition, selectionAnchor } from './annotation-engine.js';
import { annotationResourceKey, loadAnnotations, saveAnnotations } from './annotation-store.js';
import { createNotebook, loadNotebookStore, saveNotebookStore } from './notebook-store.js';

const PROTOCOL = 'hana.plugin.ui';
const VERSION = 1;
const SURFACE_SESSION_QUERY = 'pluginSurfaceSession';
const SURFACE_SESSION_HEADER = 'X-Hana-Plugin-Surface-Session';
const PLUGIN_VERSION = '1.4.2';
const MAX_EDIT_BYTES = 512 * 1024;
const MAX_COPILOT_CONTEXT_CHARS = 24000;
const SESSION_STORAGE_KEY = 'hana-reader:last-session:v1';
const LAYOUT_STORAGE_KEY = 'hana-reader:layout:v1';
const NOTEBOOK_STORAGE_KEY = 'hana-reader:notebook:v2';
const LEGACY_NOTEBOOK_STORAGE_KEY = 'hana-reader:notebook:v1';
const ANNOTATION_STORAGE_KEY = 'hana-reader:annotations:v1';
const COPILOT_STORAGE_KEY = 'hana-reader:copilot:v1';

let sequence = 0;
let activeMarkdownEditor = null;
let pendingMarkdownEditor = null;
let editorGeneration = 0;
let autoSaveTimer = null;
let sessionSaveTimer = null;
let activeSelectionViewer = null;
let activeSelectionRect = null;
let suppressEditorRemount = false;
const parentWindow = window.parent;
const targetOrigin = resolveTargetOrigin();

function resolveTargetOrigin() {
  const explicit = new URLSearchParams(window.location.search).get('hana-host-origin');
  if (explicit) return explicit;

  try {
    return window.document.referrer ? new URL(window.document.referrer).origin : '*';
  } catch {
    return '*';
  }
}

function nextId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  sequence += 1;
  return `hana-reader-${Date.now()}-${sequence}`;
}

function post(message) {
  parentWindow.postMessage(message, targetOrigin);
}

function postEvent(type, payload) {
  const message = { protocol: PROTOCOL, version: VERSION, kind: 'event', type };
  if (payload !== undefined) message.payload = payload;
  post(message);
}

function isTrusted(event) {
  return event.source === parentWindow && (targetOrigin === '*' || event.origin === targetOrigin);
}

function request(type, payload, timeoutMs = 10000) {
  const id = nextId();

  return new Promise((resolve, reject) => {
    let timer;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
    };

    const onMessage = (event) => {
      if (!isTrusted(event)) return;
      const message = event.data;
      if (!message || message.protocol !== PROTOCOL || message.version !== VERSION) return;
      if (message.id !== id || message.type !== type) return;

      cleanup();
      if (message.kind === 'error') {
        const error = new Error(message.error?.message || `Host request failed: ${type}`);
        error.code = message.error?.code || 'HOST_ERROR';
        reject(error);
        return;
      }
      resolve(message.payload);
    };

    timer = window.setTimeout(() => {
      cleanup();
      const error = new Error(`Host request timed out: ${type}`);
      error.code = 'TIMEOUT';
      reject(error);
    }, timeoutMs);

    window.addEventListener('message', onMessage);
    const message = { protocol: PROTOCOL, version: VERSION, id, kind: 'request', type };
    if (payload !== undefined) message.payload = payload;
    post(message);
  });
}

function pluginIdFromRoute() {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(window.location.pathname || '');
  if (!match) throw new Error('Unable to resolve the current Hana plugin id.');
  return decodeURIComponent(match[1]);
}

function apiFetch(relativePath, init = {}) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('A relative plugin API path is required.');
  }
  const normalized = relativePath.trim().replace(/^\/+/, '');
  if (normalized.startsWith('api/plugins/') || normalized.includes('..') || normalized.includes('\\')) {
    throw new Error('Only a safe route relative to this plugin is allowed.');
  }

  const pluginId = encodeURIComponent(pluginIdFromRoute());
  const url = new URL(`/api/plugins/${pluginId}/${normalized}`, window.location.origin);
  const surfaceSession = new URLSearchParams(window.location.search).get(SURFACE_SESSION_QUERY);
  if (!surfaceSession) throw new Error('Plugin surface session is missing.');

  const headers = new Headers(init.headers || {});
  headers.set(SURFACE_SESSION_HEADER, surfaceSession);
  return window.fetch(url, { ...init, headers });
}

const hana = {
  ready(payload) {
    postEvent('hana.ready', payload);
  },
  ui: {
    resize(size) {
      postEvent('ui.resize', size);
    },
  },
  host: {
    request,
  },
  resources: {
    pick(input = {}) {
      return request('resource.pick', input);
    },
    requestAccess(input) {
      return request('resource.requestAccess', input);
    },
    open(input) {
      return request('resource.open', input);
    },
  },
  api: {
    fetch: apiFetch,
  },
};

const root = document.getElementById('root');
const state = {
  rootNode: null,
  current: null,
  busy: false,
  restoring: false,
  editing: false,
  leftWidth: 254,
  rightWidth: 288,
  leftCollapsed: false,
  rightCollapsed: false,
  rightView: 'ai',
  notebookText: '',
  notebooks: [],
  activeNotebookId: null,
  notebookDeleteId: null,
  annotations: [],
  annotationKey: '',
  annotationComposer: null,
  annotationUndo: null,
  annotationUndoAt: 0,
  selection: null,
  copilot: {
    messages: [],
    prompt: '',
    busy: false,
    pendingPrompt: '',
    error: '',
    lastRequest: null,
    truncated: null,
  },
  status: '请选择一个文件夹开始阅读',
  error: '',
};

function readLayout() {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}');
    return {
      leftWidth: Math.min(420, Math.max(180, Number(value.leftWidth) || 254)),
      rightWidth: Math.min(420, Math.max(220, Number(value.rightWidth) || 288)),
      leftCollapsed: Boolean(value.leftCollapsed),
      rightCollapsed: Boolean(value.rightCollapsed),
    };
  } catch {
    return {};
  }
}

function saveLayout() {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      leftWidth: state.leftWidth,
      rightWidth: state.rightWidth,
      leftCollapsed: state.leftCollapsed,
      rightCollapsed: state.rightCollapsed,
    }));
  } catch {
    // A restricted storage quota must never break the reader.
  }
}

Object.assign(state, readLayout());

function readNotebookStore() {
  try {
    if (window.localStorage.getItem(NOTEBOOK_STORAGE_KEY)) {
      return loadNotebookStore(window.localStorage, NOTEBOOK_STORAGE_KEY);
    }
    return loadNotebookStore(window.localStorage, LEGACY_NOTEBOOK_STORAGE_KEY);
  } catch {
    return loadNotebookStore(null, NOTEBOOK_STORAGE_KEY);
  }
}

function activeNotebook() {
  return state.notebooks.find((notebook) => notebook.id === state.activeNotebookId) || state.notebooks[0] || null;
}

function syncNotebookText() {
  state.notebookText = activeNotebook()?.text || '';
}

function saveNotebook() {
  const note = activeNotebook();
  if (note) {
    note.text = state.notebookText;
    note.updatedAt = Date.now();
  }
  saveNotebookStore(window.localStorage, NOTEBOOK_STORAGE_KEY, {
    activeId: state.activeNotebookId,
    notebooks: state.notebooks,
  });
}

function readCopilotHistory(resourceKey) {
  if (!resourceKey) return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(COPILOT_STORAGE_KEY) || '{}');
    const messages = value?.[resourceKey];
    return Array.isArray(messages)
      ? messages.filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string').slice(-24)
      : [];
  } catch {
    return [];
  }
}

function saveCopilotHistory(resourceKey) {
  if (!resourceKey) return;
  try {
    const value = JSON.parse(window.localStorage.getItem(COPILOT_STORAGE_KEY) || '{}');
    value[resourceKey] = state.copilot.messages.slice(-24);
    window.localStorage.setItem(COPILOT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Local history is an enhancement; quota failures must not break reading.
  }
}

function saveAnnotationsForCurrent() {
  if (!state.annotationKey) return;
  saveAnnotations(window.localStorage, ANNOTATION_STORAGE_KEY, state.annotationKey, state.annotations);
}

const notebookStore = readNotebookStore();
state.notebooks = notebookStore.notebooks?.length ? notebookStore.notebooks : [createNotebook()];
state.activeNotebookId = notebookStore.activeId || state.notebooks[0]?.id || null;
syncNotebookText();

function readSavedSession() {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !value.rootResource || typeof value.rootResource.kind !== 'string') {
      return null;
    }
    return {
      rootResource: value.rootResource,
      rootName: typeof value.rootName === 'string' ? value.rootName : resourceName(value.rootResource),
      currentPath: Array.isArray(value.currentPath) ? value.currentPath.filter((item) => typeof item === 'string') : [],
      scrollTop: Number.isFinite(Number(value.scrollTop)) ? Math.max(0, Number(value.scrollTop)) : 0,
    };
  } catch {
    return null;
  }
}

function scheduleSessionSave() {
  if (sessionSaveTimer || !state.rootNode?.resource) return;
  sessionSaveTimer = window.setTimeout(() => {
    sessionSaveTimer = null;
    saveSession();
  }, 180);
}

function saveSession() {
  if (!state.rootNode?.resource) return;
  const snapshot = {
    version: 1,
    rootResource: state.rootNode.resource,
    rootName: state.rootNode.name,
    currentPath: state.current?.node?.relativePath || [],
    scrollTop: state.current?.scrollTop || 0,
  };
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // A restricted or full storage quota must never break the reader.
  }
}

function nodePath(node) {
  return Array.isArray(node?.relativePath) ? node.relativePath : [];
}

let nodeSequence = 0;

function nextNodeId() {
  nodeSequence += 1;
  return `node-${nodeSequence}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function resourceName(resource) {
  if (resource?.displayName) return resource.displayName;
  const value = resource?.path || resource?.url || resource?.fileId || '所选文件夹';
  return String(value).split(/[\\/]/).filter(Boolean).pop() || String(value);
}

function childResource(parent, name) {
  if (!parent || typeof parent !== 'object') return null;

  if (parent.kind === 'local-file') {
    const base = String(parent.path || '').replace(/[\\/]+$/, '');
    const separator = String(parent.path || '').includes('\\') ? '\\' : '/';
    return { ...parent, path: base ? `${base}${separator}${name}` : name };
  }

  if (parent.kind === 'mount') {
    const base = String(parent.path || '').replace(/\/+$/, '');
    return { ...parent, path: base ? `${base}/${name}` : `/${name}` };
  }

  // Generic ResourceRef providers may use identities that are not path-based.
  // They will get a provider-specific resolver in a later milestone.
  return null;
}

function makeNode({ resource, name, isDirectory, size = null, mtimeMs = null, relativePath = [] }) {
  return {
    id: nextNodeId(),
    resource,
    name,
    isDirectory,
    size,
    mtimeMs,
    relativePath,
    items: [],
    loaded: false,
    expanded: false,
    unsupported: !resource,
  };
}

function byteLength(value) {
  try {
    return new TextEncoder().encode(String(value || '')).byteLength;
  } catch {
    return String(value || '').length;
  }
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持安全写回校验。');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function formatSize(size) {
  if (size === null || size === undefined || Number.isNaN(Number(size))) return '';
  const value = Number(size);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function inferLanguage(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.c') || lower.endsWith('.h') || lower.endsWith('.cpp') || lower.endsWith('.hpp')) return 'cpp';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.xml') || lower.endsWith('.svg')) return 'xml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'shell';
  return 'text';
}

function languageLabel(language) {
  const labels = {
    markdown: 'Markdown',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    json: 'JSON',
    html: 'HTML',
    css: 'CSS',
    java: 'Java',
    cpp: 'C/C++',
    rust: 'Rust',
    go: 'Go',
    yaml: 'YAML',
    xml: 'XML',
    shell: 'Shell',
    text: '文本',
  };
  return labels[language] || '文本';
}

async function apiJson(path, body) {
  const response = await hana.api.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`插件路由返回了无法读取的响应（${response.status}）`);
  }

  if (!response.ok) {
    const error = new Error(payload?.error || `资源请求失败（${response.status}）`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function destroyMarkdownEditor() {
  editorGeneration += 1;
  const active = activeMarkdownEditor;
  activeMarkdownEditor = null;
  if (active) await active.destroy();
  const pending = pendingMarkdownEditor;
  if (pending) {
    try {
      const editor = await pending;
      if (editor) await editor.destroy();
    } catch {
      // The caller that started the mount reports initialization failures.
    }
  }
}

function currentDraft() {
  if (!state.current) return '';
  return state.current.draftContent ?? state.current.content;
}

function updateFooterStatus() {
  // The reader no longer reserves a bottom status row; transient state stays in controls.
}

function updateEditorStatus() {
  const status = root.querySelector('#editor-status');
  if (!status || !state.current) return;
  if (state.current.conflict) {
    status.textContent = '检测到外部修改 · 选择载入或覆盖';
  } else if (state.current.saveFailed) {
    status.textContent = '自动保存失败 · 可重试或放弃草稿';
  } else if (state.current.conflict) {
    status.textContent = '检测到外部修改 · 尚未写回';
  } else if (state.current.draftDirty) {
    status.textContent = '本地草稿 · 尚未写回';
  } else {
    status.textContent = '编辑中 · 未修改';
  }
  root.querySelectorAll('[data-action="retry-save"], [data-action="discard-draft"]').forEach((button) => {
    button.hidden = !state.current.saveFailed || (state.current.conflict && button.dataset.action === 'retry-save');
  });
}

function restoreEditorScroll() {
  const scroll = root.querySelector('.editor-scroll');
  if (scroll && state.current) scroll.scrollTop = state.current.scrollTop || 0;
}

async function mountCurrentEditor() {
  if (!state.current || !state.editing) return;
  updateEditorStatus();
  if (state.current.language === 'markdown') {
    const generation = ++editorGeneration;
    const session = state.current;
    const promise = mountMarkdownEditor(root.querySelector('#markdown-editor'), currentDraft(), {
      onMarkdownChange(markdown) {
        if (generation !== editorGeneration || state.current !== session || !state.editing) return;
        state.current.draftContent = markdown;
        state.current.draftDirty = markdown !== state.current.content;
        state.current.saveFailed = false;
        updateEditorStatus();
        scheduleAutoSave();
      },
    });
    pendingMarkdownEditor = promise;
    try {
      const editor = await promise;
      if (generation !== editorGeneration || state.current !== session || !state.editing) return;
      activeMarkdownEditor = editor;
      restoreEditorScroll();
    } finally {
      if (pendingMarkdownEditor === promise) pendingMarkdownEditor = null;
    }
    return;
  }

  const textarea = root.querySelector('#source-editor');
  if (!textarea) return;
  textarea.value = currentDraft();
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.setRangeText('  ', start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  restoreEditorScroll();
  textarea.addEventListener('input', () => {
    if (!state.current || !state.editing) return;
    state.current.draftContent = textarea.value;
    state.current.draftDirty = textarea.value !== state.current.content;
    state.current.saveFailed = false;
    updateEditorStatus();
    scheduleAutoSave();
  });
}

async function chooseFolder() {
  if (state.busy || state.restoring) return;
  await destroyMarkdownEditor();
  state.editing = false;
  state.error = '';
  state.status = '等待选择文件夹…';
  render();

  try {
    const result = await hana.resources.pick({
      mode: 'directory',
      multiple: false,
      capability: 'resource.read',
    });
    const resource = result?.resources?.[0];
    if (!resource) {
      state.status = '未选择文件夹';
      render();
      return;
    }

    state.rootNode = makeNode({
      resource,
      name: resourceName(resource),
      isDirectory: true,
      relativePath: [],
    });
    state.rootNode.expanded = true;
    state.current = null;
    state.annotations = [];
    state.annotationKey = '';
    state.selection = null;
    state.annotationUndo = null;
    state.annotationUndoAt = 0;
    saveSession();
    await loadDirectory(state.rootNode);
    saveSession();
  } catch (error) {
    state.busy = false;
    state.error = error instanceof Error ? error.message : String(error);
    state.status = '选择文件夹失败';
    render();
  }
}

async function loadDirectory(node) {
  if (!node?.resource || state.busy) return;
  state.busy = true;
  state.error = '';
  state.status = `正在读取 ${node.name}…`;
  render();

  try {
    const result = await apiJson('resources/list', { resource: node.resource });
    node.items = (result.items || []).map((item) => makeNode({
      resource: childResource(node.resource, item.name),
      name: item.name,
      isDirectory: Boolean(item.isDirectory),
      size: item.size,
      mtimeMs: item.mtimeMs,
      relativePath: [...nodePath(node), item.name],
    }));
    node.loaded = true;
    node.expanded = true;
    state.status = `${node.items.length} 项 · ${node.name}`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = `无法读取 ${node.name}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function openFile(node, options = {}) {
  if (!node?.resource || node.isDirectory || state.busy) return;
  if (state.current?.node?.id === node.id) {
    state.status = `${languageLabel(state.current.language)} · 当前文件已打开`;
    updateFooterStatus();
    return;
  }
  await destroyMarkdownEditor();
  state.editing = false;
  state.busy = true;
  state.error = '';
  state.status = `正在打开 ${node.name}…`;
  render();

  try {
    const result = await apiJson('resources/read', { resource: node.resource });
    const language = inferLanguage(node.name);
    const annotationKey = annotationResourceKey(node.resource);
    state.current = {
      node,
      name: node.name,
      language,
      binary: Boolean(result.binary),
      content: result.content || '',
      version: result.version || null,
      editable: language === 'markdown' && byteLength(result.content || '') <= MAX_EDIT_BYTES,
      baseSha256: await sha256Text(result.content || ''),
      htmlPreview: false,
      scrollTop: Number.isFinite(Number(options.scrollTop)) ? Math.max(0, Number(options.scrollTop)) : 0,
      annotationKey,
      annotations: language === 'markdown'
        ? loadAnnotations(window.localStorage, ANNOTATION_STORAGE_KEY, annotationKey).filter((annotation) => annotation.kind !== 'comment')
        : [],
      undoAt: 0,
      saveFailed: false,
    };
    state.annotationKey = annotationKey;
    state.annotations = state.current.annotations;
    state.selection = null;
    state.annotationComposer = null;
    state.annotationUndo = null;
    state.annotationUndoAt = 0;
    state.copilot = {
      ...state.copilot,
      messages: readCopilotHistory(annotationKey),
      prompt: '',
      error: '',
      lastRequest: null,
      pendingPrompt: '',
      truncated: null,
    };
    saveSession();
    state.status = `${languageLabel(state.current.language)} · 只读`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = `无法打开 ${node.name}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function openFolderInExplorer() {
  if (!state.rootNode?.resource || state.busy) return;
  state.busy = true;
  state.error = '';
  state.status = '正在打开本地文件资源管理器…';
  render();
  try {
    await hana.resources.open({ resource: state.rootNode.resource, mode: 'reveal' });
    state.status = '已在本地文件资源管理器中打开当前目录';
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = '无法打开本地文件资源管理器';
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshRoot() {
  if (!state.rootNode || state.busy) return;
  await destroyMarkdownEditor();
  state.editing = false;
  state.current = null;
  state.annotations = [];
  state.annotationKey = '';
  state.selection = null;
  state.annotationUndo = null;
  state.annotationUndoAt = 0;
  state.rootNode.items = [];
  state.rootNode.loaded = false;
  await loadDirectory(state.rootNode);
  saveSession();
}

async function restoreSession() {
  const saved = readSavedSession();
  if (!saved || state.rootNode || state.restoring) return;

  state.restoring = true;
  state.error = '';
  state.status = '正在恢复上次工作区…';
  render();

  try {
    state.rootNode = makeNode({
      resource: saved.rootResource,
      name: saved.rootName,
      isDirectory: true,
      relativePath: [],
    });
    state.rootNode.expanded = true;
    await loadDirectory(state.rootNode);
    if (!state.rootNode.loaded) {
      throw new Error(state.error || '上次文件夹无法读取');
    }

    let node = state.rootNode;
    for (const [index, segment] of saved.currentPath.entries()) {
      const child = node.items.find((item) => item.name === segment);
      if (!child) {
        state.status = `已恢复文件夹，未找到上次文件：${saved.currentPath.join('/')}`;
        state.restoring = false;
        render();
        return;
      }

      if (child.unsupported) {
        state.status = `已恢复文件夹，但暂不支持恢复此资源：${saved.currentPath.join('/')}`;
        state.restoring = false;
        render();
        return;
      }

      if (index === saved.currentPath.length - 1) {
        if (child.isDirectory) break;
        await openFile(child, { scrollTop: saved.scrollTop });
        if (!state.current) return;
        state.status = `${languageLabel(state.current.language)} · 已恢复上次位置`;
        state.restoring = false;
        render();
        return;
      }

      if (!child.isDirectory) break;
      child.expanded = true;
      await loadDirectory(child);
      if (!child.loaded) {
        throw new Error(state.error || `无法读取目录：${child.name}`);
      }
      node = child;
    }

    state.status = '已恢复上次文件夹，请选择文件';
  } catch (error) {
    state.rootNode = null;
    state.current = null;
    state.error = `无法恢复上次工作区：${error instanceof Error ? error.message : String(error)}`;
    state.status = '请选择文件夹重新开始';
  } finally {
    state.restoring = false;
    render();
  }
}

function toggleDirectory(node) {
  if (!node || !node.isDirectory || node.unsupported) return;
  if (!node.loaded) {
    loadDirectory(node);
    return;
  }
  node.expanded = !node.expanded;
  render();
}

function renderTreeNode(node, depth) {
  const selected = state.current?.node?.id === node.id;
  const directory = node.isDirectory;
  const action = directory ? 'toggle' : 'open';
  const iconType = directory ? `folder ${node.expanded ? 'open' : 'closed'}` : fileIconType(node.name);
  const disabled = node.unsupported ? ' disabled' : '';
  const nested = directory && node.expanded
    ? `<div class="tree-nested" style="--nested-depth:${depth}">${node.items.length
      ? node.items.map((child) => renderTreeNode(child, depth + 1)).join('')
      : '<div class="tree-empty">空文件夹</div>'}</div>`
    : '';

  return `<button class="tree-row ${directory ? 'directory' : ''} ${selected ? 'selected' : ''}${disabled}" data-action="${action}" data-node-id="${node.id}" data-depth="${depth}" style="--depth:${depth}" title="${escapeHtml(node.name)}" role="treeitem" aria-expanded="${directory ? String(Boolean(node.expanded)) : 'false'}"${selected ? ' aria-current="page"' : ''}>
    <span class="tree-icon ${iconType}" aria-hidden="true">${treeIconSvg(directory, node.expanded, iconType)}</span>
    <span class="tree-name">${escapeHtml(node.name)}</span>
    <span class="tree-size">${node.isDirectory ? '' : escapeHtml(formatSize(node.size))}</span>
  </button>${nested}`;
}

function fileIconType(name) {
  const lower = String(name || '').toLowerCase();
  const extension = lower.split('.').pop();
  if (/^readme(?:\.|$)/.test(lower)) return 'readme';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(extension)) return 'archive';
  if (['markdown', 'md', 'mdx'].includes(extension)) return 'markdown';
  if (['json', 'jsonc'].includes(extension)) return 'json';
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'rs', 'go'].includes(extension)) return 'code';
  if (['css', 'scss', 'less'].includes(extension)) return 'style';
  if (['html', 'htm', 'xml', 'svg'].includes(extension)) return 'markup';
  return 'file';
}

function treeIconSvg(directory, expanded, iconType = 'file') {
  if (directory) {
    return expanded
      ? '<svg viewBox="0 0 24 24" focusable="false"><path d="M3.2 7.6h6.1l1.8 2h9.7l-2.1 9.1a1.2 1.2 0 0 1-1.2.9H4.7a1.2 1.2 0 0 1-1.2-1.2l-.3-10.8Z"/><path d="M3.4 9.6h17.4"/></svg>'
      : '<svg viewBox="0 0 24 24" focusable="false"><path d="M3.5 6.3h6.2l1.7 2h9.1v10.2a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V6.3Z"/><path d="M3.5 9h17"/></svg>';
  }
  const badge = { readme: 'R', markdown: 'M', json: '{}', archive: 'ZIP', code: '</>', style: '#', markup: '<>', file: '' }[iconType] || '';
  return `<svg viewBox="0 0 24 24" focusable="false"><path d="M6 3.5h8l4 4v13H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5Z"/><path d="M14 3.5v4h4"/>${badge ? `<text x="12" y="15.5" text-anchor="middle">${badge}</text>` : ''}</svg>`;
}

function renderTree() {
  if (!state.rootNode) {
    return `<div class="tree-placeholder">
      <div class="placeholder-icon">⌁</div>
      <p>选择一个文件夹</p>
      <small>从项目根目录开始阅读</small>
    </div>`;
  }

  const tree = renderTreeNode(state.rootNode, 0);
  return `<div class="tree-content" role="tree" aria-label="项目文件树">${tree}</div>`;
}

function renderCodeViewer(content, language) {
  return `<div class="code-viewer" data-language="${escapeHtml(language)}">${String(content || '').replace(/\r\n?/g, '\n').split('\n').map((line, index) => {
    const lineNumber = index + 1;
    return `<div class="code-line" data-line="${lineNumber}"><span class="line-number">${lineNumber}</span><code>${highlightCode(line, language)}</code></div>`;
  }).join('')}</div>`;
}

async function startEditing() {
  if (!state.current || state.current.binary || state.editing || state.busy) return;
  const readScrollTop = root.querySelector('.viewer-scroll')?.scrollTop;
  if (Number.isFinite(readScrollTop)) state.current.scrollTop = readScrollTop;
  state.editing = true;
  state.current.draftContent = state.current.content;
  state.current.draftDirty = false;
  state.current.saveFailed = false;
  state.current.conflict = null;
  render();

  try {
    await mountCurrentEditor();
  } catch (error) {
    activeMarkdownEditor = null;
    state.editing = false;
    state.error = `编辑器加载失败：${error instanceof Error ? error.message : String(error)}`;
    render();
  }
}

let pendingTransition = null;

function scheduleAutoSave() {
  window.clearTimeout(autoSaveTimer);
  if (!state.current?.draftDirty || !state.editing || state.current.saveFailed) return;
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = null;
    saveCurrent({ preserveEditor: true });
  }, 500);
}

async function flushAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (state.editing && state.current?.draftDirty && !state.current.saveFailed) {
    await saveCurrent({ preserveEditor: true });
  }
}

function requestTransition(_label, transition) {
  const runTransition = async () => {
    if (state.editing) {
      await flushAutoSave();
      if (state.current?.draftDirty || state.busy) return;
      await destroyMarkdownEditor();
      state.editing = false;
    }
    await transition();
  };
  pendingTransition = runTransition;
  runTransition().finally(() => {
    if (pendingTransition === runTransition) pendingTransition = null;
  });
}

async function stopEditing() {
  await flushAutoSave();
  if (state.current?.draftDirty || state.busy) return;
  await destroyMarkdownEditor();
  state.editing = false;
  if (state.current) {
    delete state.current.draftContent;
    delete state.current.draftDirty;
    delete state.current.conflict;
  }
  render();
}

async function saveCurrent({ preserveEditor = false } = {}) {
  if (!state.current || state.busy || !state.current.draftDirty) return;
  const current = state.current;
  let saved = false;
  current.saveFailed = false;
  state.busy = true;
  state.error = '';
  state.status = `正在自动保存 ${state.current.name}…`;
  if (preserveEditor) updateFooterStatus();
  if (!preserveEditor) render();
  try {
    const draft = currentDraft();
    let result;
    try {
      result = await apiJson('resources/write', {
        resource: current.node.resource,
        content: draft,
        expectedVersion: current.version,
        baseSha256: current.baseSha256,
      });
    } catch (error) {
      // A remote change is never overwritten implicitly. The outer handler stores the
      // latest baseline and exposes explicit reload/overwrite actions in the editor.
      throw error;
    }
    current.undo = { content: current.content, version: result.version };
    current.undoAt = Date.now();
    current.content = draft;
    current.draftContent = draft;
    current.draftDirty = false;
    current.conflict = null;
    current.version = result.version || current.version;
    current.baseSha256 = result.sha256 || await sha256Text(current.content);
    current.saveFailed = false;
    saved = true;
    state.status = `${languageLabel(current.language)} · 已自动保存`;
  } catch (error) {
    current.saveFailed = true;
    if (error.status === 409 && error.payload?.conflict && error.payload.version) {
      current.conflict = {
        version: error.payload.version,
        sha256: error.payload.sha256 || '',
        content: typeof error.payload.content === 'string' ? error.payload.content : null,
      };
      state.error = '远端文件已发生变化，草稿未覆盖远端内容。';
      state.status = '检测到外部修改 · 请载入远端或确认覆盖';
    } else {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = '自动保存失败，请重试';
    }
  } finally {
    state.busy = false;
    updateEditorStatus();
    updateFooterStatus();
    if (preserveEditor && current.saveFailed) render();
    if (!preserveEditor) {
      await destroyMarkdownEditor();
      suppressEditorRemount = true;
      render();
      await mountCurrentEditor();
    } else if (state.current?.draftDirty && !state.current.saveFailed && saved) {
      scheduleAutoSave();
    }
  }
}

function retrySaveCurrent() {
  if (!state.current?.draftDirty || state.busy) return;
  state.current.saveFailed = false;
  state.error = '';
  updateEditorStatus();
  updateFooterStatus();
  saveCurrent({ preserveEditor: true });
}

function overwriteConflict() {
  const current = state.current;
  const conflict = current?.conflict;
  if (!current?.draftDirty || !conflict?.version || !conflict.sha256 || state.busy) return;
  current.version = conflict.version;
  current.baseSha256 = conflict.sha256;
  current.conflict = null;
  current.saveFailed = false;
  state.error = '';
  state.status = '正在确认覆盖远端修改…';
  updateEditorStatus();
  updateFooterStatus();
  void saveCurrent({ preserveEditor: true });
}

async function reloadConflict() {
  const current = state.current;
  const conflict = current?.conflict;
  if (!current || !conflict || state.busy) return;
  if (typeof conflict.content !== 'string') {
    state.error = '远端版本无法作为文本载入，已保留本地草稿。';
    render();
    return;
  }
  await destroyMarkdownEditor();
  state.editing = false;
  current.content = conflict.content;
  current.version = conflict.version;
  current.baseSha256 = conflict.sha256 || await sha256Text(conflict.content);
  current.undo = null;
  current.undoAt = 0;
  current.conflict = null;
  current.saveFailed = false;
  state.error = '';
  state.status = '已载入远端版本，本地草稿已放弃';
  delete current.draftContent;
  delete current.draftDirty;
  render();
}

async function discardDraft() {
  if (!state.current || state.busy) return;
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  await destroyMarkdownEditor();
  state.current.draftContent = state.current.content;
  state.current.draftDirty = false;
  state.current.saveFailed = false;
  state.current.conflict = null;
  state.error = '';
  state.status = `${languageLabel(state.current.language)} · 已放弃本地草稿`;
  state.editing = false;
  delete state.current.draftContent;
  delete state.current.draftDirty;
  delete state.current.saveFailed;
  delete state.current.conflict;
  render();
}

async function undoLastWrite() {
  const current = state.current;
  if (!current?.undo || state.busy) return;
  state.busy = true;
  state.error = '';
  state.status = `正在撤销 ${current.name}…`;
  render();
  try {
    const result = await apiJson('resources/write', {
      resource: current.node.resource,
      content: current.undo.content,
      expectedVersion: current.version,
      baseSha256: current.baseSha256,
    });
    current.content = current.undo.content;
    current.draftContent = current.content;
    current.draftDirty = false;
    current.version = result.version || current.version;
    current.baseSha256 = result.sha256 || await sha256Text(current.content);
    current.undo = null;
    current.undoAt = 0;
    current.conflict = null;
    state.status = `${languageLabel(current.language)} · 已撤销上次写回`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = error.status === 409 ? '撤销遇到外部修改，未覆盖远端内容' : '撤销失败';
  } finally {
    state.busy = false;
    await destroyMarkdownEditor();
    render();
    await mountCurrentEditor();
  }
}

function clipContext(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  const head = Math.max(1, Math.floor(limit * 0.82));
  const tail = Math.max(0, limit - head);
  return `${text.slice(0, head)}\n\n[…已截断…]\n\n${tail ? text.slice(-tail) : ''}`;
}

function recordAnnotationUndo() {
  state.annotationUndo = state.annotations.map((annotation) => ({
    ...annotation,
    replies: (annotation.replies || []).map((reply) => ({ ...reply })),
  }));
  state.annotationUndoAt = Date.now();
}

function undoAnnotationChange() {
  if (!state.annotationUndo) return;
  state.annotations = state.annotationUndo;
  state.annotationUndo = null;
  state.annotationUndoAt = 0;
  if (state.current) state.current.annotations = state.annotations;
  saveAnnotationsForCurrent();
  state.status = '已撤销上次批注操作';
  render();
}

function annotationId() {
  return globalThis.crypto?.randomUUID?.() || `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function removeSelectionOverlay() {
  root.querySelector('.selection-toolbar')?.remove();
  root.querySelector('.annotation-composer-popover')?.remove();
}

function placeSelectionOverlay(viewer, element, rect) {
  if (!viewer || !element || !rect) return;
  const viewerRect = viewer.getBoundingClientRect();
  const width = element.offsetWidth || 220;
  const maxLeft = Math.max(8, viewer.clientWidth - width - 8);
  const left = Math.min(maxLeft, Math.max(8, rect.left - viewerRect.left + viewer.scrollLeft));
  const top = Math.max(8, rect.bottom - viewerRect.top + viewer.scrollTop + 8);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function currentSelectionRect() {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  return selection.getRangeAt(0).getBoundingClientRect();
}

function createSelectionToolbar(viewer, rect = currentSelectionRect()) {
  removeSelectionOverlay();
  if (!viewer || !rect) return;
  const toolbar = document.createElement('div');
  toolbar.className = 'selection-toolbar';
  toolbar.innerHTML = '<button type="button" data-annotation-action="highlight">高亮</button><button type="button" data-annotation-action="underline">下划线</button><button type="button" data-annotation-action="erase">擦除</button>';
  toolbar.addEventListener('mousedown', (event) => event.preventDefault());
  toolbar.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.annotationAction;
    if (action) beginAnnotation(action);
  });
  viewer.append(toolbar);
  placeSelectionOverlay(viewer, toolbar, rect);
}

function showAnnotationComposer(viewer) {
  removeSelectionOverlay();
  const rect = activeSelectionRect || currentSelectionRect();
  if (!viewer || !rect) return;
  const composer = document.createElement('div');
  composer.className = 'annotation-composer-popover';
  const quote = state.annotationComposer?.selection?.quote || state.selection?.quote || '';
  composer.innerHTML = `<div class="annotation-composer-head"><strong>添加批注</strong><button type="button" data-annotation-composer-action="cancel" aria-label="取消批注">×</button></div><div class="annotation-composer-quote">“${escapeHtml(quote.slice(0, 120))}${quote.length > 120 ? '…' : ''}”</div><textarea data-annotation-composer aria-label="批注内容" placeholder="写下你的理解、疑问或修改理由……"></textarea><div class="annotation-composer-actions"><button type="button" class="button ghost tiny" data-annotation-composer-action="cancel">取消</button><button type="button" class="button primary tiny" data-annotation-composer-action="save">保存批注</button></div>`;
  composer.addEventListener('mousedown', (event) => event.preventDefault());
  composer.addEventListener('click', (event) => {
    const action = event.target.closest('[data-annotation-composer-action]')?.dataset.annotationComposerAction;
    if (action === 'save') saveAnnotationComposer();
    if (action === 'cancel') cancelAnnotationComposer();
  });
  const input = composer.querySelector('[data-annotation-composer]');
  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (input.value.trim()) saveAnnotationComposer();
    else cancelAnnotationComposer();
  });
  viewer.append(composer);
  placeSelectionOverlay(viewer, composer, rect);
  input?.focus();
}

function showAnnotationBubble(mark) {
  const viewer = mark?.closest('.viewer-scroll');
  const annotation = state.annotations.find((item) => item.id === mark?.dataset.annotationId);
  if (!viewer || !annotation || annotation.kind !== 'comment') return;
  viewer.querySelector('.annotation-bubble')?.remove();
  const bubble = document.createElement('div');
  bubble.className = 'annotation-bubble';
  bubble.innerHTML = `<span class="annotation-bubble-line" aria-hidden="true"></span><div>${escapeHtml(annotation.note || '批注')}</div>`;
  const markRect = mark.getBoundingClientRect();
  viewer.append(bubble);
  const viewerRect = viewer.getBoundingClientRect();
  const left = Math.min(Math.max(12, markRect.left - viewerRect.left + viewer.scrollLeft), Math.max(12, viewer.clientWidth - 260));
  const top = Math.max(12, markRect.bottom - viewerRect.top + viewer.scrollTop + 10);
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

function hideAnnotationBubble() {
  root.querySelector('.annotation-bubble')?.remove();
}

function beginAnnotation(kind) {
  if (!state.current || state.current.language !== 'markdown' || !state.selection?.quote) {
    state.error = '请先在 Markdown 正文中选中文本。';
    render();
    return;
  }
  if (kind === 'erase') {
    eraseAnnotationsInSelection();
    return;
  }
  if (kind === 'highlight' || kind === 'underline') {
    recordAnnotationUndo();
    const annotation = makeAnnotation(kind, '');
    state.annotations.push(annotation);
    state.current.annotations = state.annotations;
    saveAnnotationsForCurrent();
    state.selection = null;
    activeSelectionRect = null;
    removeSelectionOverlay();
    state.status = kind === 'highlight' ? '已添加高亮' : '已添加下划线';    render();
    return;
  }
  state.annotationComposer = { kind: 'comment', selection: { ...state.selection } };
  showAnnotationComposer(activeSelectionViewer);
}

function eraseAnnotationsInSelection() {
  const article = activeSelectionViewer?.querySelector('.markdown-body');
  const selection = state.selection;
  if (!article || !selection) return;
  const next = state.annotations.filter((annotation) => {
    const position = findAnnotationPosition(article, annotation);
    return !position || position.end <= selection.start || position.start >= selection.end;
  });
  if (next.length === state.annotations.length) {
    state.status = '选区内没有可擦除的批注或标记';
  } else {
    recordAnnotationUndo();
    state.annotations = next;
    state.current.annotations = next;
    saveAnnotationsForCurrent();
    state.status = '已擦除选区内的批注和标记';
  }
  state.selection = null;
  activeSelectionRect = null;
  removeSelectionOverlay();
  render();
}

function cancelAnnotationComposer() {
  state.annotationComposer = null;
  state.selection = null;
  activeSelectionRect = null;
  removeSelectionOverlay();
  hideAnnotationBubble();
  render();
}

function makeAnnotation(kind, note) {
  const selection = state.annotationComposer?.selection || state.selection;
  const now = Date.now();
  return {
    id: annotationId(),
    kind,
    quote: selection.quote,
    prefix: selection.prefix || '',
    suffix: selection.suffix || '',
    note: String(note || '').slice(0, 4000),
    replies: [],
    resolved: false,
    createdAt: now,
    updatedAt: now,
  };
}

function saveAnnotationComposer() {
  if (!state.annotationComposer) return;
  const input = root.querySelector('[data-annotation-composer]');
  const note = input?.value?.trim() || '';
  if (!note) {
    cancelAnnotationComposer();
    return;
  }
  recordAnnotationUndo();
  const annotation = makeAnnotation('comment', note);
  state.annotations.push(annotation);
  state.current.annotations = state.annotations;
  saveAnnotationsForCurrent();
  state.annotationComposer = null;
  state.selection = null;
  activeSelectionRect = null;
  removeSelectionOverlay();
  state.status = '已添加批注';
  render();
}

function focusAnnotation(id) {
  const mark = [...root.querySelectorAll('[data-annotation-id]')].find((element) => element.dataset.annotationId === id);
  if (!mark) return;
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  mark.classList.add('is-focused');
  showAnnotationBubble(mark);
  window.setTimeout(() => mark.classList.remove('is-focused'), 1200);
}

function selectNotebook(id) {
  if (!state.notebooks.some((notebook) => notebook.id === id)) return;
  state.activeNotebookId = id;
  state.notebookDeleteId = null;
  syncNotebookText();  saveNotebook();
  render();
}

function createNotebookAction() {
  const notebook = createNotebook(`笔记 ${state.notebooks.length + 1}`);
  state.notebooks.push(notebook);
  state.activeNotebookId = notebook.id;
  state.notebookDeleteId = null;
  state.notebookText = '';
  saveNotebook();
  render();
}

function requestNotebookDelete(id) {
  if (!state.notebooks.some((item) => item.id === id)) return;
  state.notebookDeleteId = id;
  render();
}

function deleteNotebook(id) {
  const notebook = state.notebooks.find((item) => item.id === id);
  if (!notebook) return;
  state.notebookDeleteId = null;
  state.notebooks = state.notebooks.filter((item) => item.id !== id);
  if (!state.notebooks.length) state.notebooks = [createNotebook()];
  if (state.activeNotebookId === id) {
    state.activeNotebookId = state.notebooks[0]?.id || null;
    state.notebookText = '';
  }
  syncNotebookText();
  saveNotebook();
  state.status = `已删除笔记本“${notebook.title}”`;
  render();
}

function updateNotebookTitle() {
  const notebook = activeNotebook();
  const input = root.querySelector('[data-notebook-title]');
  if (!notebook || !input) return;
  notebook.title = input.value.trim().slice(0, 80) || '未命名笔记';
  notebook.updatedAt = Date.now();
  saveNotebook();
}

async function exportNotebookToResource() {
  const notebook = activeNotebook();
  if (!notebook || state.busy) return;
  state.busy = true;
  state.status = '选择要覆盖的 Markdown 文件…';
  render();
  try {
    const picked = await hana.resources.pick({
      mode: 'file',
      multiple: false,
      capability: 'resource.write',
    });
    const resource = picked?.resources?.[0];
    if (!resource) {
      state.status = '未选择导出文件';
      return;
    }
    const latest = await apiJson('resources/read', { resource });
    if (latest.binary || typeof latest.content !== 'string') {
      throw new Error('导出目标必须是已有的文本文件。');
    }
    await apiJson('resources/write', {
      resource,
      content: notebook.text || '',
      expectedVersion: latest.version,
      baseSha256: await sha256Text(latest.content),
    });
    state.status = `已导出 Notebook 到 ${resource.name || '目标文件'}`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = 'Notebook 导出失败';
  } finally {
    state.busy = false;
    render();
  }
}

function buildCopilotRequest(promptOverride = '') {
  const prompt = String(promptOverride || state.copilot.prompt || '').trim();
  const file = state.current && !state.current.binary
    ? { name: state.current.name, language: state.current.language, content: clipContext(state.current.content, MAX_COPILOT_CONTEXT_CHARS) }
    : null;
  return {
    prompt,
    file,
    history: state.copilot.messages.slice(-12).map((message) => ({ role: message.role, content: message.content })),
  };
}

async function askCopilot(promptOverride = '', preset = null) {
  const request = preset || buildCopilotRequest(promptOverride);
  if (!request.prompt) {
    state.copilot.error = '请先输入问题，或点击一个快捷任务。';
    render();
    return;
  }
  if (!request.file) {
    state.copilot.error = '请先打开一个文本文件。';
    render();
    return;
  }
  state.copilot.busy = true;
  state.copilot.error = '';
  state.copilot.pendingPrompt = request.prompt;
  state.copilot.lastRequest = request;
  state.copilot.prompt = '';
  render();
  try {
    const result = await apiJson('copilot/ask', request);
    state.copilot.messages.push(
      { id: annotationId(), role: 'user', content: request.prompt },
      { id: annotationId(), role: 'assistant', content: result.text, truncated: result.truncated },
    );
    state.copilot.truncated = result.truncated || null;
    saveCopilotHistory(state.annotationKey);
  } catch (error) {
    state.copilot.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.copilot.busy = false;
    state.copilot.pendingPrompt = '';
    render();
  }
}

function retryCopilot() {
  if (state.copilot.lastRequest && !state.copilot.busy) askCopilot('', state.copilot.lastRequest);
}

function clearViewerSelection(viewer) {
  if (viewer && activeSelectionViewer !== viewer) return;
  state.selection = null;
  activeSelectionRect = null;
  state.annotationComposer = null;
  removeSelectionOverlay();
  hideAnnotationBubble();
}

function captureViewerSelection(viewer) {
  const article = viewer?.querySelector('.markdown-body');
  const selection = window.getSelection?.();
  if (!article || !selection || selection.isCollapsed || !selection.rangeCount) {
    clearViewerSelection(viewer);
    return;
  }
  if (!article.contains(selection.anchorNode) || !article.contains(selection.focusNode)) {
    clearViewerSelection(viewer);
    return;
  }
  const anchor = selectionAnchor(article, selection);
  if (!anchor) {
    clearViewerSelection(viewer);
    return;
  }
  state.selection = anchor;
  activeSelectionViewer = viewer;
  const rect = currentSelectionRect();
  if (!rect) {
    clearViewerSelection(viewer);
    return;
  }
  activeSelectionRect = {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  };
  createSelectionToolbar(viewer, activeSelectionRect);
}

function renderReaderPane() {
  if (!state.current) {
    return `<div class="welcome-pane">
      <div class="welcome-mark">阅</div>
      <h1>从一份文件开始</h1>
      <p>选择左侧的文件，保持专注地阅读 AI 与多 Agent 的产出。</p>
      <button class="button primary" data-action="pick">选择文件夹</button>
      <div class="principles"><span>只读起步</span><span>本地优先</span><span>可追溯</span></div>
    </div>`;
  }

  const current = state.current;
  const language = languageLabel(current.language);
  if (state.editing) {
    const editorMarkup = current.language === 'markdown'
      ? '<div id="markdown-editor" class="markdown-editor" aria-label="Markdown 所见即所得编辑器"></div>'
      : `<textarea id="source-editor" class="source-editor" spellcheck="false" aria-label="${language} 源码编辑器"></textarea>`;
    const conflictNotice = current.conflict
      ? `<div class="conflict-notice" role="alert"><strong>远端文件已变化</strong><p>本地草稿仍保留，未自动覆盖远端内容。你可以载入远端版本，或明确确认用本地草稿覆盖。</p><div class="conflict-actions"><button class="button ghost" data-action="reload-conflict" ${typeof current.conflict.content === 'string' ? '' : 'disabled'}>载入远端版本</button><button class="button danger" data-action="overwrite-conflict">确认覆盖远端</button><button class="button tiny" data-action="discard-draft">放弃草稿</button></div></div>`
      : '';
    return `<div class="reader-surface editor-surface"><div class="reader-floating-toolbar" role="toolbar"><span id="editor-status" class="editor-status">编辑中 · 未修改</span><div class="reader-mode-actions"><button class="button ghost" data-action="read-mode">只读</button>${current.saveFailed ? '<button class="button danger tiny" data-action="discard-draft">放弃草稿</button>' : ''}</div></div>${conflictNotice}<div class="editor-scroll">${editorMarkup}</div></div>`;
  }

  const body = current.binary
    ? `<div class="binary-placeholder"><div class="placeholder-icon">◇</div><h3>暂不预览二进制文件</h3><p>当前阶段只面向文本与代码阅读。</p></div>`
    : current.language === 'markdown'
      ? `<article class="markdown-body">${renderMarkdown(current.content)}</article>`
      : current.language === 'html' && current.htmlPreview && byteLength(current.content) <= MAX_EDIT_BYTES
        ? `<div class="html-preview-wrap"><iframe class="html-preview" sandbox title="安全 HTML 预览" srcdoc="${escapeHtml(sanitizeHtmlPreview(current.content))}"></iframe></div>`
        : renderCodeViewer(current.content, current.language);
  const editorAction = current.language === 'markdown' && !current.editable
    ? '<span class="editor-status">文件超过 512 KB，仅只读预览</span>'
    : '';
  const canEdit = !current.binary && (current.language !== 'markdown' || current.editable);
  const htmlAction = current.language === 'html' && byteLength(current.content) <= MAX_EDIT_BYTES
    ? `<button class="button ghost" data-action="toggle-html-preview">${current.htmlPreview ? '源码' : '预览'}</button>`
    : '';
  return `<div class="reader-surface"><div class="viewer-scroll"><div class="reader-floating-toolbar" role="toolbar"><span class="reader-mode-label">只读</span>${canEdit ? '<button class="button ghost" data-action="edit-file">编辑</button>' : ''}${htmlAction}${editorAction}</div>${body}</div></div>`;
}

function renderCopilot() {
  if (state.rightCollapsed) {
    return '<aside class="copilot-panel is-collapsed"><button class="panel-collapse" data-action="toggle-right" title="展开右侧栏" aria-label="展开右侧栏">‹</button></aside>';
  }
  return `<aside class="copilot-panel">
    <div class="assistant-switcher" role="tablist" aria-label="右侧工具"><button class="panel-view-button ${state.rightView === 'ai' ? 'active' : ''}" data-action="show-ai" role="tab" aria-selected="${state.rightView === 'ai'}">AI 辅助</button><button class="panel-view-button ${state.rightView === 'notebook' ? 'active' : ''}" data-action="show-notebook" role="tab" aria-selected="${state.rightView === 'notebook'}">笔记本</button><button class="panel-collapse" data-action="toggle-right" title="折叠右侧栏" aria-label="折叠右侧栏">›</button></div>
    ${state.rightView === 'notebook' ? renderNotebookPanel() : renderCopilotPanel()}
  </aside>`;
}

function normalizeAssistantText(value) {
  return String(value || '').split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (/^[-*+]\s+/.test(trimmed)) return `• ${trimmed.replace(/^[-*+]\s+/, '')}`;
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    return numbered ? `${numbered[1]}. ${numbered[2]}` : trimmed;
  }).join('\n').trim();
}

function renderAssistantText(value) {
  const normalized = normalizeAssistantText(value);
  return `<div class="assistant-markdown markdown-body">${renderMarkdown(normalized)}</div>`;
}

function renderCopilotPanel() {
  const copilot = state.copilot;
  const messages = copilot.messages.map((message) => `<div class="copilot-message ${message.role}">
    <div class="copilot-message-label">${message.role === 'assistant' ? 'AI' : '你'}</div>
    <div class="copilot-message-body">${message.role === 'assistant' ? renderAssistantText(message.content) : `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>`}</div>
  </div>`).join('');
  return `<div class="copilot-content">
    <div class="copilot-scroll" role="log" aria-live="polite">${messages || `<div class="copilot-empty compact"><div class="copilot-empty-mark">✦</div><h3>从当前文件开始</h3><p>直接提问，AI 只读取正在阅读的文本。</p></div>`}${copilot.pendingPrompt ? `<div class="copilot-message user pending"><div class="copilot-message-label">你</div><div class="copilot-message-body"><p>${escapeHtml(copilot.pendingPrompt)}</p><span class="copilot-thinking">正在思考…</span></div></div>` : ''}</div>
    ${copilot.error ? `<div class="copilot-error"><span>${escapeHtml(copilot.error)}</span><button class="button tiny" data-action="retry-copilot" ${copilot.busy || !copilot.lastRequest ? 'disabled' : ''}>重试</button></div>` : ''}
    <div class="copilot-composer"><textarea data-copilot-prompt rows="1" placeholder="询问当前文件……" ${copilot.busy ? 'disabled' : ''}>${escapeHtml(copilot.prompt)}</textarea><button class="copilot-send" data-action="copilot-submit" aria-label="发送" title="发送（Enter）" ${copilot.busy ? 'disabled' : ''}>${copilot.busy ? '…' : '↑'}</button></div>
  </div>`;
}

function renderNotebookPanel() {
  const notebook = activeNotebook();
  if (!notebook) return '<div class="copilot-empty"><p>尚未创建笔记本。</p><button class="button primary tiny" data-action="new-notebook">新建笔记本</button></div>';
  const deleteTarget = state.notebooks.find((item) => item.id === state.notebookDeleteId);
  const deletePrompt = deleteTarget
    ? `<div class="notebook-delete-prompt" role="alert"><span>删除“${escapeHtml(deleteTarget.title)}”？</span><button class="button danger tiny" data-action="confirm-delete-notebook" data-notebook-id="${escapeHtml(deleteTarget.id)}">删除</button><button class="button ghost tiny" data-action="cancel-delete-notebook">取消</button></div>`
    : '';
  return `<div class="notebook-wrap"><div class="notebook-list">${state.notebooks.map((item) => `<button class="notebook-tab ${item.id === notebook.id ? 'active' : ''}" data-action="select-notebook" data-notebook-id="${escapeHtml(item.id)}" title="右键删除">${escapeHtml(item.title)}</button>`).join('')}<button class="notebook-tab add" data-action="new-notebook" title="添加笔记本" aria-label="添加笔记本">＋</button></div>${deletePrompt}<div class="notebook-toolbar"><input class="notebook-title" data-notebook-title value="${escapeHtml(notebook.title)}" aria-label="笔记本名称"><button class="button tiny" data-action="export-notebook-resource" title="选择一个已有文本文件并覆盖导出">导出</button><button class="button danger tiny" data-action="request-delete-active-notebook" title="删除当前笔记本">删除</button></div><textarea class="notebook-editor" data-notebook placeholder="在这里记录……">${escapeHtml(state.notebookText)}</textarea></div>`;
}

let resizeCleanup = null;

const transientScrollbarTimers = new WeakMap();

function bindTransientScrollbar(element) {
  if (!element) return;
  element.addEventListener('scroll', () => {
    element.classList.add('is-scrolling');
    window.clearTimeout(transientScrollbarTimers.get(element));
    transientScrollbarTimers.set(element, window.setTimeout(() => {
      element.classList.remove('is-scrolling');
      transientScrollbarTimers.delete(element);
    }, 650));
  }, { passive: true });
}

function isNativeEditingTarget(target) {
  return Boolean(target?.matches?.('input, textarea, select, [contenteditable="true"]'));
}

function handleGlobalKeydown(event) {
  const key = String(event.key || '').toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') {
    if (state.annotationComposer || state.selection) {
      removeSelectionOverlay();
      state.annotationComposer = null;
      state.selection = null;
      hideAnnotationBubble();
      return;
    }
    return;
  }
  if (modifier && !event.shiftKey && key === 'z') {
    if (state.editing || isNativeEditingTarget(event.target)) return;
    event.preventDefault();
    const writeAt = state.current?.undoAt || 0;
    if (state.annotationUndo && state.annotationUndoAt >= writeAt) undoAnnotationChange();
    else if (state.current?.undo) undoLastWrite();
    else if (state.annotationUndo) undoAnnotationChange();
    else {
      state.status = '没有可撤销的操作';
      updateFooterStatus();
    }
    return;
  }
  if (modifier && !event.shiftKey && key === 's' && state.editing && state.current?.draftDirty) {
    event.preventDefault();
    void flushAutoSave();
  }
}

function beginResize(side, event) {
  event.preventDefault();
  resizeCleanup?.();
  const workspace = root.querySelector('.workspace');
  if (!workspace) return;
  const startX = event.clientX;
  const startWidth = side === 'left' ? state.leftWidth : state.rightWidth;
  const update = (moveEvent) => {
    const delta = moveEvent.clientX - startX;
    const width = side === 'left' ? startWidth + delta : startWidth - delta;
    if (side === 'left') state.leftWidth = Math.min(420, Math.max(180, width));
    else state.rightWidth = Math.min(420, Math.max(220, width));
    workspace.style.setProperty(`--${side}-panel-width`, `${side === 'left' ? state.leftWidth : state.rightWidth}px`);
  };
  const finish = () => {
    window.removeEventListener('pointermove', update);
    window.removeEventListener('pointerup', finish);
    resizeCleanup = null;
    saveLayout();
    render();
  };
  resizeCleanup = finish;
  window.addEventListener('pointermove', update);
  window.addEventListener('pointerup', finish, { once: true });
}

function render() {
  if (!root) return;
  const remountSession = !suppressEditorRemount && !state.busy && state.editing && state.current && (
    activeMarkdownEditor || pendingMarkdownEditor || root.querySelector('#source-editor') || root.querySelector('#markdown-editor .ProseMirror')
  ) ? state.current : null;
  suppressEditorRemount = false;
  const editorCleanup = remountSession ? destroyMarkdownEditor() : null;
  const previousTreeScroll = root.querySelector('.tree-scroll')?.scrollTop || 0;
  const nodeIndex = new Map();
  const tree = renderTree();
  // renderTreeNode populates its local index during markup creation; rebuild the lookup here.
  const collect = (node) => {
    if (!node) return;
    nodeIndex.set(node.id, node);
    node.items.forEach(collect);
  };
  collect(state.rootNode);

  root.innerHTML = `<div class="reader-app">
    <div class="workspace" style="--left-panel-width:${state.leftCollapsed ? 38 : state.leftWidth}px;--right-panel-width:${state.rightCollapsed ? 38 : state.rightWidth}px">
      <aside class="file-panel${state.leftCollapsed ? ' is-collapsed' : ''}">
        <div class="panel-heading"><div class="panel-heading-title">文件栏</div><div class="panel-heading-actions"><button class="panel-tool" data-action="open-folder" ${state.rootNode && !state.busy && !state.restoring ? '' : 'disabled'} title="在本地文件资源管理器中打开" aria-label="在本地文件资源管理器中打开">↗</button><button class="panel-tool" data-action="refresh" ${state.rootNode && !state.busy && !state.restoring ? '' : 'disabled'} title="刷新目录" aria-label="刷新目录">↻</button><button class="panel-tool" data-action="pick" ${state.busy || state.restoring ? 'disabled' : ''} title="选择文件夹" aria-label="选择文件夹">＋</button>${state.leftCollapsed ? '' : '<button class="panel-collapse" data-action="toggle-left" title="折叠文件树" aria-label="折叠文件树">‹</button>'}</div></div>
        ${state.leftCollapsed ? '<button class="panel-collapse file-panel-expand" data-action="toggle-left" title="展开文件树" aria-label="展开文件树">›</button>' : ''}
        <div class="tree-scroll">${tree}</div>
      </aside>
      <div class="panel-resizer" data-resizer="left" role="separator" aria-label="调整文件树宽度"></div>
      <main class="reader-panel">${renderReaderPane()}</main>
      <div class="panel-resizer" data-resizer="right" role="separator" aria-label="调整阅读助手宽度"></div>
      ${renderCopilot()}
    </div>
  </div>`;

  const article = root.querySelector('.viewer-scroll .markdown-body');
  if (article && state.current?.language === 'markdown') {
    applyAnnotationMarks(article, state.annotations);
  }

  const treeScroll = root.querySelector('.tree-scroll');
  if (treeScroll) treeScroll.scrollTop = previousTreeScroll;
  root.querySelectorAll('.tree-scroll, .viewer-scroll, .editor-scroll, .copilot-scroll, .code-viewer, .source-editor').forEach(bindTransientScrollbar);

  root.querySelectorAll('[data-resizer]').forEach((element) => {
    element.addEventListener('pointerdown', (event) => beginResize(element.dataset.resizer, event));
  });

  root.querySelectorAll('[data-annotation-id]').forEach((element) => {
    element.addEventListener('click', () => focusAnnotation(element.dataset.annotationId));
  });
  root.querySelectorAll('.annotation-comment').forEach((element) => {
    element.addEventListener('mouseenter', () => showAnnotationBubble(element));
    element.addEventListener('mouseleave', hideAnnotationBubble);
  });

  root.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', () => {
      const action = element.dataset.action;
      const node = nodeIndex.get(element.dataset.nodeId);
      const annotationIdValue = element.dataset.annotationId;
      if (action === 'open-folder') openFolderInExplorer();
      if (action === 'pick') requestTransition('重新选择文件夹', chooseFolder);
      if (action === 'refresh') requestTransition('刷新目录', refreshRoot);
      if (action === 'toggle') requestTransition(`切换到目录 ${node?.name || ''}`, () => toggleDirectory(node));
      if (action === 'open') {
        if (node?.id === state.current?.node?.id) {
          state.status = `${languageLabel(state.current.language)} · 当前文件已打开`;
          updateFooterStatus();
        } else {
          requestTransition(`打开 ${node?.name || '其他文件'}`, () => openFile(node));
        }
      }
      if (action === 'toggle-left') {
        state.leftCollapsed = !state.leftCollapsed;
        saveLayout();
        render();
      }
      if (action === 'toggle-right') {
        state.rightCollapsed = !state.rightCollapsed;
        saveLayout();
        render();
      }
      if (action === 'show-ai') {
        state.rightView = 'ai';
        render();
      }
      if (action === 'show-notebook') {
        state.rightView = 'notebook';
        render();
      }
      if (action === 'edit-file') startEditing();
      if (action === 'read-mode') requestTransition('切换为只读', stopEditing);
      if (action === 'toggle-html-preview') {
        state.current.htmlPreview = !state.current.htmlPreview;
        render();
      }
      if (action === 'retry-save') retrySaveCurrent();
      if (action === 'reload-conflict') reloadConflict();
      if (action === 'overwrite-conflict') overwriteConflict();
      if (action === 'discard-draft') discardDraft();
      if (action === 'add-comment') beginAnnotation('comment');
      if (action === 'add-highlight') beginAnnotation('highlight');
      if (action === 'add-underline') beginAnnotation('underline');
      if (action === 'erase-annotation') beginAnnotation('erase');
      if (action === 'focus-annotation') focusAnnotation(annotationIdValue);
      if (action === 'new-notebook') createNotebookAction();
      if (action === 'select-notebook') selectNotebook(element.dataset.notebookId);
      if (action === 'request-delete-active-notebook') requestNotebookDelete(state.activeNotebookId);
      if (action === 'confirm-delete-notebook') deleteNotebook(element.dataset.notebookId);
      if (action === 'cancel-delete-notebook') {
        state.notebookDeleteId = null;
        render();
      }
      if (action === 'export-notebook-resource') exportNotebookToResource();
      if (action === 'copilot-submit') {
        const prompt = root.querySelector('[data-copilot-prompt]')?.value || '';
        state.copilot.prompt = prompt;
        askCopilot(prompt);
      }
      if (action === 'retry-copilot') retryCopilot();
    });
  });

  const notebookEditor = root.querySelector('[data-notebook]');
  if (notebookEditor) {
    notebookEditor.addEventListener('input', () => {
      state.notebookText = notebookEditor.value;
      saveNotebook();
    });
  }

  const notebookTitle = root.querySelector('[data-notebook-title]');
  if (notebookTitle) notebookTitle.addEventListener('input', updateNotebookTitle);
  root.querySelectorAll('[data-action="select-notebook"]').forEach((notebookTab) => {
    notebookTab.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      requestNotebookDelete(notebookTab.dataset.notebookId);
    });
  });

  const copilotPrompt = root.querySelector('[data-copilot-prompt]');
  if (copilotPrompt) {
    copilotPrompt.addEventListener('input', () => {
      state.copilot.prompt = copilotPrompt.value;
    });
    copilotPrompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        state.copilot.prompt = copilotPrompt.value;
        askCopilot(copilotPrompt.value);
      }
    });
  }

  const viewer = root.querySelector('.viewer-scroll');
  const readerScroll = root.querySelector('.viewer-scroll, .editor-scroll');
  if (readerScroll && state.current) {
    readerScroll.scrollTop = state.current.scrollTop || 0;
    readerScroll.addEventListener('scroll', () => {
      if (!state.current) return;
      state.current.scrollTop = readerScroll.scrollTop;
      scheduleSessionSave();
    }, { passive: true });
  }
  if (viewer && state.current) {
    viewer.addEventListener('mousedown', (event) => {
      if (!event.target.closest('.selection-toolbar, .annotation-composer-popover')) clearViewerSelection(viewer);
    });
    viewer.addEventListener('mouseup', () => window.setTimeout(() => captureViewerSelection(viewer), 0));
    viewer.addEventListener('keyup', () => window.setTimeout(() => captureViewerSelection(viewer), 0));
  }

  requestAnimationFrame(async () => {
    hana.ui.resize({ height: Math.max(680, root.scrollHeight) });
    if (!remountSession || !state.editing || state.current !== remountSession || state.busy) return;
    try {
      if (editorCleanup) await editorCleanup;
      if (state.editing && state.current === remountSession && !state.busy) await mountCurrentEditor();
    } catch (error) {
      state.editing = false;
      state.error = `编辑器加载失败：${error instanceof Error ? error.message : String(error)}`;
      render();
    }
  });
}

window.addEventListener('keydown', handleGlobalKeydown);
window.addEventListener('beforeunload', () => {
  window.clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;
  saveSession();
});
render();
hana.ready({ surface: 'page', pluginId: 'hana-reader', version: PLUGIN_VERSION });
restoreSession();
