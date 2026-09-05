import { highlightCode, renderMarkdown, sanitizeHtmlPreview } from './markdown-engine.js';
import { mountMarkdownEditor } from './markdown-editor.js';

const PROTOCOL = 'hana.plugin.ui';
const VERSION = 1;
const SURFACE_SESSION_QUERY = 'pluginSurfaceSession';
const SURFACE_SESSION_HEADER = 'X-Hana-Plugin-Surface-Session';
const PLUGIN_VERSION = '0.7.2';
const MAX_EDIT_BYTES = 512 * 1024;
const SESSION_STORAGE_KEY = 'hana-reader:last-session:v1';
const LAYOUT_STORAGE_KEY = 'hana-reader:layout:v1';

let sequence = 0;
let activeMarkdownEditor = null;
let pendingMarkdownEditor = null;
let editorGeneration = 0;
let autoSaveTimer = null;
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

function updateEditorStatus() {
  const status = root.querySelector('#editor-status');
  if (!status || !state.current) return;
  if (state.current.conflict) {
    status.textContent = '检测到外部修改 · 尚未写回';
  } else if (state.current.draftDirty) {
    status.textContent = '本地草稿 · 尚未写回';
  } else {
    status.textContent = '编辑中 · 未修改';
  }
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
  await destroyMarkdownEditor();
  state.editing = false;
  state.busy = true;
  state.error = '';
  state.status = `正在打开 ${node.name}…`;
  render();

  try {
    const result = await apiJson('resources/read', { resource: node.resource });
    state.current = {
      node,
      name: node.name,
      language: inferLanguage(node.name),
      binary: Boolean(result.binary),
      content: result.content || '',
      version: result.version || null,
      editable: inferLanguage(node.name) === 'markdown' && byteLength(result.content || '') <= MAX_EDIT_BYTES,
      baseSha256: await sha256Text(result.content || ''),
      htmlPreview: false,
      scrollTop: Number.isFinite(Number(options.scrollTop)) ? Math.max(0, Number(options.scrollTop)) : 0,
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
  const leading = directory ? (node.expanded ? '⌄' : '›') : '';
  const icon = directory ? (node.expanded ? '▾' : '▸') : '·';
  const disabled = node.unsupported ? ' disabled' : '';
  const nested = directory && node.expanded
    ? `<div class="tree-nested">${node.items.length
      ? node.items.map((child) => renderTreeNode(child, depth + 1, index)).join('')
      : '<div class="tree-empty">空文件夹</div>'}</div>`
    : '';

  return `<button class="tree-row ${selected ? 'selected' : ''}${disabled}" data-action="${action}" data-node-id="${node.id}" style="--depth:${depth}" title="${escapeHtml(node.name)}">
    <span class="tree-chevron">${leading}</span>
    <span class="tree-icon ${directory ? 'folder' : 'file'}">${icon}</span>
    <span class="tree-name">${escapeHtml(node.name)}</span>
    <span class="tree-size">${node.isDirectory ? '' : escapeHtml(formatSize(node.size))}</span>
  </button>${nested}`;
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
  return `<div class="tree-root-name"><span class="folder-dot">◈</span>${escapeHtml(state.rootNode.name)}</div>
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
  if (!state.current?.draftDirty || !state.editing) return;
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = null;
    saveCurrent({ preserveEditor: true });
  }, 500);
}

async function flushAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  if (state.editing && state.current?.draftDirty) {
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

  state.busy = true;
  state.error = '';
  state.status = `正在自动保存 ${state.current.name}…`;
  if (!preserveEditor) render();
  try {
    const current = state.current;
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
    state.status = `${languageLabel(current.language)} · 已自动保存`;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = '自动保存失败，请重试';
  } finally {
    state.busy = false;
    updateEditorStatus();
    if (!preserveEditor) {
      await destroyMarkdownEditor();
      render();
      await mountCurrentEditor();
    } else if (state.current?.draftDirty) {
      scheduleAutoSave();
    }
  }
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
    return `<div class="reader-modebar"><span id="editor-status" class="editor-status">编辑中 · 未修改</span><div class="reader-mode-actions"><button class="button ghost" data-action="read-mode">只读</button><button class="button primary" disabled>编辑</button>${current.undo ? '<button class="button ghost" data-action="undo-write">回撤</button>' : ''}</div></div>
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

  return `<div class="reader-modebar"><div class="reader-mode-actions"><button class="button primary" disabled>只读</button>${canEdit ? '<button class="button ghost" data-action="edit-file">编辑</button>' : ''}${current.language === 'html' && byteLength(current.content) <= MAX_EDIT_BYTES ? `<button class="button ghost" data-action="toggle-html-preview">${current.htmlPreview ? '查看源码' : '安全预览'}</button>` : ''}${current.undo ? '<button class="button ghost" data-action="undo-write">回撤</button>' : ''}${editorAction}</div></div>
  <div class="viewer-scroll">${body}</div>`;
}

function renderCopilot() {
  if (state.rightCollapsed) {
    return '<aside class="copilot-panel is-collapsed"><button class="panel-collapse" data-action="toggle-right" title="展开阅读助手">‹</button></aside>';
  }
  return `<aside class="copilot-panel">
    <div class="copilot-heading"><span class="copilot-orb">✦</span><div><h2>Copilot</h2><p>阅读助手</p></div><span class="coming-badge">M1</span><button class="panel-collapse" data-action="toggle-right" title="折叠阅读助手">›</button></div>
    <div class="copilot-empty">
      <div class="copilot-spark">✧</div>
      <h3>先读，再问</h3>
      <p>下一阶段将支持总结当前文件、解释选中内容，以及提取公式和关键概念。</p>
    </div>
    <div class="copilot-rule"></div>
    <div class="copilot-note"><span>⌁</span> AI 上下文将由你明确选择，不默认读取整个项目。</div>
  </aside>`;
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
  const nodeIndex = new Map();
  const tree = state.rootNode ? renderTree() : renderTree();
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
    <footer class="bottom-bar"><span>本地优先 · ResourceIO</span><span>编辑自动保存 · 可回撤上一步</span></footer>
  </div>`;

  root.querySelectorAll('[data-resizer]').forEach((element) => {
    element.addEventListener('pointerdown', (event) => beginResize(element.dataset.resizer, event));
  });

  root.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', () => {
      const action = element.dataset.action;
      const node = nodeIndex.get(element.dataset.nodeId);
      if (action === 'pick') requestTransition('重新选择文件夹', chooseFolder);
      if (action === 'refresh') requestTransition('刷新目录', refreshRoot);
      if (action === 'toggle') requestTransition(`切换到目录 ${node?.name || ''}`, () => toggleDirectory(node));
      if (action === 'open') requestTransition(`打开 ${node?.name || '其他文件'}`, () => openFile(node));
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
      if (action === 'edit-file') startEditing();
      if (action === 'read-mode') requestTransition('切换为只读', stopEditing);
      if (action === 'toggle-html-preview') {
        state.current.htmlPreview = !state.current.htmlPreview;
        render();
      }
      if (action === 'undo-write') undoLastWrite();
    });
  });

  const viewer = root.querySelector('.viewer-scroll');
  if (viewer && state.current) {
    viewer.scrollTop = state.current.scrollTop || 0;
    viewer.addEventListener('scroll', () => {
      if (!state.current) return;
      state.current.scrollTop = viewer.scrollTop;
      saveSession();
    }, { passive: true });
  }

  requestAnimationFrame(() => hana.ui.resize({ height: Math.max(680, root.scrollHeight) }));
}

render();
hana.ready({ surface: 'page', pluginId: 'hana-reader', version: PLUGIN_VERSION });
restoreSession();
