import { createHash } from 'node:crypto';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_COPILOT_CONTEXT_CHARS = 24000;
const MAX_COPILOT_HISTORY_ITEMS = 12;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_DIRECTORIES = 1000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 8 * 1024 * 1024;
const ASSET_REVISION = '1.5.4';

export default function registerPluginUiRoutes(app, ctx) {
  app.get('/page', (c) => c.html(renderShell(c, ctx)));

  app.post('/resources/search', async (c) => {
    try {
      const input = await c.req.json();
      const resource = validateResource(input?.resource);
      const query = clipText(input?.query, 200).text.trim();
      if (!query) return c.json({ error: '请输入搜索内容。' }, 400);
      const pluginCtx = c.get('pluginCtx') || ctx;
      const result = await searchResources(pluginCtx.resources, resource, query, {
        caseSensitive: Boolean(input?.caseSensitive),
      });
      return c.json(result);
    } catch (error) {
      return c.json({ error: safeErrorMessage(error) }, error?.status === 403 ? 403 : 400);
    }
  });

  app.post('/copilot/ask', async (c) => {
    try {
      const input = await c.req.json();
      const prompt = clipText(input?.prompt, 4000).text.trim();
      if (!prompt) return c.json({ error: '请先输入一个问题。' }, 400);

      const file = normalizeCopilotContext(input?.file, MAX_COPILOT_CONTEXT_CHARS);
      const selection = normalizeCopilotContext(input?.selection, 12000);
      const history = normalizeCopilotHistory(input?.history);
      const contextParts = [];
      if (file?.content) contextParts.push(`【当前文件：${file.name || '未命名文件'}】\n${file.content}`);
      if (selection?.content) contextParts.push(`【用户选中的文本】\n${selection.content}`);
      const context = clipText(contextParts.join('\n\n'), MAX_COPILOT_CONTEXT_CHARS);
      const userMessage = contextParts.length
        ? `${prompt}\n\n请只基于以下由用户明确选择的上下文回答；如果上下文不足，请明确说出来。\n\n${context.text}`
        : prompt;

      const pluginCtx = c.get('pluginCtx') || ctx;
      const requestContext = c.get('pluginRequestContext');
      const bus = requestContext?.bus || pluginCtx?.bus;
      if (!bus || typeof bus.request !== 'function') {
        return c.json({ error: '当前 Hana 版本没有可用的文本模型接口。' }, 503);
      }

      const result = await bus.request('model:sample-text', {
        pluginId: pluginCtx?.pluginId || 'hana-reader',
        operation: 'hana-reader-copilot',
        systemPrompt: [
          '你是 Hana Reader 的阅读助手。',
          '回答要简洁、准确、可执行；不要假装看到了未提供的文件。',
          '如果用户要求修改 Markdown，请把可直接替换的结果放在一个 markdown 代码块中，并保留必要的 Markdown 结构。',
          '除非用户要求，不要输出冗长的思维过程。',
        ].join('\n'),
        messages: [...history, { role: 'user', content: userMessage }],
        maxTokens: 1600,
        temperature: 0.2,
      });
      const text = extractModelText(result);
      if (!text) return c.json({ error: '文本模型没有返回可显示的内容。' }, 502);
      return c.json({
        text,
        truncated: {
          file: Boolean(input?.file?.content && file?.truncated),
          selection: Boolean(input?.selection?.content && selection?.truncated),
          combined: context.truncated,
        },
      });
    } catch (error) {
      return c.json({ error: safeErrorMessage(error) }, error?.status === 403 ? 403 : 502);
    }
  });

  // M0 keeps the resource boundary on the server: the iframe never reads a host path directly.
  app.post('/resources/list', async (c) => {
    try {
      const input = await c.req.json();
      const resource = validateResource(input?.resource);
      const pluginCtx = c.get('pluginCtx') || ctx;
      const result = await pluginCtx.resources.list(resource);
      return c.json({
        resourceKey: result.resourceKey,
        resource: result.resource,
        items: result.items,
      });
    } catch (error) {
      return c.json({ error: safeErrorMessage(error) }, 400);
    }
  });

  app.post('/resources/write', async (c) => {
    try {
      const input = await c.req.json();
      const resource = validateResource(input?.resource);
      if (typeof input?.content !== 'string') throw new Error('Text content is required.');
      const contentBytes = new TextEncoder().encode(input.content).byteLength;
      if (contentBytes > MAX_READ_BYTES) {
        return c.json({ error: `文件超过 2 MB 写入上限（${contentBytes} bytes）。` }, 413);
      }
      if (!hasVersionField(input.expectedVersion)) {
        return c.json({ error: 'A non-empty expectedVersion is required for a safe write.' }, 400);
      }
      if (typeof input.baseSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.baseSha256)) {
        return c.json({ error: 'A baseSha256 is required for a safe write.' }, 400);
      }
      const pluginCtx = c.get('pluginCtx') || ctx;
      const latest = await pluginCtx.resources.read(resource);
      const latestBytes = toUint8Array(latest.content);
      const latestContent = latestBytes.subarray(0, 8192).includes(0) ? null : new TextDecoder().decode(latestBytes);
      if (latestContent === null || sha256(latestBytes) !== input.baseSha256) {
        return c.json({
          conflict: true,
          version: latest.version || null,
          sha256: sha256(latestBytes),
          content: latestContent,
        }, 409);
      }
      const result = await pluginCtx.resources.writeExpectedVersion(
        resource,
        input.content,
        input.expectedVersion,
        { purpose: 'hana-reader:safe-write' },
      );
      if (result?.conflict) {
        const conflicted = await pluginCtx.resources.read(resource);
        const conflictedBytes = toUint8Array(conflicted.content);
        const conflictedContent = conflictedBytes.subarray(0, 8192).includes(0) ? null : new TextDecoder().decode(conflictedBytes);
        return c.json({
          conflict: true,
          version: conflicted.version || result.version || null,
          sha256: sha256(conflictedBytes),
          content: conflictedContent,
        }, 409);
      }
      return c.json({ ok: true, version: result?.version || null, sha256: sha256(new TextEncoder().encode(input.content)) });
    } catch (error) {
      return c.json({ error: safeErrorMessage(error) }, error?.status === 403 ? 403 : 400);
    }
  });

  app.post('/resources/read', async (c) => {
    try {
      const input = await c.req.json();
      const resource = validateResource(input?.resource);
      const pluginCtx = c.get('pluginCtx') || ctx;
      const stat = await pluginCtx.resources.stat(resource);
      const size = stat?.version?.size;
      if (typeof size === 'number' && size > MAX_READ_BYTES) {
        return c.json({ error: `文件超过 2 MB 阅读上限（${size} bytes）。` }, 413);
      }
      const result = await pluginCtx.resources.read(resource);
      const bytes = toUint8Array(result.content);
      if (bytes.byteLength > MAX_READ_BYTES) {
        return c.json({ error: `文件超过 2 MB 阅读上限（${bytes.byteLength} bytes）。` }, 413);
      }
      const isBinary = bytes.subarray(0, 8192).includes(0);
      return c.json({
        resourceKey: result.resourceKey,
        resource: result.resource,
        version: result.version,
        binary: isBinary,
        content: isBinary ? null : new TextDecoder().decode(bytes),
      });
    } catch (error) {
      return c.json({ error: safeErrorMessage(error) }, 400);
    }
  });
}

async function searchResources(resources, rootResource, query, { caseSensitive = false } = {}) {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const queue = [{ resource: rootResource, relativePath: [] }];
  const results = [];
  let scannedFiles = 0;
  let scannedDirectories = 0;
  let scannedBytes = 0;
  let skippedFiles = 0;
  let truncated = false;

  while (queue.length && scannedDirectories < MAX_SEARCH_DIRECTORIES && scannedFiles < MAX_SEARCH_FILES && results.length < MAX_SEARCH_RESULTS && scannedBytes < MAX_SEARCH_TOTAL_BYTES) {
    const current = queue.shift();
    scannedDirectories += 1;
    let listed;
    try {
      listed = await resources.list(current.resource);
    } catch {
      skippedFiles += 1;
      continue;
    }
    for (const item of listed.items || []) {
      const child = item.resource || childResource(current.resource, item.name);
      if (!child) continue;
      const relativePath = [...current.relativePath, item.name];
      if (item.isDirectory) {
        queue.push({ resource: child, relativePath });
        continue;
      }
      if (scannedFiles >= MAX_SEARCH_FILES || results.length >= MAX_SEARCH_RESULTS) {
        truncated = true;
        break;
      }
      const size = Number(item.size);
      if (Number.isFinite(size) && size > MAX_SEARCH_FILE_BYTES) {
        truncated = true;
        continue;
      }
      let file;
      try {
        file = await resources.read(child);
      } catch {
        skippedFiles += 1;
        continue;
      }
      const bytes = toUint8Array(file.content);
      scannedFiles += 1;
      scannedBytes += bytes.byteLength;
      if (bytes.byteLength > MAX_SEARCH_FILE_BYTES || bytes.subarray(0, 8192).includes(0)) continue;
      const text = new TextDecoder().decode(bytes);
      const lines = text.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length && results.length < MAX_SEARCH_RESULTS; lineIndex += 1) {
        const line = lines[lineIndex];
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        const column = haystack.indexOf(needle);
        if (column < 0) continue;
        results.push({
          resource: child,
          name: item.name,
          relativePath,
          line: lineIndex + 1,
          column: column + 1,
          preview: searchPreview(line, column),
        });
      }
      if (results.length >= MAX_SEARCH_RESULTS) truncated = true;
    }
    if (queue.length && (scannedDirectories >= MAX_SEARCH_DIRECTORIES || scannedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_TOTAL_BYTES)) truncated = true;
  }
  if (queue.length) truncated = true;
  return { results, scannedFiles, scannedDirectories, scannedBytes, skippedFiles, truncated };
}

function searchPreview(line, column) {
  const raw = String(line || '');
  const clean = raw.trim();
  if (clean.length <= 180) return clean;
  const leading = raw.length - raw.trimStart().length;
  const start = Math.max(0, Math.min(column - leading, clean.length - 180));
  const end = Math.min(clean.length, start + 180);
  return `${start ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}

function childResource(parent, name) {
  if (!parent || typeof parent !== 'object' || typeof name !== 'string') return null;
  if (parent.kind === 'local-file') {
    const base = String(parent.path || '').replace(/[\\/]+$/, '');
    const separator = String(parent.path || '').includes('\\') ? '\\' : '/';
    return { ...parent, path: base ? `${base}${separator}${name}` : name };
  }
  if (parent.kind === 'mount') {
    const base = String(parent.path || '').replace(/\/+$/, '');
    return { ...parent, path: base ? `${base}/${name}` : `/${name}` };
  }
  return null;
}

function normalizeCopilotContext(value, maxChars) {
  if (!value || typeof value !== 'object') return null;
  const content = typeof value.content === 'string' ? value.content : '';
  if (!content) return null;
  const clipped = clipText(content, maxChars);
  return {
    name: typeof value.name === 'string' ? clipText(value.name, 240).text : '',
    language: typeof value.language === 'string' ? clipText(value.language, 80).text : '',
    content: clipped.text,
    truncated: clipped.truncated,
  };
}

function normalizeCopilotHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .slice(-MAX_COPILOT_HISTORY_ITEMS)
    .map((item) => ({ role: item.role, content: clipText(item.content, 6000).text }));
}

function clipText(value, maxChars) {
  const text = String(value || '');
  const limit = Math.max(1, Number(maxChars) || MAX_COPILOT_CONTEXT_CHARS);
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.max(1, Math.floor(limit * 0.82));
  const tail = Math.max(0, limit - head);
  return {
    text: `${text.slice(0, head)}\n\n[…上下文已截断，末尾内容…]\n\n${tail ? text.slice(-tail) : ''}`,
    truncated: true,
  };
}

function extractModelText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.outputText === 'string') return value.outputText.trim();
  if (typeof value.content === 'string') return value.content.trim();
  if (Array.isArray(value.content)) {
    return value.content.map((item) => typeof item === 'string' ? item : item?.text || '').filter(Boolean).join('\n').trim();
  }
  if (value.output) return extractModelText(value.output);
  if (value.result) return extractModelText(value.result);
  if (value.data) return extractModelText(value.data);
  return '';
}

function renderShell(c, ctx) {
  const hanaCss = c.req.query('hana-css') || '';
  const theme = c.req.query('hana-theme') || 'inherit';
  const token = c.req.query('token') || '';
  const assetBase = `/api/plugins/${encodeURIComponent(ctx.pluginId)}/assets`;
  const withAssetQuery = (url) => {
    const params = new URLSearchParams({ v: ASSET_REVISION });
    if (token) params.set('token', token);
    return `${url}?${params.toString()}`;
  };
  const panelCss = withAssetQuery(`${assetBase}/panel.css`);
  const panelJs = withAssetQuery(`${assetBase}/panel.js`);
  const title = 'Hana Reader';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ''}
  <link rel="stylesheet" href="${escapeAttr(panelCss)}">
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="page">
  <div id="root" data-surface="page"><div style="display:grid;place-items:center;min-height:100vh;color:#7c8790;font:13px system-ui,sans-serif">正在加载 Hana Reader…</div></div>
  <script>
    window.addEventListener('error', (event) => {
      const root = document.getElementById('root');
      if (!root) return;
      root.innerHTML = '<div style="display:grid;place-items:center;min-height:100vh;color:#b35b5b;font:13px system-ui,sans-serif;text-align:center;padding:24px">面板加载失败：' + (event.message || '前端资源错误') + '</div>';
    });
    window.addEventListener('unhandledrejection', (event) => {
      const root = document.getElementById('root');
      if (!root) return;
      const reason = event.reason && event.reason.message ? event.reason.message : '未处理的前端异常';
      root.innerHTML = '<div style="display:grid;place-items:center;min-height:100vh;color:#b35b5b;font:13px system-ui,sans-serif;text-align:center;padding:24px">面板加载失败：' + String(reason).replace(/[<>&]/g, '') + '</div>';
    });
  </script>
  <script type="module" src="${escapeAttr(panelJs)}"></script>
</body>
</html>`;
}

function validateResource(resource) {
  if (!resource || typeof resource !== 'object' || typeof resource.kind !== 'string') {
    throw new Error('A valid ResourceRef is required.');
  }
  const allowedKinds = new Set(['local-file', 'mount', 'session-file', 'resource', 'url']);
  if (!allowedKinds.has(resource.kind)) {
    throw new Error(`Unsupported resource kind: ${resource.kind}`);
  }
  return resource;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value || []);
}

function hasVersionField(version) {
  return version && typeof version === 'object' && ['mtimeMs', 'size', 'sha256', 'etag', 'sequence'].some((key) => version[key] !== undefined && version[key] !== null);
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value)).digest('hex');
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown resource error');
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, '&gt;');
}
