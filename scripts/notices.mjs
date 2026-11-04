// THIRD_PARTY_NOTICES.md: the licence of every package esbuild bundles into dist/bwat-plugin.js,
// taken from the installed package itself, plus the code those packages carry inside them that
// esbuild reports as a legal comment ("Bundled license information"). That embedded code has no
// package of its own in node_modules, so its upstream licence file is kept in scripts/licences/:
// re-check those files against upstream whenever undici is updated.
// scripts/build.mjs writes the notices on every build; test/notices.test.ts checks them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The package folders a metafile's inputs come from: the innermost node_modules/<package> of each,
 * kept whole, so a nested copy's licence is read from the copy that was bundled.
 */
export function bundledPackages(metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const found = input.match(/^(.*node_modules\/(?:@[^/]+\/[^/]+|[^/@][^/]*))\//);
    if (found) dirs.add(found[1]);
  }
  return [...dirs].sort();
}

/**
 * The `(*! name. Licence. Author *)` legal comments esbuild gathered at the end of the bundle.
 * One it cannot read fails the build, so no notice is dropped silently.
 */
export function embeddedNotices(bundle) {
  const found = [...bundle.matchAll(/\(\*! ([^.]+)\. ([^.]+)\. (.+?) \*\)/g)].map(([, name, license, author]) => ({ name, license, author }));
  const markers = bundle.split('(*!').length - 1;
  if (markers !== found.length) throw new Error(`notices: ${markers - found.length} legal comment(s) in the bundle could not be read`);
  return found;
}

function licenceText(dir) {
  const file = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  return file ? readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim() : undefined;
}

export function noticesText(packages, embedded, root) {
  const parts = [
    '# Third-party notices',
    '',
    'dist/bwat-plugin.js bundles the packages below. Each is listed with its licence as it ships in the package.',
  ];
  for (const path of packages) {
    const dir = join(root, path);
    const { name, version, license } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const text = licenceText(dir);
    if (!text) throw new Error(`notices: ${name} ships no licence file`);
    parts.push('', `## ${name} ${version} (${license})`, '', '```text', text, '```');
  }
  for (const { name, license } of embedded) {
    const file = join(root, 'scripts', 'licences', `${name}.LICENSE`);
    if (!existsSync(file)) throw new Error(`notices: add ${name}'s upstream licence file as ${file}`);
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
    parts.push('', `## ${name} (${license}, carried inside a package above)`, '', '```text', text, '```');
  }
  return `${parts.join('\n')}\n`;
}
