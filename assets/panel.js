const PROTOCOL = 'hana.plugin.ui';
const VERSION = 1;
const SURFACE_SESSION_QUERY = 'pluginSurfaceSession';
const SURFACE_SESSION_HEADER = 'X-Hana-Plugin-Surface-Session';
const SESSION_STORAGE_KEY = 'hana-reader:last-session:v1';

let sequence = 0;
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
    throw new Error(payload?.error || `资源请求失败（${response.status}）`);
  }
  return payload;
}

async function chooseFolder() {
  if (state.busy || state.restoring) return;
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

function safeMarkdownUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? candidate : '';
  } catch {
    return '';
  }
}

function inlineMarkdown(value) {
  const protectedSpans = [];
  const protect = (html) => {
    const marker = `\uE000${protectedSpans.length}\uE001`;
    protectedSpans.push(html);
    return marker;
  };

  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, (match, code) => protect(`<code>${code}</code>`));
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const safeUrl = safeMarkdownUrl(url);
    return protect(safeUrl
      ? `<a class="md-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `<span class="md-link" title="${escapeHtml(url)}">${label}</span>`);
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  for (let index = protectedSpans.length - 1; index >= 0; index -= 1) {
    const marker = `\uE000${index}\uE001`;
    html = html.replaceAll(marker, protectedSpans[index]);
  }
  return html;
}

function parseMarkdownTableRow(line) {
  const value = String(line || '').trim();
  if (!value.includes('|')) return null;
  const normalized = value.replace(/^\|/, '').replace(/\|$/, '');
  const cells = normalized.split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableDelimiter(line) {
  const cells = parseMarkdownTableRow(line);
  return Boolean(cells?.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

function renderMarkdownTable(headers, rows) {
  const head = headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('');
  const body = rows.map((row) => `<tr>${headers.map((_, index) => `<td>${inlineMarkdown(row[index] || '')}</td>`).join('')}</tr>`).join('');
  return `<div class="markdown-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };

  const flushList = () => {
    if (!list) return;
    const tag = list.type === 'ordered' ? 'ol' : 'ul';
    output.push(`<${tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`);
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      if (!code) {
        code = { language: fence[1].trim() || 'text', lines: [] };
      } else {
        output.push(`<pre class="markdown-code"><code>${highlightCode(code.lines.join('\n'), code.language)}</code></pre>`);
        code = null;
      }
      continue;
    }

    if (code) {
      code.lines.push(line);
      continue;
    }

    const tableHeader = parseMarkdownTableRow(line);
    if (tableHeader && isMarkdownTableDelimiter(lines[index + 1])) {
      flushParagraph();
      flushList();
      const rows = [];
      index += 2;
      while (index < lines.length) {
        const row = parseMarkdownTableRow(lines[index]);
        if (!row) {
          index -= 1;
          break;
        }
        rows.push(row);
        index += 1;
      }
      output.push(renderMarkdownTable(tableHeader, rows));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      output.push('<hr>');
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || list.type !== 'unordered') {
        flushList();
        list = { type: 'unordered', items: [] };
      }
      const task = /^\[([ xX])\]\s+(.+)$/.exec(bullet[1]);
      list.items.push(task
        ? `<label class="task-item"><input type="checkbox" disabled ${task[1].toLowerCase() === 'x' ? 'checked' : ''}>${inlineMarkdown(task[2])}</label>`
        : inlineMarkdown(bullet[1]));
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list || list.type !== 'ordered') {
        flushList();
        list = { type: 'ordered', items: [] };
      }
      list.items.push(inlineMarkdown(ordered[1]));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    paragraph.push(inlineMarkdown(line));
  }

  if (code) {
    output.push(`<pre class="markdown-code"><code>${highlightCode(code.lines.join('\n'), code.language)}</code></pre>`);
  }
  flushParagraph();
  flushList();
  return output.join('') || '<p class="empty-document">这是一个空文件。</p>';
}

const keywordSets = {
  javascript: new Set('const let var function return if else for while class import from export async await new throw try catch typeof true false null undefined'.split(' ')),
  typescript: new Set('const let var function return if else for while class interface type import from export async await new throw try catch public private readonly true false null undefined'.split(' ')),
  python: new Set('def class return if elif else for while in import from as try except with lambda yield async await True False None and or not'.split(' ')),
  java: new Set('class public private protected static final void int long float double boolean new return if else for while try catch true false null'.split(' ')),
  cpp: new Set('include using namespace class struct public private protected const auto void int long float double bool return if else for while true false nullptr'.split(' ')),
  rust: new Set('fn let mut pub impl struct enum trait use mod match if else for while loop return true false self Self'.split(' ')),
  go: new Set('package import func var const type struct interface return if else for range go defer chan true false nil'.split(' ')),
  yaml: new Set('true false null yes no'.split(' ')),
  shell: new Set('if then else fi for in do done function case esac'.split(' ')),
};

function token(className, value) {
  return `<span class="${className}">${escapeHtml(value)}</span>`;
}

function highlightCode(source, language) {
  const normalized = String(language || 'text').toLowerCase();
  const keywords = keywordSets[normalized] || keywordSets[normalized === 'js' ? 'javascript' : normalized];
  const slashComments = ['javascript', 'typescript', 'java', 'cpp', 'rust', 'go', 'css'].includes(normalized);
  const hashComments = ['python', 'yaml', 'shell'].includes(normalized);
  let html = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if ((char === '"' || char === "'" || char === '`')) {
      let end = index + 1;
      let escaped = false;
      while (end < source.length) {
        const current = source[end];
        if (!escaped && current === char) {
          end += 1;
          break;
        }
        escaped = !escaped && current === '\\';
        if (current !== '\\') escaped = false;
        end += 1;
      }
      html += token('token-string', source.slice(index, end));
      index = end;
      continue;
    }

    if (slashComments && char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const boundary = end === -1 ? source.length : end + 2;
      html += token('token-comment', source.slice(index, boundary));
      index = boundary;
      continue;
    }

    if (slashComments && char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const boundary = end === -1 ? source.length : end;
      html += token('token-comment', source.slice(index, boundary));
      index = boundary;
      continue;
    }

    if (hashComments && char === '#') {
      const end = source.indexOf('\n', index);
      const boundary = end === -1 ? source.length : end;
      html += token('token-comment', source.slice(index, boundary));
      index = boundary;
      continue;
    }

    if (normalized === 'html' || normalized === 'xml') {
      if (source.startsWith('<!--', index)) {
        const end = source.indexOf('-->', index + 4);
        const boundary = end === -1 ? source.length : end + 3;
        html += token('token-comment', source.slice(index, boundary));
        index = boundary;
        continue;
      }
    }

    if (/\d/.test(char) && (index === 0 || /[^\w]/.test(source[index - 1]))) {
      const match = /^\d+(?:\.\d+)?/.exec(source.slice(index));
      if (match) {
        html += token('token-number', match[0]);
        index += match[0].length;
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$-]*/.exec(source.slice(index));
      if (match) {
        html += keywords?.has(match[0]) ? token('token-keyword', match[0]) : escapeHtml(match[0]);
        index += match[0].length;
        continue;
      }
    }

    html += escapeHtml(char);
    index += 1;
  }

  return html || '&nbsp;';
}

function renderCodeViewer(content, language) {
  return `<div class="code-viewer">${String(content || '').replace(/\r\n?/g, '\n').split('\n').map((line, index) => `
    <div class="code-line"><span class="line-number">${index + 1}</span><code>${highlightCode(line, language)}</code></div>`).join('')}</div>`;
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
  const body = current.binary
    ? `<div class="binary-placeholder"><div class="placeholder-icon">◇</div><h3>暂不预览二进制文件</h3><p>当前阶段只面向文本与代码阅读。</p></div>`
    : current.language === 'markdown'
      ? `<article class="markdown-body">${renderMarkdown(current.content)}</article>`
      : renderCodeViewer(current.content, current.language);

  return `<div class="reader-header">
    <div class="file-heading"><span class="file-kind">${current.language === 'markdown' ? 'M↓' : '{}'}</span><div><h2>${title}</h2><p>${language} · 只读预览</p></div></div>
    <span class="read-only-badge">READ ONLY</span>
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
      <div class="brand"><span class="brand-mark">阅</span><div><strong>Hana Reader</strong><small>AI 产物审阅工作台</small></div></div>
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
    <footer class="bottom-bar"><span>本地优先 · ResourceIO</span><span>编辑、Copilot 与批注将在后续阶段加入</span></footer>
  </div>`;

  root.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', () => {
      const action = element.dataset.action;
      const node = nodeIndex.get(element.dataset.nodeId);
      if (action === 'pick') chooseFolder();
      if (action === 'refresh') refreshRoot();
      if (action === 'toggle') toggleDirectory(node);
      if (action === 'open') openFile(node);
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
hana.ready({ surface: 'page', pluginId: 'hana-reader', version: '0.1.8' });
restoreSession();
