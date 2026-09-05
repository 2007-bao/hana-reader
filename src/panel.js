import { highlightCode, renderMarkdown, sanitizeHtmlPreview } from './markdown-engine.js';
import { mountMarkdownEditor } from './markdown-editor.js';
import { applyAnnotationMarks, selectionAnchor } from './annotation-engine.js';
import { annotationResourceKey, loadAnnotations, saveAnnotations } from './annotation-store.js';
import { appendNotebookReference, createNotebook, loadNotebookStore, saveNotebookStore } from './notebook-store.js';

const PROTOCOL = 'hana.plugin.ui';
const VERSION = 1;
const SURFACE_SESSION_QUERY = 'pluginSurfaceSession';
const SURFACE_SESSION_HEADER = 'X-Hana-Plugin-Surface-Session';
const PLUGIN_VERSION = '1.0.0';
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
  rightView: 'copilot',
  notebookText: '',
  notebooks: [],
  activeNotebookId: null,
  notebookPreview: false,
  annotations: [],
  annotationKey: '',
  annotationComposer: null,
  annotationEditorId: null,
  annotationReplyId: null,
  annotationUndo: null,
  focusAnnotationId: null,
  selection: null,
  copilot: {
    messages: [],
    prompt: '',
    includeFile: false,
    includeSelection: true,
    selection: null,
    busy: false,
    pendingPrompt: '',
    error: '',
    lastRequest: null,
    suggestion: null,
    truncated: null,
    contextLimit: 16000,
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
  const status = root.querySelector('.bottom-bar .status');
  if (!status) return;
  status.textContent = state.error || state.status;
  status.classList.toggle('error', Boolean(state.error));
}

function updateEditorStatus() {
  const status = root.querySelector('#editor-status');
  if (!status || !state.current) return;
  if (state.current.saveFailed) {
    status.textContent = '自动保存失败 · 可重试或放弃草稿';
  } else if (state.current.conflict) {
    status.textContent = '检测到外部修改 · 尚未写回';
  } else if (state.current.draftDirty) {
    status.textContent = '本地草稿 · 尚未写回';
  } else {
    status.textContent = '编辑中 · 未修改';
  }
  root.querySelectorAll('[data-action="retry-save"], [data-action="discard-draft"]').forEach((button) => {
    button.hidden = !state.current.saveFailed;
  });
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
    state.copilot.selection = null;
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
      annotations: language === 'markdown' ? loadAnnotations(window.localStorage, ANNOTATION_STORAGE_KEY, annotationKey) : [],
      saveFailed: false,
    };
    state.annotationKey = annotationKey;
    state.annotations = state.current.annotations;
    state.selection = null;
    state.annotationComposer = null;
    state.annotationEditorId = null;
    state.annotationReplyId = null;
    state.annotationUndo = null;
    state.copilot = {
      ...state.copilot,
      messages: readCopilotHistory(annotationKey),
      prompt: '',
      selection: null,
      error: '',
      lastRequest: null,
      suggestion: null,
      pendingPrompt: '',
      truncated: null,
      contextLimit: state.copilot.contextLimit || 16000,
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

async function refreshRoot() {
  if (!state.rootNode || state.busy) return;
  await destroyMarkdownEditor();
  state.editing = false;
  state.current = null;
  state.annotations = [];
  state.annotationKey = '';
  state.selection = null;
  state.copilot.selection = null;
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

function renderTreeNode(node, depth, index) {
  index.set(node.id, node);
  const selected = state.current?.node?.id === node.id;
  const directory = node.isDirectory;
  const action = directory ? 'toggle' : 'open';
  const leading = '';
  const iconType = directory ? 'folder' : fileIconType(node.name);
  const disabled = node.unsupported ? ' disabled' : '';
  const nested = directory && node.expanded
    ? `<div class="tree-nested" style="--nested-depth:${depth}">${node.items.length
      ? node.items.map((child) => renderTreeNode(child, depth + 1, index)).join('')
      : '<div class="tree-empty">空文件夹</div>'}</div>`
    : '';

  return `<button class="tree-row ${directory ? 'directory' : ''} ${selected ? 'selected' : ''}${disabled}" data-action="${action}" data-node-id="${node.id}" style="--depth:${depth}" title="${escapeHtml(node.name)}">
    <span class="tree-chevron">${leading}</span>
    <span class="tree-icon ${iconType}" aria-hidden="true">${treeIconSvg(directory, node.expanded)}</span>
    <span class="tree-name">${escapeHtml(node.name)}</span>
    <span class="tree-size">${node.isDirectory ? '' : escapeHtml(formatSize(node.size))}</span>
  </button>${nested}`;
}

function fileIconType(name) {
  const extension = String(name || '').toLowerCase().split('.').pop();
  return ['markdown', 'md', 'mdx'].includes(extension) ? 'markdown'
    : ['json', 'jsonc'].includes(extension) ? 'json'
      : ['js', 'jsx', 'ts', 'tsx'].includes(extension) ? 'javascript'
        : ['css', 'scss', 'less'].includes(extension) ? 'style'
          : ['html', 'htm', 'xml'].includes(extension) ? 'markup' : 'file';
}

function treeIconSvg(directory, expanded) {
  if (directory) {
    return `<svg viewBox="0 0 24 24" focusable="false"><path d="M3.5 6.5h6l1.7 2h9.3v9.8a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V6.5Z"/><path d="M3.5 9h17"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" focusable="false"><path d="M6 3.5h8l4 4v13H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5Z"/><path d="M14 3.5v4h4"/></svg>`;
}

function renderTree() {
  if (!state.rootNode) {
    return `<div class="tree-placeholder">
      <div class="placeholder-icon">⌁</div>
      <p>选择一个文件夹</p>
      <small>从项目根目录开始阅读</small>
    </div>`;
  }

  const index = new Map();
  const tree = renderTreeNode(state.rootNode, 0, index);
  return `<div class="tree-root-name"><span class="folder-dot" aria-hidden="true">${treeIconSvg(true, true)}</span>${escapeHtml(state.rootNode.name)}</div>
    <div class="tree-content">${tree}</div>`;
}

function renderCodeViewer(content, language) {
  return `<div class="code-viewer">${String(content || '').replace(/\r\n?/g, '\n').split('\n').map((line, index) => `
    <div class="code-line"><span class="line-number">${index + 1}</span><code>${highlightCode(line, language)}</code></div>`).join('')}</div>`;
}

async function startEditing() {
  if (!state.current || state.current.binary || state.editing || state.busy) return;
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
      if (error.status !== 409 || !error.payload?.conflict || !error.payload.version) throw error;
      // Overwrite semantics: use the latest remote baseline and retry once.
      current.version = error.payload.version;
      current.baseSha256 = error.payload.sha256 || await sha256Text(error.payload.content || '');
      result = await apiJson('resources/write', {
        resource: current.node.resource,
        content: draft,
        expectedVersion: current.version,
        baseSha256: current.baseSha256,
      });
      state.status = '已覆盖外部修改并自动保存';
    }
    current.undo = { content: current.content, version: result.version };
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
    state.error = error instanceof Error ? error.message : String(error);
    state.status = '自动保存失败，请重试';
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

function currentSelection() {
  return state.selection || state.copilot.selection || null;
}

function selectionForCopilot() {
  const selection = state.copilot.selection;
  if (!selection?.quote) return null;
  return {
    content: clipContext(selection.quote, 12000),
    quote: selection.quote,
    prefix: selection.prefix,
    suffix: selection.suffix,
  };
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
}

function undoAnnotationChange() {
  if (!state.annotationUndo) return;
  state.annotations = state.annotationUndo;
  state.annotationUndo = null;
  if (state.current) state.current.annotations = state.annotations;
  saveAnnotationsForCurrent();
  state.status = '已撤销上次批注操作';
  render();
}

function annotationById(id) {
  return state.annotations.find((annotation) => annotation.id === id) || null;
}

function annotationId() {
  return globalThis.crypto?.randomUUID?.() || `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function beginAnnotation(kind) {
  if (!state.current || state.current.language !== 'markdown' || !state.selection?.quote) {
    state.error = '请先在 Markdown 正文中选中文本。';
    render();
    return;
  }
  if (kind === 'highlight' || kind === 'underline') {
    recordAnnotationUndo();
    const annotation = makeAnnotation(kind, '');
    state.annotations.push(annotation);
    state.current.annotations = state.annotations;
    saveAnnotationsForCurrent();
    state.focusAnnotationId = annotation.id;
    state.selection = null;
    state.rightView = 'annotations';
    state.status = kind === 'highlight' ? '已添加高亮' : '已添加下划线';
    render();
    return;
  }
  state.annotationComposer = { kind: 'comment', selection: { ...state.selection } };
  state.rightView = 'annotations';
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
  recordAnnotationUndo();
  const annotation = makeAnnotation('comment', note);
  state.annotations.push(annotation);
  state.current.annotations = state.annotations;
  saveAnnotationsForCurrent();
  state.annotationComposer = null;
  state.selection = null;
  state.focusAnnotationId = annotation.id;
  state.status = '已添加批注';
  render();
}

function updateAnnotationNote(id) {
  const annotation = annotationById(id);
  if (!annotation) return;
  const input = root.querySelector(`[data-annotation-edit="${id}"]`);
  if (!input) return;
  recordAnnotationUndo();
  annotation.note = input.value.trim().slice(0, 4000);
  annotation.updatedAt = Date.now();
  state.annotationEditorId = null;
  saveAnnotationsForCurrent();
  render();
}

function addAnnotationReply(id) {
  const annotation = annotationById(id);
  if (!annotation) return;
  const input = root.querySelector(`[data-annotation-reply="${id}"]`);
  const text = input?.value?.trim();
  if (!text) return;
  recordAnnotationUndo();
  annotation.replies.push({ id: annotationId(), text: text.slice(0, 2000), createdAt: Date.now() });
  annotation.updatedAt = Date.now();
  state.annotationReplyId = null;
  saveAnnotationsForCurrent();
  render();
}

function toggleAnnotationResolved(id) {
  const annotation = annotationById(id);
  if (!annotation) return;
  recordAnnotationUndo();
  annotation.resolved = !annotation.resolved;
  annotation.updatedAt = Date.now();
  saveAnnotationsForCurrent();
  render();
}

function deleteAnnotation(id) {
  recordAnnotationUndo();
  state.annotations = state.annotations.filter((annotation) => annotation.id !== id);
  if (state.current) state.current.annotations = state.annotations;
  if (state.focusAnnotationId === id) state.focusAnnotationId = null;
  saveAnnotationsForCurrent();
  render();
}

function focusAnnotation(id) {
  state.focusAnnotationId = id;
  state.rightView = 'annotations';
  render();
  window.requestAnimationFrame(() => {
    const mark = [...root.querySelectorAll('[data-annotation-id]')].find((element) => element.dataset.annotationId === id);
    mark?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark?.classList.add('is-focused');
    window.setTimeout(() => mark?.classList.remove('is-focused'), 1200);
  });
}

function annotationToNotebook(id) {
  const annotation = annotationById(id);
  const notebook = activeNotebook();
  if (!annotation || !notebook || !state.current) return;
  const next = appendNotebookReference(notebook, {
    fileName: state.current.name,
    quote: annotation.quote,
    note: annotation.note,
  });
  Object.assign(notebook, next);
  state.activeNotebookId = notebook.id;
  syncNotebookText();
  saveNotebook();
  state.rightView = 'notebook';
  state.status = '已将批注加入 Notebook';
  render();
}

function appendCurrentSelectionToNotebook() {
  const notebook = activeNotebook();
  if (!notebook || !state.current) return;
  const selection = currentSelection();
  const next = appendNotebookReference(notebook, {
    fileName: state.current.name,
    quote: selection?.quote || '',
  });
  Object.assign(notebook, next);
  syncNotebookText();
  saveNotebook();
  state.rightView = 'notebook';
  state.selection = null;
  state.status = selection?.quote ? '已将选中文本加入 Notebook' : '已将当前文件加入 Notebook';
  render();
}

function selectNotebook(id) {
  if (!state.notebooks.some((notebook) => notebook.id === id)) return;
  state.activeNotebookId = id;
  state.notebookPreview = false;
  syncNotebookText();
  saveNotebook();
  render();
}

function createNotebookAction() {
  const notebook = createNotebook(`笔记 ${state.notebooks.length + 1}`);
  state.notebooks.push(notebook);
  state.activeNotebookId = notebook.id;
  state.notebookText = '';
  saveNotebook();
  render();
}

function deleteActiveNotebook() {
  if (state.notebooks.length <= 1) {
    const notebook = activeNotebook();
    if (notebook) {
      notebook.text = '';
      notebook.title = '阅读笔记';
      notebook.updatedAt = Date.now();
    }
  } else {
    const index = state.notebooks.findIndex((notebook) => notebook.id === state.activeNotebookId);
    state.notebooks = state.notebooks.filter((notebook) => notebook.id !== state.activeNotebookId);
    state.activeNotebookId = state.notebooks[Math.max(0, index - 1)]?.id || state.notebooks[0]?.id || null;
  }
  syncNotebookText();
  saveNotebook();
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

function downloadNotebook() {
  const notebook = activeNotebook();
  if (!notebook) return;
  const blob = new Blob([notebook.text || ''], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(notebook.title || '阅读笔记').replace(/[\\/:*?"<>|]/g, '_')}.md`;
  link.click();
  URL.revokeObjectURL(url);
  state.status = '已导出 Notebook';
}

async function exportNotebookToResource() {
  const notebook = activeNotebook();
  if (!notebook || state.busy) return;
  state.busy = true;
  state.error = '';
  state.status = '请选择一个用于写回的 Markdown 文件…';
  render();
  try {
    const picked = await hana.resources.pick({ mode: 'file', multiple: false, capability: 'resource.write' });
    const resource = picked?.resources?.[0];
    if (!resource) {
      state.status = '未选择导出文件';
      return;
    }
    const current = await apiJson('resources/read', { resource });
    if (current.binary) throw new Error('不能把 Notebook 写入二进制文件。');
    const result = await apiJson('resources/write', {
      resource,
      content: notebook.text || '',
      expectedVersion: current.version,
      baseSha256: await sha256Text(current.content || ''),
    });
    state.status = `Notebook 已安全写回 · ${result.version ? '版本已更新' : '已完成'}`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = error.status === 409 ? '导出遇到外部修改，未覆盖远端内容' : 'Notebook 导出失败';
  } finally {
    state.busy = false;
    render();
  }
}

function copilotToNotebook(messageId) {
  const message = state.copilot.messages.find((item) => item.id === messageId && item.role === 'assistant');
  const notebook = activeNotebook();
  if (!message || !notebook) return;
  notebook.text = `${notebook.text || ''}\n\n### Copilot 回复\n${message.content}\n`;
  notebook.updatedAt = Date.now();
  syncNotebookText();
  saveNotebook();
  state.rightView = 'notebook';
  state.status = '已将 Copilot 回复加入 Notebook';
  render();
}

function buildCopilotRequest(promptOverride = '') {
  const prompt = String(promptOverride || state.copilot.prompt || '').trim();
  const file = state.copilot.includeFile && state.current && !state.current.binary
    ? { name: state.current.name, language: state.current.language, content: clipContext(state.current.content, state.copilot.contextLimit || MAX_COPILOT_CONTEXT_CHARS) }
    : null;
  const selection = state.copilot.includeSelection ? selectionForCopilot() : null;
  return {
    prompt,
    file,
    selection,
    history: state.copilot.messages.slice(-12).map((message) => ({ role: message.role, content: message.content })),
  };
}

function copilotTaskPrompt(task) {
  const prompts = {
    summary: '请总结我提供的上下文，先给出一句话结论，再列出 3—5 个关键点。',
    explain: '请解释我提供的上下文，优先说明关键概念、因果关系和容易误解的地方。',
    knowledge: '请从我提供的上下文中提取可复习的知识点，使用清晰的 Markdown 列表。',
    review: '请审阅我提供的 Markdown 内容，指出最值得修改的结构、事实或表达问题；如果提出修改，请给出理由。',
  };
  return prompts[task] || '';
}

async function askCopilot(promptOverride = '', preset = null) {
  const request = preset || buildCopilotRequest(promptOverride);
  if (!request.prompt) {
    state.copilot.error = '请先输入问题，或点击一个快捷任务。';
    render();
    return;
  }
  if (!request.file && !request.selection) {
    state.copilot.error = '请先勾选当前文件或选中文本作为上下文。';
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

function extractMarkdownSuggestion(text) {
  const match = String(text || '').match(/```(?:markdown|md|text)?\s*\n([\s\S]*?)```/i);
  return match ? match[1].replace(/^\n+|\n+$/g, '') : '';
}

function prepareCopilotApply(messageId) {
  const message = state.copilot.messages.find((item) => item.id === messageId && item.role === 'assistant');
  const selection = state.copilot.selection;
  if (!message || !selection?.quote || state.current?.language !== 'markdown') {
    state.copilot.error = '请先选择要替换的 Markdown 原文，再应用建议。';
    render();
    return;
  }
  const replacement = extractMarkdownSuggestion(message.content);
  const start = state.current.content.indexOf(selection.quote);
  if (!replacement) {
    state.copilot.error = '请让 Copilot 用 Markdown 代码块返回可替换内容，再应用建议。';
    render();
    return;
  }
  if (start < 0) {
    state.copilot.error = '当前选区包含渲染格式，无法安全定位到 Markdown 原文；请改为选择纯文本。';
    render();
    return;
  }
  state.copilot.suggestion = {
    messageId,
    original: selection.quote,
    replacement,
    start,
  };
  state.copilot.error = '';
  render();
}

async function confirmCopilotApply() {
  const suggestion = state.copilot.suggestion;
  const current = state.current;
  if (!suggestion || !current || current.language !== 'markdown') return;
  const actual = current.content.slice(suggestion.start, suggestion.start + suggestion.original.length);
  if (actual !== suggestion.original) {
    state.copilot.error = '原文已经发生变化，已取消应用；请重新选择文本。';
    state.copilot.suggestion = null;
    render();
    return;
  }
  await destroyMarkdownEditor();
  current.draftContent = `${current.content.slice(0, suggestion.start)}${suggestion.replacement}${current.content.slice(suggestion.start + suggestion.original.length)}`;
  current.draftDirty = current.draftContent !== current.content;
  current.conflict = null;
  state.editing = true;
  state.copilot.suggestion = null;
  state.status = '已应用 Copilot 建议，正在自动保存…';
  suppressEditorRemount = true;
  render();
  try {
    await mountCurrentEditor();
    scheduleAutoSave();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
}

function captureViewerSelection(viewer) {
  const article = viewer?.querySelector('.markdown-body');
  const selection = window.getSelection?.();
  if (!article || !selection || selection.isCollapsed || !selection.rangeCount) return;
  if (!article.contains(selection.anchorNode) || !article.contains(selection.focusNode)) return;
  const anchor = selectionAnchor(article, selection);
  if (!anchor) return;
  state.selection = anchor;
  state.copilot.selection = anchor;
  render();
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
    return `<div class="reader-modebar"><span id="editor-status" class="editor-status">编辑中 · 未修改</span><div class="reader-mode-actions"><button class="button ghost" data-action="read-mode">只读</button><button class="button primary" disabled>编辑</button>${current.saveFailed ? '<button class="button ghost" data-action="retry-save">重试保存</button><button class="button danger" data-action="discard-draft">放弃草稿</button>' : ''}${current.undo ? '<button class="button ghost" data-action="undo-write">回撤</button>' : ''}</div></div>
    <div class="editor-scroll">${editorMarkup}</div>`;
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
  const selection = state.selection;
  const selectionTools = current.language === 'markdown' && selection?.quote
    ? `<div class="selection-toolbar"><span class="selection-toolbar-label">已选 ${escapeHtml(selection.quote.slice(0, 46))}${selection.quote.length > 46 ? '…' : ''}</span><button class="button tiny" data-action="add-comment">批注</button><button class="button tiny" data-action="add-highlight">高亮</button><button class="button tiny" data-action="add-underline">下划线</button><button class="button tiny" data-action="selection-to-notebook">加入笔记</button><button class="button tiny ghost" data-action="clear-selection">取消</button></div>`
    : '';

  return `<div class="reader-modebar"><div class="reader-mode-actions"><button class="button primary" disabled>只读</button>${canEdit ? '<button class="button ghost" data-action="edit-file">编辑</button>' : ''}${current.language === 'html' && byteLength(current.content) <= MAX_EDIT_BYTES ? `<button class="button ghost" data-action="toggle-html-preview">${current.htmlPreview ? '查看源码' : '安全预览'}</button>` : ''}${current.undo ? '<button class="button ghost" data-action="undo-write">回撤</button>' : ''}${editorAction}</div></div>
  ${selectionTools}<div class="viewer-scroll">${body}</div>`;
}

function renderCopilot() {
  if (state.rightCollapsed) {
    return '<aside class="copilot-panel is-collapsed"><button class="panel-collapse" data-action="toggle-right" title="展开阅读助手">‹</button></aside>';
  }
  const titles = {
    copilot: ['✦', 'Copilot', '阅读助手'],
    annotations: ['❖', '批注', '审阅标记'],
    notebook: ['▤', 'Notebook', '阅读笔记'],
  };
  const [orb, title, subtitle] = titles[state.rightView] || titles.copilot;
  return `<aside class="copilot-panel">
    <div class="copilot-heading"><span class="copilot-orb">${orb}</span><div><h2>${title}</h2><p>${subtitle}</p></div><div class="copilot-switcher"><button class="panel-view-button ${state.rightView === 'copilot' ? 'active' : ''}" data-action="show-copilot">Copilot</button><button class="panel-view-button ${state.rightView === 'annotations' ? 'active' : ''}" data-action="show-annotations">批注</button><button class="panel-view-button ${state.rightView === 'notebook' ? 'active' : ''}" data-action="show-notebook">笔记本</button></div><button class="panel-collapse" data-action="toggle-right" title="折叠阅读助手">›</button></div>
    ${state.rightView === 'notebook' ? renderNotebookPanel() : state.rightView === 'annotations' ? renderAnnotationsPanel() : renderCopilotPanel()}
  </aside>`;
}

function renderCopilotPanel() {
  const copilot = state.copilot;
  const messages = copilot.messages.map((message) => `<div class="copilot-message ${message.role}">
    <div class="copilot-message-label">${message.role === 'assistant' ? 'Copilot' : '你'}</div>
    <div class="copilot-message-body">${message.role === 'assistant' ? renderMarkdown(message.content) : `<p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p>`}</div>
    ${message.role === 'assistant' ? `<div class="copilot-message-actions"><button class="button tiny" data-action="prepare-copilot-apply" data-message-id="${escapeHtml(message.id || '')}">应用修改建议</button><button class="button tiny" data-action="copilot-to-notebook" data-message-id="${escapeHtml(message.id || '')}">加入笔记</button></div>` : ''}
  </div>`).join('');
  const contextSelection = copilot.selection?.quote || '';
  const suggestion = copilot.suggestion;
  return `<div class="copilot-content">
    <div class="copilot-context-box"><div class="copilot-section-label">本轮上下文（由你选择）</div><label class="context-toggle"><input type="checkbox" data-context-file ${copilot.includeFile ? 'checked' : ''} ${state.current && !state.current.binary ? '' : 'disabled'}> 当前文件 <span>${state.current ? escapeHtml(state.current.name) : '未打开文件'}</span></label><label class="context-toggle"><input type="checkbox" data-context-selection ${copilot.includeSelection ? 'checked' : ''} ${contextSelection ? '' : 'disabled'}> 选中文本 <span>${contextSelection ? escapeHtml(contextSelection.slice(0, 34)) : '尚未选择'}</span></label><label class="context-limit">上下文长度 <select data-context-limit><option value="8000" ${copilot.contextLimit === 8000 ? 'selected' : ''}>短 · 8k</option><option value="16000" ${copilot.contextLimit === 16000 ? 'selected' : ''}>中 · 16k</option><option value="24000" ${copilot.contextLimit === 24000 ? 'selected' : ''}>长 · 24k</option></select></label></div>
    <div class="copilot-quick-actions"><button class="button tiny" data-action="copilot-task" data-copilot-task="summary">总结</button><button class="button tiny" data-action="copilot-task" data-copilot-task="explain">解释</button><button class="button tiny" data-action="copilot-task" data-copilot-task="knowledge">知识点</button><button class="button tiny" data-action="copilot-task" data-copilot-task="review">审阅</button></div>
    <div class="copilot-scroll">${messages || `<div class="copilot-empty compact"><div class="copilot-spark">✧</div><h3>先读，再问</h3><p>勾选当前文件或选中文本，再输入问题。Copilot 不会默认读取整个项目。</p></div>`}${copilot.pendingPrompt ? `<div class="copilot-message user pending"><div class="copilot-message-label">你</div><div class="copilot-message-body"><p>${escapeHtml(copilot.pendingPrompt)}</p><span class="copilot-thinking">正在思考…</span></div></div>` : ''}</div>
    ${copilot.error ? `<div class="copilot-error"><span>${escapeHtml(copilot.error)}</span><button class="button tiny" data-action="retry-copilot" ${copilot.busy || !copilot.lastRequest ? 'disabled' : ''}>重试</button></div>` : ''}
    ${copilot.truncated ? `<div class="copilot-note compact"><span>⌁</span>上下文较长，已自动保留开头和结尾。</div>` : ''}
    ${suggestion ? `<div class="copilot-apply-card"><strong>确认应用修改建议？</strong><div class="copilot-apply-diff"><div><span>原文</span><pre>${escapeHtml(suggestion.original)}</pre></div><div><span>替换为</span><pre>${escapeHtml(suggestion.replacement)}</pre></div></div><div class="copilot-apply-actions"><button class="button ghost" data-action="cancel-copilot-apply">取消</button><button class="button primary" data-action="confirm-copilot-apply">确认并编辑</button></div></div>` : ''}
    <div class="copilot-composer"><textarea data-copilot-prompt placeholder="问问这份内容……" ${copilot.busy ? 'disabled' : ''}>${escapeHtml(copilot.prompt)}</textarea><button class="button primary" data-action="copilot-submit" ${copilot.busy ? 'disabled' : ''}>${copilot.busy ? '生成中…' : '发送'}</button></div>
    <div class="copilot-note"><span>⌁</span> 仅发送你勾选的上下文；模型不可用时会保留本地阅读与记录能力。</div>
  </div>`;
}

function renderAnnotationsPanel() {
  const composer = state.annotationComposer
    ? `<div class="annotation-composer"><div class="annotation-card-title">给“${escapeHtml(state.annotationComposer.selection.quote.slice(0, 46))}${state.annotationComposer.selection.quote.length > 46 ? '…' : ''}”添加批注</div><textarea data-annotation-composer placeholder="写下你的理解、疑问或修改理由……"></textarea><div class="annotation-actions"><button class="button ghost" data-action="cancel-annotation">取消</button><button class="button primary" data-action="save-annotation">保存批注</button></div></div>`
    : '';
  const list = state.annotations.slice().sort((a, b) => b.createdAt - a.createdAt).map((annotation) => {
    const editing = state.annotationEditorId === annotation.id;
    const replying = state.annotationReplyId === annotation.id;
    const kindLabel = annotation.kind === 'highlight' ? '高亮' : annotation.kind === 'underline' ? '下划线' : '批注';
    const located = state.current?.content?.includes(annotation.quote);
    return `<article class="annotation-card ${annotation.resolved ? 'resolved' : ''} ${state.focusAnnotationId === annotation.id ? 'focused' : ''}">
      <button class="annotation-quote" data-action="focus-annotation" data-annotation-id="${escapeHtml(annotation.id)}">${escapeHtml(annotation.quote)}</button>
      <div class="annotation-meta"><span>${kindLabel}</span><span>${located ? '已定位' : '原文已变化'}</span><span>${annotation.resolved ? '已完成' : '进行中'}</span></div>
      ${editing ? `<textarea data-annotation-edit="${escapeHtml(annotation.id)}">${escapeHtml(annotation.note)}</textarea>` : (annotation.note ? `<p class="annotation-note">${escapeHtml(annotation.note)}</p>` : '<p class="annotation-note muted">未填写文字批注</p>')}
      ${annotation.replies.length ? `<div class="annotation-replies">${annotation.replies.map((reply) => `<div><span>↳</span>${escapeHtml(reply.text)}</div>`).join('')}</div>` : ''}
      ${replying ? `<textarea data-annotation-reply="${escapeHtml(annotation.id)}" placeholder="回复这条批注……"></textarea>` : ''}
      <div class="annotation-actions"><button class="button tiny" data-action="focus-annotation" data-annotation-id="${escapeHtml(annotation.id)}">定位原文</button><button class="button tiny" data-action="toggle-annotation-resolved" data-annotation-id="${escapeHtml(annotation.id)}">${annotation.resolved ? '重新打开' : '完成'}</button><button class="button tiny" data-action="annotation-to-notebook" data-annotation-id="${escapeHtml(annotation.id)}">加入笔记</button>${editing ? `<button class="button tiny" data-action="save-annotation-edit" data-annotation-id="${escapeHtml(annotation.id)}">保存</button>` : `<button class="button tiny" data-action="edit-annotation" data-annotation-id="${escapeHtml(annotation.id)}">编辑</button>`}${replying ? `<button class="button tiny" data-action="add-annotation-reply" data-annotation-id="${escapeHtml(annotation.id)}">回复</button>` : `<button class="button tiny" data-action="reply-annotation" data-annotation-id="${escapeHtml(annotation.id)}">回复</button>`}<button class="button tiny danger" data-action="delete-annotation" data-annotation-id="${escapeHtml(annotation.id)}">删除</button></div>
    </article>`;
  }).join('');
  return `<div class="annotations-content"><div class="annotation-panel-toolbar"><span>${state.annotations.length} 条标记</span><button class="button tiny" data-action="undo-annotation" ${state.annotationUndo ? '' : 'disabled'}>撤销上一步</button></div>${composer}${list || `<div class="copilot-empty compact"><div class="copilot-spark">❖</div><h3>还没有批注</h3><p>在 Markdown 正文中选中一段文字，即可添加批注、高亮或下划线。</p></div>`}<div class="copilot-note"><span>⌁</span>批注保存在本机浏览器中，原始 Markdown 不会被偷偷改写。</div></div>`;
}

function renderNotebookPanel() {
  const notebook = activeNotebook();
  if (!notebook) return '<div class="copilot-empty"><p>尚未创建 Notebook。</p></div>';
  return `<div class="notebook-wrap"><div class="notebook-list">${state.notebooks.map((item) => `<button class="notebook-tab ${item.id === notebook.id ? 'active' : ''}" data-action="select-notebook" data-notebook-id="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>`).join('')}<button class="notebook-tab add" data-action="new-notebook" title="新建笔记">＋</button></div><div class="notebook-toolbar"><input class="notebook-title" data-notebook-title value="${escapeHtml(notebook.title)}" aria-label="笔记标题"><button class="button tiny" data-action="toggle-notebook-preview">${state.notebookPreview ? '编辑' : '预览'}</button><button class="button tiny" data-action="download-notebook">导出</button><button class="button tiny" data-action="export-notebook-resource">写回文件</button><button class="button tiny danger" data-action="delete-notebook">删除</button></div><div class="notebook-ref-actions"><button class="button tiny" data-action="notebook-add-reference">${state.selection?.quote ? '引用选区' : '引用当前文件'}</button></div>${state.notebookPreview ? `<article class="notebook-preview markdown-body">${renderMarkdown(notebook.text)}</article>` : `<textarea class="notebook-editor" data-notebook placeholder="记录阅读心得、重要知识点或待办……">${escapeHtml(state.notebookText)}</textarea>`}<div class="notebook-footer">本机自动保存 · ${state.notebooks.length} 份笔记 · 原始文件不变</div></div>`;
}

let resizeCleanup = null;

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
        <div class="panel-heading"><div><span class="eyebrow">WORKSPACE</span><h2>项目文件</h2></div><div class="panel-heading-actions"><span class="panel-count">${state.rootNode ? state.rootNode.items.length : '—'}</span><button class="panel-tool" data-action="refresh" ${state.rootNode && !state.busy && !state.restoring ? '' : 'disabled'} title="刷新目录">↻</button><button class="panel-tool" data-action="pick" ${state.busy || state.restoring ? 'disabled' : ''} title="选择文件夹">＋</button><button class="panel-collapse" data-action="toggle-left" title="折叠文件树">‹</button></div></div>
        <div class="tree-scroll">${tree}</div>
        <div class="file-panel-footer"><span class="legend-dot"></span> ResourceIO</div>
      </aside>
      <div class="panel-resizer" data-resizer="left" role="separator" aria-label="调整文件树宽度"></div>
      <main class="reader-panel">${renderReaderPane()}</main>
      <div class="panel-resizer" data-resizer="right" role="separator" aria-label="调整阅读助手宽度"></div>
      ${renderCopilot()}
    </div>
    <footer class="bottom-bar"><span class="status${state.error ? ' error' : ''}" aria-live="polite">${escapeHtml(state.error || state.status)}</span><span>本地优先 · ResourceIO · 编辑自动保存 · 可回撤</span></footer>
  </div>`;

  const article = root.querySelector('.viewer-scroll .markdown-body');
  if (article && state.current?.language === 'markdown') {
    applyAnnotationMarks(article, state.annotations);
  }

  const treeScroll = root.querySelector('.tree-scroll');
  if (treeScroll) treeScroll.scrollTop = previousTreeScroll;

  root.querySelectorAll('[data-resizer]').forEach((element) => {
    element.addEventListener('pointerdown', (event) => beginResize(element.dataset.resizer, event));
  });

  root.querySelectorAll('[data-annotation-id]').forEach((element) => {
    element.addEventListener('click', () => focusAnnotation(element.dataset.annotationId));
  });

  root.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', () => {
      const action = element.dataset.action;
      const node = nodeIndex.get(element.dataset.nodeId);
      const annotationIdValue = element.dataset.annotationId;
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
      if (action === 'show-copilot') {
        state.rightView = 'copilot';
        render();
      }
      if (action === 'show-annotations') {
        state.rightView = 'annotations';
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
      if (action === 'undo-write') undoLastWrite();
      if (action === 'retry-save') retrySaveCurrent();
      if (action === 'discard-draft') discardDraft();
      if (action === 'add-comment') beginAnnotation('comment');
      if (action === 'add-highlight') beginAnnotation('highlight');
      if (action === 'add-underline') beginAnnotation('underline');
      if (action === 'selection-to-notebook') appendCurrentSelectionToNotebook();
      if (action === 'clear-selection') {
        state.selection = null;
        render();
      }
      if (action === 'save-annotation') saveAnnotationComposer();
      if (action === 'cancel-annotation') {
        state.annotationComposer = null;
        state.selection = null;
        render();
      }
      if (action === 'focus-annotation') focusAnnotation(annotationIdValue);
      if (action === 'edit-annotation') {
        state.annotationEditorId = annotationIdValue;
        render();
      }
      if (action === 'save-annotation-edit') updateAnnotationNote(annotationIdValue);
      if (action === 'reply-annotation') {
        state.annotationReplyId = annotationIdValue;
        render();
      }
      if (action === 'add-annotation-reply') addAnnotationReply(annotationIdValue);
      if (action === 'toggle-annotation-resolved') toggleAnnotationResolved(annotationIdValue);
      if (action === 'delete-annotation') deleteAnnotation(annotationIdValue);
      if (action === 'undo-annotation') undoAnnotationChange();
      if (action === 'annotation-to-notebook') annotationToNotebook(annotationIdValue);
      if (action === 'new-notebook') createNotebookAction();
      if (action === 'select-notebook') selectNotebook(element.dataset.notebookId);
      if (action === 'delete-notebook') deleteActiveNotebook();
      if (action === 'toggle-notebook-preview') {
        state.notebookPreview = !state.notebookPreview;
        render();
      }
      if (action === 'notebook-add-reference') appendCurrentSelectionToNotebook();
      if (action === 'download-notebook') downloadNotebook();
      if (action === 'export-notebook-resource') exportNotebookToResource();
      if (action === 'copilot-submit') {
        const prompt = root.querySelector('[data-copilot-prompt]')?.value || '';
        state.copilot.prompt = prompt;
        askCopilot(prompt);
      }
      if (action === 'copilot-task') askCopilot(copilotTaskPrompt(element.dataset.copilotTask));
      if (action === 'retry-copilot') retryCopilot();
      if (action === 'prepare-copilot-apply') prepareCopilotApply(element.dataset.messageId);
      if (action === 'cancel-copilot-apply') {
        state.copilot.suggestion = null;
        render();
      }
      if (action === 'confirm-copilot-apply') confirmCopilotApply();
      if (action === 'copilot-to-notebook') copilotToNotebook(element.dataset.messageId);
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

  const copilotPrompt = root.querySelector('[data-copilot-prompt]');
  if (copilotPrompt) {
    copilotPrompt.addEventListener('input', () => {
      state.copilot.prompt = copilotPrompt.value;
    });
    copilotPrompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        state.copilot.prompt = copilotPrompt.value;
        askCopilot(copilotPrompt.value);
      }
    });
  }

  const contextFile = root.querySelector('[data-context-file]');
  if (contextFile) contextFile.addEventListener('change', () => {
    state.copilot.includeFile = contextFile.checked;
  });
  const contextSelection = root.querySelector('[data-context-selection]');
  if (contextSelection) contextSelection.addEventListener('change', () => {
    state.copilot.includeSelection = contextSelection.checked;
  });
  const contextLimit = root.querySelector('[data-context-limit]');
  if (contextLimit) contextLimit.addEventListener('change', () => {
    state.copilot.contextLimit = Number(contextLimit.value) || 16000;
  });

  const viewer = root.querySelector('.viewer-scroll');
  if (viewer && state.current) {
    viewer.scrollTop = state.current.scrollTop || 0;
    viewer.addEventListener('mouseup', () => window.setTimeout(() => captureViewerSelection(viewer), 0));
    viewer.addEventListener('keyup', () => window.setTimeout(() => captureViewerSelection(viewer), 0));
    viewer.addEventListener('scroll', () => {
      if (!state.current) return;
      state.current.scrollTop = viewer.scrollTop;
      saveSession();
    }, { passive: true });
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

render();
hana.ready({ surface: 'page', pluginId: 'hana-reader', version: PLUGIN_VERSION });
restoreSession();
