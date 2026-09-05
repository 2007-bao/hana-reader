import assert from 'node:assert/strict';
import test from 'node:test';

import registerPluginUiRoutes from '../routes/ui.js';

function captureRoutes(resources) {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
  registerPluginUiRoutes(app, { pluginId: 'hana-reader', resources });
  return routes;
}

function contextFor(input, resources) {
  return {
    req: { json: async () => input },
    get: () => ({ resources }),
    json: (body, status = 200) => ({ body, status }),
  };
}

const resource = { kind: 'local-file', path: 'C:\\workspace\\notes.md' };

test('read route returns text and identifies binary content', async () => {
  const resources = {
    async stat() { return { version: { size: 3 } }; },
    async read() { return { resourceKey: 'notes', version: { mtimeMs: 1 }, content: new TextEncoder().encode('abc') }; },
  };
  const route = captureRoutes(resources).get('POST /resources/read');
  const result = await route(contextFor({ resource }, resources));
  assert.equal(result.status, 200);
  assert.equal(result.body.binary, false);
  assert.equal(result.body.content, 'abc');

  const binaryResources = {
    async stat() { return { version: { size: 3 } }; },
    async read() { return { content: new Uint8Array([65, 0, 66]) }; },
  };
  const binaryRoute = captureRoutes(binaryResources).get('POST /resources/read');
  const binary = await binaryRoute(contextFor({ resource }, binaryResources));
  assert.equal(binary.status, 200);
  assert.equal(binary.body.binary, true);
  assert.equal(binary.body.content, null);
});

test('read route enforces the byte limit even when stat has no size', async () => {
  const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
  const resources = {
    async stat() { return { version: {} }; },
    async read() { return { content: oversized }; },
  };
  const route = captureRoutes(resources).get('POST /resources/read');
  const result = await route(contextFor({ resource }, resources));
  assert.equal(result.status, 413);
  assert.match(result.body.error, /2 MB/);
});
