// How every client starts bwat: installs its libraries if they are not there yet (scripts/install.mjs),
// then runs src/cli.ts with Node's own type stripping. There is no build step.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { install, ROOT } from './install.mjs';

function fail(message) {
  process.stderr.write(`bwat-plugin: ${message}\n`);
  process.exit(2);
}

if (!process.features.typescript) fail(`needs Node 22.18 or later, which runs TypeScript; this is ${process.version}`);
const why = await install();
if (why) fail(`could not install its libraries into ${ROOT}: ${why}. Check npm, the network and that the folder is writable, then start it again`);
await import(pathToFileURL(join(ROOT, 'src', 'cli.ts')).href);
