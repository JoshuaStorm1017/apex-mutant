import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TOOL_NAME, VERSION } from '../src/version.js';

test('the version reported in exports matches package.json', async () => {
  const packageJson = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(VERSION, packageJson.version, 'src/version.ts must be bumped with package.json — exports name this version as their provenance');
  assert.equal(TOOL_NAME, packageJson.name);
});
