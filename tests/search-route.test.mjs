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

test('resource search walks explicit child resources and returns line locations', async () => {
  const root = { kind: 'local-file', path: 'C:\\workspace' };
  const src = { kind: 'local-file', path: 'C:\\workspace\\src' };
  const readme = { kind: 'local-file', path: 'C:\\workspace\\README.md' };
  const app = {
    async list(resource) {
      if (resource.path === root.path) {
        return { items: [
          { name: 'src', isDirectory: true, resource: src },
          { name: 'README.md', isDirectory: false, size: 32, resource: readme },
        ] };
      }
      return { items: [{ name: 'panel.js', isDirectory: false, size: 32, resource: { kind: 'local-file', path: `${src.path}\\panel.js` } }] };
    },
    async read(resource) {
      return { content: new TextEncoder().encode(resource.path.endsWith('README.md') ? '# Hana Reader\nCopilot is ready\n' : 'const value = 1;\n// Copilot helper\n') };
    },
  };
  const route = captureRoutes(app).get('POST /resources/search');
  const result = await route(contextFor({ resource: root, query: 'copilot' }, app));

  assert.equal(result.status, 200);
  assert.equal(result.body.results.length, 2);
  assert.equal(result.body.results[0].line, 2);
  assert.equal(result.body.results[0].column, 1);
  assert.deepEqual(result.body.results[1].relativePath, ['src', 'panel.js']);
  assert.equal(result.body.truncated, false);
});

test('resource search skips binary files and supports case-sensitive matching', async () => {
  const root = { kind: 'mount', mountId: 'm1', path: '/' };
  const text = { kind: 'mount', mountId: 'm1', path: '/notes.txt' };
  const binary = { kind: 'mount', mountId: 'm1', path: '/image.bin' };
  const resources = {
    async list() {
      return { items: [
        { name: 'notes.txt', isDirectory: false, resource: text },
        { name: 'image.bin', isDirectory: false, resource: binary },
      ] };
    },
    async read(resource) {
      return { content: resource.path.endsWith('bin')
        ? new Uint8Array([0, 1, 2])
        : new TextEncoder().encode('Copilot\ncopilot\n') };
    },
  };
  const route = captureRoutes(resources).get('POST /resources/search');
  const insensitive = await route(contextFor({ resource: root, query: 'copilot' }, resources));
  const sensitive = await route(contextFor({ resource: root, query: 'copilot', caseSensitive: true }, resources));

  assert.equal(insensitive.body.results.length, 2);
  assert.equal(sensitive.body.results.length, 1);
  assert.equal(sensitive.body.results[0].line, 2);
});

test('resource search skips unreadable files instead of failing the whole scan', async () => {
  const root = { kind: 'local-file', path: 'C:\\workspace' };
  const resources = {
    async list() {
      return { items: [{ name: 'locked.md', isDirectory: false, resource: { kind: 'local-file', path: 'C:\\workspace\\locked.md' } }] };
    },
    async read() {
      throw new Error('permission denied');
    },
  };
  const route = captureRoutes(resources).get('POST /resources/search');
  const result = await route(contextFor({ resource: root, query: 'anything' }, resources));
  assert.equal(result.status, 200);
  assert.equal(result.body.results.length, 0);
  assert.equal(result.body.skippedFiles, 1);
});

test('resource search rejects an empty query', async () => {
  const resources = { async list() { throw new Error('should not list'); } };
  const route = captureRoutes(resources).get('POST /resources/search');
  const result = await route(contextFor({ resource: { kind: 'local-file', path: 'C:\\x' }, query: ' ' }, resources));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /搜索内容/);
});
