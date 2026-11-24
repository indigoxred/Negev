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

test('cancels a declared oversized body before consuming it', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } });
  await assert.rejects(readBoundedJson(new Response(body, { headers: { 'content-length': '999' } }), 10), /byte limit/);
  assert.equal(cancelled, 1);
});

test('invalid declared length and invalid UTF-8 both cancel bounded streams', async () => {
 for(const declared of ['invalid','-1','900719925474099999999']){
  let cancelled=0;const response=new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-length':declared}});
  await assert.rejects(readBoundedJson(response,10),/byte limit/);assert.equal(cancelled,1);
 }
 let cancelled=0;
 const response=new Response(new ReadableStream({pull(controller){controller.enqueue(Uint8Array.of(255));},cancel(){cancelled++;}}));
 await assert.rejects(readBoundedJson(response,10));assert.equal(cancelled,1);
});
