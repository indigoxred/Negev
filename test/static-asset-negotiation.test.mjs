import assert from 'node:assert/strict';
import test from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createStaticAsset } from '../src/web/static-asset.mjs';

function request(accepted, body = 'x'.repeat(2000), contentType = 'text/plain') {
  const result = { status: 200, headers: {}, body: null };
  const reply = { headers(h) { Object.assign(result.headers, h); return this; },
    header(k,v) { result.headers[k.toLowerCase()] = v; return this; }, type() { return this; },
    code(n) { result.status = n; return this; }, send(value) { result.body = value; return result; } };
  createStaticAsset(body, { contentType, cacheControl: 'no-cache' })(
    { headers: accepted === undefined ? {} : { 'accept-encoding': accepted } }, reply);
  return result;
}

test('refusing every supported representation gives 406 rather than an unaccepted body', () => {
  const result = request('identity;q=0, br;q=0, gzip;q=0');
  assert.equal(result.status, 406); assert.equal(result.body, undefined);
  assert.equal(result.headers.vary, 'Accept-Encoding');
});
test('quality weights prefer gzip when the browser ranks it over Brotli', () => {
  const result = request('br;q=0.1, gzip;q=1');
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(result.body).toString(), 'x'.repeat(2000));
});
test('a wildcard cannot override an explicit refusal of an encoding', () => {
  const result = request('br;q=0, gzip;q=0, *;q=1, identity;q=0');
  assert.equal(result.status, 406);
});
test('wildcard negotiation can use Brotli while gzip and identity are refused', () => {
  const result = request('gzip;q=0, *;q=1, identity;q=0');
  assert.equal(result.headers['content-encoding'], 'br');
  assert.equal(brotliDecompressSync(result.body).toString(), 'x'.repeat(2000));
});
test('a small body is still encoded when identity is forbidden', () => {
  const result = request('br, identity;q=0', 'small');
  assert.equal(result.headers['content-encoding'], 'br');
  assert.equal(brotliDecompressSync(result.body).toString(), 'small');
});
test('no encoding header, or an empty header, still accepts identity', () => {
  for (const accepted of [undefined, '']) {
    const result = request(accepted);
    assert.equal(result.status, 200); assert.equal(result.headers['content-encoding'], undefined);
  }
});
test('an explicit identity preference is respected', () => {
  const result = request('br;q=0.2, identity;q=1');
  assert.equal(result.headers['content-encoding'], undefined);
});

for (const type of ['image/png','image/jpeg','image/webp','image/avif','image/gif','image/x-icon','image/vnd.microsoft.icon','font/woff2']) {
  test(type+' is sent unchanged without expensive recompression',()=>{
    const raw=Buffer.alloc(2048,7),result=request('br, gzip',raw,type);
    assert.equal(result.headers['content-encoding'],undefined);
    assert.strictEqual(result.body,raw);
    assert.equal(request('br, identity;q=0',raw,type).status,406);
  });
}
