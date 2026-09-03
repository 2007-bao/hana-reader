const PROTOCOL = 'hana.plugin.ui';
const VERSION = 1;
const SURFACE_SESSION_QUERY = 'pluginSurfaceSession';
const SURFACE_SESSION_HEADER = 'X-Hana-Plugin-Surface-Session';

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

export const hana = {
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
