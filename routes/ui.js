import { createHash } from 'node:crypto';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const ASSET_REVISION = '0.8.5';

export default function registerPluginUiRoutes(app, ctx) {
  app.get('/page', (c) => c.html(renderShell(c, ctx)));

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
