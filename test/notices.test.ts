import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script, no types
import { bundledPackages, embeddedNotices, noticesText } from '../scripts/notices.mjs';

// THIRD_PARTY_NOTICES.md must carry the licence of everything dist/bwat-plugin.js bundles.
describe('the third-party notices', () => {
  it('list exactly the bundled packages and the code they carry, as a build writes them', async () => {
    const { metafile } = await build({
      entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm',
      write: false, metafile: true, logLevel: 'silent', define: { __BWAT_VERSION__: '"0.0.0"' },
    });
    const packages: string[] = bundledPackages(metafile);
    expect(packages).toContain('node_modules/undici');
    const embedded = embeddedNotices(readFileSync('dist/bwat-plugin.js', 'utf8'));
    expect(embedded.map((e: { name: string }) => e.name)).toEqual(['formdata-polyfill', 'ws']);
    expect(readFileSync('THIRD_PARTY_NOTICES.md', 'utf8')).toBe(noticesText(packages, embedded, '.'));
  });

  it("keeps a nested package's whole path, so its own licence is read", () => {
    const metafile = { inputs: { 'node_modules/a/node_modules/@s/b/x.js': {}, 'node_modules/c/y.js': {}, 'src/z.ts': {} } };
    expect(bundledPackages(metafile)).toEqual(['node_modules/a/node_modules/@s/b', 'node_modules/c']);
  });

  it('fails on a legal comment it cannot read, rather than dropping it', () => {
    const bundle = ['/*! Bundled license information:', '  (*! ws. MIT License. A Person *)', '  (*! odd.name. MIT. Someone *)', '*/'].join('\n');
    expect(() => embeddedNotices(bundle)).toThrow(/could not be read/);
  });
  it('fails when embedded code has no upstream licence file kept for it', () => {
    expect(() => noticesText([], [{ name: 'not-kept', license: 'MIT License', author: 'Someone' }], '.')).toThrow(/upstream licence file/);
  });
});
