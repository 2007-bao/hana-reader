import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8');
const manifest = JSON.parse(await read('manifest.json'));
const packageJson = JSON.parse(await read('package.json'));
const lockJson = JSON.parse(await read('package-lock.json'));
const version = manifest.version;

assert.match(version, /^\d+\.\d+\.\d+$/, `Invalid plugin version: ${version}`);
assert.equal(packageJson.version, version, 'package.json version is out of sync');
assert.equal(lockJson.version, version, 'package-lock.json version is out of sync');
assert.equal(lockJson.packages?.['']?.version, version, 'package-lock root version is out of sync');

const checks = [
  ['src/panel.js', `const PLUGIN_VERSION = '${version}'`],
  ['routes/ui.js', `const ASSET_REVISION = '${version}'`],
];
for (const [relativePath, expected] of checks) {
  const content = await read(relativePath);
  assert.ok(content.includes(expected), `${relativePath} does not declare ${expected}`);
}

console.log(`version ${version} is consistent across manifest, package metadata, panel, and route`);
