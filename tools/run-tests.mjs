// Runs the suite the way CI does. Chrome can starve when the browser fixtures
// share the parallel run, so each test/browser-*.test.mjs file gets a run of
// its own after the rest of the suite.
//
//   node tools/run-tests.mjs           everything (pnpm test)
//   node tools/run-tests.mjs unit      everything except browser files
//   node tools/run-tests.mjs browser   only the browser files, one at a time
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2] ?? 'all';
if (!['all', 'unit', 'browser'].includes(mode)) {
  process.stderr.write('Usage: node tools/run-tests.mjs [all|unit|browser]\n');
  process.exit(2);
}
const files = readdirSync(path.join(root, 'test'), { recursive: true })
  .map((file) => String(file).split(path.sep).join('/'))
  .filter((file) => file.endsWith('.test.mjs'))
  .map((file) => `test/${file}`)
  .sort();
const isBrowser = (file) => /^test\/browser-/.test(file);
const run = (args) => spawnSync(process.execPath, ['--test', ...args],
  { cwd: root, stdio: 'inherit' }).status ?? 1;

let failed = false;
if (mode !== 'browser') failed = run(files.filter((file) => !isBrowser(file))) !== 0;
if (mode !== 'unit') {
  for (const file of files.filter(isBrowser)) failed = run([file]) !== 0 || failed;
}
process.exitCode = failed ? 1 : 0;
