import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    get: () => undefined,
    json: (body, status = 200) => ({ body, status }),
  };
}

const resource = { kind: 'local-file', path: 'C:\\workspace\\notes.md' };
const version = { mtimeMs: 10, size: 8 };
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('safe write route requires an expected version and forwards text content', async () => {
  const calls = [];
  const resources = {
    async read() {
      return { content: new TextEncoder().encode('original'), version };
    },
    async writeExpectedVersion(...args) {
      calls.push(args);
      return { ok: true, version: { mtimeMs: 11, size: 9 } };
    },
  };
  const route = captureRoutes(resources).get('POST /resources/write');
  const result = await route(contextFor({ resource, content: 'updated', expectedVersion: version, baseSha256: hash('original') }, resources));

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.deepEqual(calls[0].slice(0, 3), [resource, 'updated', version]);
  assert.equal(result.body.sha256, hash('updated'));
});

test('safe write route returns the latest content on a version conflict', async () => {
  const resources = {
    async writeExpectedVersion() {
      return { conflict: true, version: { mtimeMs: 12, size: 10 } };
    },
    async read() {
      return { content: new TextEncoder().encode('remote'), version: { mtimeMs: 12, size: 6 } };
    },
  };
  const route = captureRoutes(resources).get('POST /resources/write');
  const result = await route(contextFor({ resource, content: 'local', expectedVersion: version, baseSha256: hash('base') }, resources));

  assert.equal(result.status, 409);
  assert.equal(result.body.conflict, true);
  assert.equal(result.body.content, 'remote');
  assert.deepEqual(result.body.version, { mtimeMs: 12, size: 6 });
  assert.equal(result.body.sha256, hash('remote'));
});

test('safe write route rejects writes without a version baseline', async () => {
  let called = false;
  const resources = {
    async writeExpectedVersion() { called = true; },
  };
  const route = captureRoutes(resources).get('POST /resources/write');
  const result = await route(contextFor({ resource, content: 'unsafe' }, resources));

  assert.equal(result.status, 400);
  assert.match(result.body.error, /expectedVersion/);
  assert.equal(called, false);
});
