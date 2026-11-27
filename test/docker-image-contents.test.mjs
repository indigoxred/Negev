import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testOnly = ['src/web/app.mjs', 'src/web/private-server.mjs',
  'src/web/private-server-config.mjs', 'src/catalogue/catalogue-service.mjs'];

function productionModules() {
  const seen = new Set();
  const stack = [path.join(root, 'src/web/user-server.mjs')];
  const pattern = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|new URL\(\s*['"](\.[^'"]+\.m?js)['"]/g;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const target = path.resolve(path.dirname(file), match[1] || match[2] || match[3]);
      if (existsSync(target)) stack.push(target);
    }
  }
  return new Set([...seen].map((file) => path.relative(root, file).split(path.sep).join('/')));
}

test('the Docker image leaves out the test-only server and the user server never needs it', () => {
  const ignored = readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/);
  for (const file of testOnly) assert.ok(ignored.includes(file), `${file} is not in .dockerignore`);
  const modules = productionModules();
  assert.ok(modules.size > 50, 'import walk found the production graph');
  for (const file of testOnly) assert.equal(modules.has(file), false, `${file} is imported by user-server`);
});
