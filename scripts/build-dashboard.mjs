// Turns src/dashboard.html into src/dashboard.js, a module exporting the HTML
// as a string, so a consumer needs no wrangler `rules` entry to import it:
// wrangler's text-import rule does not reliably reach into node_modules.
//
// The output is committed. `--check` exits 1 if it is stale, and `npm test`
// runs that first, so an edit to the .html cannot ship without a rebuild.
//
// Run: node scripts/build-dashboard.mjs [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'src', 'dashboard.html');
const target = join(here, '..', 'src', 'dashboard.js');

const html = readFileSync(source, 'utf8');
const output = `// Generated from dashboard.html by scripts/build-dashboard.mjs. Do not edit;
// edit the .html and run \`npm run build\`.
export default ${JSON.stringify(html)};
`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = '';
  }
  if (current !== output) {
    console.error('src/dashboard.js is stale: run `npm run build`');
    process.exit(1);
  }
  console.log('src/dashboard.js is up to date');
} else {
  writeFileSync(target, output);
  console.log(`wrote ${target} (${output.length} bytes)`);
}
