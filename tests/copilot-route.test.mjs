import assert from 'node:assert/strict';
import test from 'node:test';

import registerPluginUiRoutes from '../routes/ui.js';

function captureRoutes(ctx = {}) {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
  registerPluginUiRoutes(app, { pluginId: 'hana-reader', ...ctx });
  return routes;
}

function contextFor(input, pluginCtx, requestContext = null) {
  return {
    req: { json: async () => input },
    get(name) {
      if (name === 'pluginCtx') return pluginCtx;
      if (name === 'pluginRequestContext') return requestContext;
      return undefined;
    },
    json: (body, status = 200) => ({ body, status }),
  };
}

test('Copilot route requires a prompt before touching the model bus', async () => {
  let called = false;
  const pluginCtx = { pluginId: 'hana-reader', bus: { request: async () => { called = true; } } };
  const route = captureRoutes({ bus: pluginCtx.bus }).get('POST /copilot/ask');
  const result = await route(contextFor({ prompt: '   ' }, pluginCtx));

  assert.equal(result.status, 400);
  assert.match(result.body.error, /输入一个问题/);
  assert.equal(called, false);
});

test('Copilot route sends only explicit context and normalizes model output', async () => {
  const calls = [];
  const bus = {
    async request(type, payload) {
      calls.push({ type, payload });
      return { output: { content: [{ type: 'text', text: '回答内容' }] } };
    },
  };
  const pluginCtx = { pluginId: 'hana-reader', bus };
  const route = captureRoutes({ bus }).get('POST /copilot/ask');
  const result = await route(contextFor({
    prompt: '请解释',
    file: { name: 'notes.md', language: 'markdown', content: '# 标题' },
    selection: null,
    history: [{ role: 'assistant', content: '之前回答' }, { role: 'system', content: '不应发送' }],
  }, pluginCtx));

  assert.equal(result.status, 200);
  assert.equal(result.body.text, '回答内容');
  assert.equal(calls[0].type, 'model:sample-text');
  assert.equal(calls[0].payload.pluginId, 'hana-reader');
  assert.equal(calls[0].payload.messages.length, 2);
  assert.equal(calls[0].payload.messages[0].content, '之前回答');
  assert.match(calls[0].payload.messages[1].content, /当前文件：notes\.md/);
  assert.doesNotMatch(calls[0].payload.messages[1].content, /\[object Object\]/);
});

test('Copilot route clips oversized file context and reports truncation', async () => {
  let payload;
  const bus = {
    async request(_type, value) {
      payload = value;
      return { text: 'ok' };
    },
  };
  const pluginCtx = { pluginId: 'hana-reader', bus };
  const route = captureRoutes({ bus }).get('POST /copilot/ask');
  const result = await route(contextFor({
    prompt: '总结',
    file: { name: 'large.md', content: 'x'.repeat(30000) },
  }, pluginCtx));

  assert.equal(result.status, 200);
  assert.equal(result.body.truncated.file, true);
  assert.match(payload.messages.at(-1).content, /上下文已截断/);
});

test('Copilot route prefers request-scoped bus and reports unavailable model access', async () => {
  const scopedCalls = [];
  const scopedBus = { request: async (...args) => { scopedCalls.push(args); return { text: 'scoped' }; } };
  const pluginCtx = { pluginId: 'hana-reader', bus: null };
  const route = captureRoutes().get('POST /copilot/ask');
  const result = await route(contextFor({ prompt: '问题', selection: { content: '选区' } }, pluginCtx, { bus: scopedBus }));

  assert.equal(result.status, 200);
  assert.equal(result.body.text, 'scoped');
  assert.equal(scopedCalls[0][0], 'model:sample-text');

  const unavailable = await route(contextFor({ prompt: '问题' }, { pluginId: 'hana-reader' }));
  assert.equal(unavailable.status, 503);
});
