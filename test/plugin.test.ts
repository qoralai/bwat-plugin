import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PLUGIN } from '../src/index.js';

test('the plugin names itself after its package', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string };
  expect(PLUGIN).toBe(pkg.name);
});
