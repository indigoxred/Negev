import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { buildUserApp } from '../src/web/user-app.mjs';

const origin = 'http://localhost:3000';
async function withApp(run) {
  const accounts = { authenticate: async () => null, getSessionUser: () => null,
    registerInvite: async () => null, createInvite: () => null, revokeSessions: () => false };
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null });
  try { await run(app); } finally { await app.close(); }
}
const source = (name) => readFile(new URL(`../src/web/public/${name}`, import.meta.url));

test('scripts are compressed with Brotli or gzip and decode to the original file', () =>
  withApp(async (app) => {
    const original = await source('app.js');
    const br = await app.inject({ method: 'GET', url: '/app.js',
      headers: { 'accept-encoding': 'gzip, deflate, br' } });
    assert.equal(br.statusCode, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.ok(br.rawPayload.length < original.length / 3, `${br.rawPayload.length} bytes`);
    assert.deepEqual(brotliDecompressSync(br.rawPayload), original);
    const gzip = await app.inject({ method: 'GET', url: '/app.js',
      headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(gzip.rawPayload), original);
    const plain = await app.inject({ method: 'GET', url: '/app.js' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(plain.rawPayload, original);
    const refused = await app.inject({ method: 'GET', url: '/app.js',
      headers: { 'accept-encoding': 'br;q=0, gzip' } });
    assert.equal(refused.headers['content-encoding'], 'gzip');
  }));

test('an unchanged file is revalidated with a 304 and no body', () =>
  withApp(async (app) => {
    const first = await app.inject({ method: 'GET', url: '/style.css',
      headers: { 'accept-encoding': 'br' } });
    assert.equal(first.headers['cache-control'], 'no-cache');
    assert.match(first.headers.etag, /^"[A-Za-z0-9_-]{32}-br"$/);
    const again = await app.inject({ method: 'GET', url: '/style.css',
      headers: { 'accept-encoding': 'br', 'if-none-match': first.headers.etag } });
    assert.equal(again.statusCode, 304);
    assert.equal(again.rawPayload.length, 0);
    const stale = await app.inject({ method: 'GET', url: '/style.css',
      headers: { 'accept-encoding': 'br', 'if-none-match': '"something-else"' } });
    assert.equal(stale.statusCode, 200);
  }));

test('the page keeps its security headers and fonts are cached for a week', () =>
  withApp(async (app) => {
    const page = await app.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'br' } });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.match(brotliDecompressSync(page.rawPayload).toString('utf8'),
      /<meta name="negev-client-revision" content="[0-9a-f]{64}">/);
    const font = await app.inject({ method: 'GET', url: '/fonts/wix-madefor-text-400.ttf',
      headers: { 'accept-encoding': 'br' } });
    assert.equal(font.headers['cache-control'], 'public, max-age=604800');
    assert.equal(font.headers['content-encoding'], 'br');
    const original = await source('fonts/wix-madefor-text-400.ttf');
    assert.deepEqual(brotliDecompressSync(font.rawPayload), original);
    assert.ok(font.rawPayload.length < original.length * 0.7, `${font.rawPayload.length} of ${original.length}`);
  }));

// Exercise the real routes, including PNG dimensions and cache revalidation.
test('browser and deployment icons use small square renditions of the original art',()=>withApp(async app=>{
 for (const [name,size] of [['favicon-32.png',32],['apple-touch-icon.png',180],['icon-192.png',192],['icon-512.png',512]]) {
   const response=await app.inject({method:'GET',url:'/'+name,headers:{'accept-encoding':'br,gzip'}});
   assert.equal(response.statusCode,200);assert.equal(response.headers['content-type'],'image/png');
   assert.equal(response.headers['content-encoding'],undefined);
   assert.equal(response.rawPayload.readUInt32BE(16),size);assert.equal(response.rawPayload.readUInt32BE(20),size);
   assert.deepEqual(response.rawPayload,await source(name));
   const cached=await app.inject({method:'GET',url:'/'+name,headers:{'if-none-match':response.headers.etag}});
   assert.equal(cached.statusCode,304);assert.equal(cached.rawPayload.length,0);
 }
 const page=(await app.inject({method:'GET',url:'/'})).body;
 assert.match(page,/rel="icon"[^>]*href="\/favicon-32.png"/);
 assert.match(page,/rel="apple-touch-icon"[^>]*href="\/apple-touch-icon.png"/);
 assert.match(page,/class="brand-mark" src="\/icon-192.png"/);
}));
