import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  const content = await fs.readFile(path.join(root, relativePath), 'utf8');
  return JSON.parse(content);
}

test('manifest declares a full-access reader page with read-only resource access', async () => {
  const manifest = await readJson('manifest.json');

  assert.equal(manifest.id, 'hana-reader');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.trust, 'full-access');
  assert.deepEqual(manifest.capabilities, ['resource.read']);
  assert.equal(manifest.contributes.page.route, '/page');
  assert.ok(manifest.ui.hostCapabilities.includes('resource.pick'));
  assert.ok(manifest.dev.scenarios.some((scenario) => scenario.id === 'open-page'));
});

test('M0 files exist and no write capability is declared', async () => {
  for (const relativePath of [
    'README.md',
    'COLLABORATION.md',
    'routes/ui.js',
    'assets/hana-bridge.js',
    'assets/panel.js',
    'assets/panel.css',
  ]) {
    await fs.access(path.join(root, relativePath));
  }

  const manifest = await readJson('manifest.json');
  assert.ok(!manifest.capabilities.includes('resource.write'));
});
