import assert from 'node:assert/strict';
import test from 'node:test';
import { readBoundedJson } from '../src/http/bounded-response.mjs';

test('rejects a streamed response at its byte limit before later chunks arrive', async () => {
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(8));
    },
  });
  await assert.rejects(readBoundedJson(new Response(body), 10), /byte limit/);
  assert.equal(pulled < 10, true);
});

test('counts UTF-8 bytes and parses bounded JSON', async () => {
  assert.deepEqual(await readBoundedJson(Response.json({ title: 'é' }), 20), { title: 'é' });
  await assert.rejects(readBoundedJson(Response.json({ title: 'é' }), 12), /byte limit/);
});
