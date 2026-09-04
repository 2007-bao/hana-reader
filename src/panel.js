import { highlightCode, renderMarkdown } from './markdown-engine.js';
import { mountMarkdownEditor } from './markdown-editor.js';

const PROTOCOL = 'hana.plugin.ui';
const VERSION = 1;
const SURFACE_SESSION_QUERY = 'pluginSurfaceSession';
const SURFACE_SESSION_HEADER = 'X-Hana-Plugin-Surface-Session';
const PLUGIN_VERSION = '0.4.0';
const MAX_EDIT_BYTES = 512 * 1024;
const SESSION_STORAGE_KEY = 'hana-reader:last-session:v1';

let sequence = 0;
let activeMarkdownEditor = null;
let pendingMarkdownEditor = null;
let editorGeneration = 0;
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
  status: '请选择一个文件夹开始阅读',
  error: '',
};

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

function updateEditorDiff() {
  const diff = root.querySelector('#editor-diff');
  if (!diff || !state.current) return;
  diff.textContent = createLineDiff(state.current.content, currentDraft());
}

function createLineDiff(before, after) {
  const oldLines = String(before || '').replace(/\r\n?/g, '\n').split('\n');
  const newLines = String(after || '').replace(/\r\n?/g, '\n').split('\n');
  const rows = [];
  const width = newLines.length;
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      rows.push(`  ${oldLines[oldIndex]}`);
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    if (oldIndex < oldLines.length) rows.push(`- ${oldLines[oldIndex++]}`);
    if (newIndex < newLines.length) rows.push(`+ ${newLines[newIndex++]}`);
  }
  return rows.join('\n') || '没有检测到修改。';
}

async function mountCurrentEditor() {
  if (!state.current || !state.editing) return;
  updateEditorStatus();
  updateEditorDiff();
  if (state.current.language === 'markdown') {
    const generation = ++editorGeneration;
    const session = state.current;
    const promise = mountMarkdownEditor(root.querySelector('#markdown-editor'), currentDraft(), {
      onMarkdownChange(markdown) {
        if (generation !== editorGeneration || state.current !== session || !state.editing) return;
        state.current.draftContent = markdown;
        state.current.draftDirty = markdown !== state.current.content;
        updateEditorStatus();
        updateEditorDiff();
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
  textarea.addEventListener('input', () => {
    if (!state.current || !state.editing) return;
    state.current.draftContent = textarea.value;
    state.current.draftDirty = textarea.value !== state.current.content;
    updateEditorStatus();
    updateEditorDiff();
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
  state.current.diffVisible = false;
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

function requestTransition(label, transition) {
  const runTransition = async () => {
    if (state.editing) {
      await destroyMarkdownEditor();
      state.editing = false;
    }
    await transition();
  };
  if (state.editing && state.current?.draftDirty) {
    pendingTransition = runTransition;
    const existing = root.querySelector('#dirty-guard');
    if (existing) existing.remove();
    root.insertAdjacentHTML('beforeend', `<div id="dirty-guard" class="dirty-guard" role="dialog" aria-modal="true"><div class="dirty-guard-card"><strong>本地修改尚未写回</strong><p>${escapeHtml(label)}会丢弃当前草稿。请先查看 Diff 并写回，或明确放弃修改。</p><div class="dirty-guard-actions"><button class="button ghost" data-guard-action="cancel">取消</button><button class="button danger" data-guard-action="discard">放弃并继续</button></div></div></div>`);
    root.querySelector('[data-guard-action="cancel"]')?.addEventListener('click', () => {
      pendingTransition = null;
      root.querySelector('#dirty-guard')?.remove();
    });
    root.querySelector('[data-guard-action="discard"]')?.addEventListener('click', async () => {
      const next = pendingTransition;
      pendingTransition = null;
      root.querySelector('#dirty-guard')?.remove();
      if (next) await next();
    });
    return;
  }
  runTransition();
}

async function stopEditing() {
  await destroyMarkdownEditor();
  state.editing = false;
  if (state.current) {
    delete state.current.draftContent;
    delete state.current.draftDirty;
    delete state.current.diffVisible;
    delete state.current.conflict;
  }
  render();
}

async function showEditorDiff() {
  if (!state.current || state.busy) return;
  await destroyMarkdownEditor();
  state.current.diffVisible = !state.current.diffVisible;
  render();
  await mountCurrentEditor();
}

async function saveCurrent() {
  if (!state.current || state.busy || !state.current.draftDirty) return;
  if (!state.current.diffVisible) {
    await showEditorDiff();
    return;
  }

  state.busy = true;
  state.error = '';
  state.status = `正在安全写回 ${state.current.name}…`;
  render();
  try {
    const current = state.current;
    const draft = currentDraft();
    const result = await apiJson('resources/write', {
      resource: current.node.resource,
      content: draft,
      expectedVersion: current.version,
      baseSha256: current.baseSha256,
    });
    current.undo = { content: current.content, version: result.version };
    current.content = draft;
    current.draftContent = draft;
    current.draftDirty = false;
    current.diffVisible = false;
    current.conflict = null;
    current.version = result.version || current.version;
    current.baseSha256 = result.sha256 || await sha256Text(current.content);
    state.status = `${languageLabel(current.language)} · 已安全写回`;
  } catch (error) {
    if (error.status === 409 && error.payload?.conflict) {
      state.current.conflict = {
        content: error.payload.content || '',
        version: error.payload.version || null,
        sha256: error.payload.sha256 || null,
      };
      state.current.diffVisible = true;
      state.status = '检测到外部修改，请先处理冲突';
    } else {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = '写回失败';
    }
  } finally {
    state.busy = false;
    await destroyMarkdownEditor();
    render();
    await mountCurrentEditor();
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

async function reloadRemoteVersion() {
  const current = state.current;
  if (!current?.conflict || state.busy) return;
  await destroyMarkdownEditor();
  current.content = current.conflict.content;
  current.version = current.conflict.version;
  current.baseSha256 = current.conflict.sha256 || await sha256Text(current.content);
  current.draftContent = current.content;
  current.draftDirty = false;
  current.conflict = null;
  current.diffVisible = false;
  state.status = `${languageLabel(current.language)} · 已载入远端版本`;
  render();
  await mountCurrentEditor();
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
  const title = escapeHtml(current.name);
  const language = languageLabel(current.language);
  if (state.editing) {
    const editorMarkup = current.language === 'markdown'
      ? '<div id="markdown-editor" class="markdown-editor" aria-label="Markdown 所见即所得编辑器"></div>'
      : `<textarea id="source-editor" class="source-editor" spellcheck="false" aria-label="${language} 源码编辑器"></textarea>`;
    const conflictMarkup = current.conflict
      ? '<div class="conflict-notice"><strong>远端文件已变化</strong><span>为避免覆盖他人修改，本次写回已停止。</span><button class="button ghost" data-action="reload-remote">载入远端版本</button></div>'
      : '';
    const diffMarkup = current.diffVisible
      ? `<details class="diff-panel" open><summary>修改 Diff（写回前预览）</summary><pre id="editor-diff"></pre>${current.conflict ? `<div class="remote-diff"><strong>远端当前版本</strong><pre>${escapeHtml(createLineDiff(current.content, current.conflict.content))}</pre></div>` : ''}</details>`
      : '';
    return `<div class="reader-header">
      <div class="file-heading"><span class="file-kind">${current.language === 'markdown' ? 'M↓' : '{}'}</span><div><h2>${title}</h2><p>${language} · ${current.language === 'markdown' ? '所见即所得' : '源码编辑'}</p></div></div>
      <div class="reader-header-actions"><span id="editor-status" class="editor-status">编辑中 · 未修改</span><button class="button ghost" data-action="show-diff">${current.diffVisible ? '收起 Diff' : '查看 Diff'}</button>${current.draftDirty && current.diffVisible && !current.conflict ? '<button class="button primary" data-action="save-file">确认写回</button>' : ''}${current.undo ? '<button class="button ghost" data-action="undo-write">撤销上次写回</button>' : ''}<button class="button ghost" data-action="exit-editor">退出编辑</button></div>
    </div>
    ${conflictMarkup}
    <div class="editor-scroll">${editorMarkup}${diffMarkup}</div>`;
  }

  const body = current.binary
    ? `<div class="binary-placeholder"><div class="placeholder-icon">◇</div><h3>暂不预览二进制文件</h3><p>当前阶段只面向文本与代码阅读。</p></div>`
    : current.language === 'markdown'
      ? `<article class="markdown-body">${renderMarkdown(current.content)}</article>`
      : renderCodeViewer(current.content, current.language);
  const editorAction = current.language === 'markdown' && current.editable
    ? '<button class="button ghost" data-action="edit-file">所见即所得编辑</button>'
    : current.language === 'markdown'
      ? '<span class="editor-status">文件超过 512 KB，仅只读预览</span>'
      : '<button class="button ghost" data-action="edit-file">编辑源码</button>';

  return `<div class="reader-header">
    <div class="file-heading"><span class="file-kind">${current.language === 'markdown' ? 'M↓' : '{}'}</span><div><h2>${title}</h2><p>${language} · 只读预览</p></div></div>
    <div class="reader-header-actions">${editorAction}<span class="read-only-badge">READ ONLY</span></div>
  </div>
  <div class="viewer-scroll">${body}</div>`;
}

function renderCopilot() {
  return `<aside class="copilot-panel">
    <div class="copilot-heading"><span class="copilot-orb">✦</span><div><h2>Copilot</h2><p>阅读助手</p></div><span class="coming-badge">M1</span></div>
    <div class="copilot-empty">
      <div class="copilot-spark">✧</div>
      <h3>先读，再问</h3>
      <p>下一阶段将支持总结当前文件、解释选中内容，以及提取公式和关键概念。</p>
    </div>
    <div class="copilot-rule"></div>
    <div class="copilot-note"><span>⌁</span> AI 上下文将由你明确选择，不默认读取整个项目。</div>
  </aside>`;
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
    <header class="topbar">
      <div class="brand"><span class="brand-mark">阅</span><div><strong>Hana Reader</strong><small>AI 产物审阅工作台 · v${PLUGIN_VERSION}</small></div></div>
      <div class="top-actions"><span class="status ${state.error ? 'error' : ''}">${escapeHtml(state.error || state.status)}</span><button class="button ghost" data-action="refresh" ${state.rootNode && !state.busy && !state.restoring ? '' : 'disabled'}>↻ 刷新</button><button class="button primary" data-action="pick" ${state.busy || state.restoring ? 'disabled' : ''}>选择文件夹</button></div>
    </header>
    <div class="workspace">
      <aside class="file-panel">
        <div class="panel-heading"><div><span class="eyebrow">WORKSPACE</span><h2>项目文件</h2></div><span class="panel-count">${state.rootNode ? state.rootNode.items.length : '—'}</span></div>
        <div class="tree-scroll">${tree}</div>
        <div class="file-panel-footer"><span class="legend-dot"></span> M0 只读模式</div>
      </aside>
      <main class="reader-panel">${renderReaderPane()}</main>
      ${renderCopilot()}
    </div>
    <footer class="bottom-bar"><span>本地优先 · ResourceIO</span><span>S2 所见即所得编辑预览 · 尚未写回文件</span></footer>
  </div>`;

  root.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', () => {
      const action = element.dataset.action;
      const node = nodeIndex.get(element.dataset.nodeId);
      if (action === 'pick') requestTransition('重新选择文件夹', chooseFolder);
      if (action === 'refresh') requestTransition('刷新目录', refreshRoot);
      if (action === 'toggle') requestTransition(`切换到目录 ${node?.name || ''}`, () => toggleDirectory(node));
      if (action === 'open') requestTransition(`打开 ${node?.name || '其他文件'}`, () => openFile(node));
      if (action === 'edit-file') startEditing();
      if (action === 'exit-editor') requestTransition('退出编辑', stopEditing);
      if (action === 'show-diff') showEditorDiff();
      if (action === 'save-file') saveCurrent();
      if (action === 'undo-write') undoLastWrite();
      if (action === 'reload-remote') requestTransition('载入远端版本', reloadRemoteVersion);
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
