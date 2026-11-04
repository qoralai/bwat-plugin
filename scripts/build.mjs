import { readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { bundledPackages, embeddedNotices, noticesText } from './notices.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// One bundle, committed, verified by CI against its source.
const { metafile } = await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  define: { __BWAT_VERSION__: JSON.stringify(version) },
  outfile: 'dist/bwat-plugin.js',
  format: 'esm',
  metafile: true,
  // undici is CommonJS and requires node builtins, which an ESM bundle can only do through createRequire.
  banner: {
    js: [
      '// Built from src/ by scripts/build.mjs — do not edit.',
      "import { createRequire as __bwatCreateRequire } from 'node:module';",
      'const require = __bwatCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
// The licences of everything just bundled, committed beside the bundle.
const embedded = embeddedNotices(readFileSync('dist/bwat-plugin.js', 'utf8'));
writeFileSync('THIRD_PARTY_NOTICES.md', noticesText(bundledPackages(metafile), embedded, '.'));
