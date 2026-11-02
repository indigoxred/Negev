import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/web/public/app.js', import.meta.url),
  'utf8');

for (const [formId, nextMarker] of [
  ['login-form', "byId('register-form').addEventListener"],
  ['register-form', "byId('signout').addEventListener"],
]) {
  test(`${formId} does not use event.currentTarget after awaiting`, () => {
    const start = source.indexOf(`byId('${formId}').addEventListener('submit'`);
    const end = source.indexOf(nextMarker, start);
    assert.ok(start >= 0 && end > start);
    const handler = source.slice(start, end);
    const firstAwait = handler.indexOf('await ');
    assert.ok(firstAwait >= 0);
    assert.doesNotMatch(handler.slice(firstAwait), /event\.currentTarget/);
  });
}
