import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSonarrOwnershipGuard } from
  '../src/acquisition/sonarr-ownership-guard.mjs';

const nowMs = Date.parse('2026-11-12T00:00:00Z');
const map = { version: 2, generated_at: '2026-11-11T00:00:00Z', anime: [
  { anidb_id: 10, tvdb_id: 100, episodes: [] },
  { anidb_id: 11, tvdb_id: 200, episodes: [] },
] };
const mapText = JSON.stringify(map);
const digest = createHash('sha256').update(mapText).digest('hex');
const responseFor = (url) => url.endsWith('/animap.json')
  ? new Response(mapText)
  : url.endsWith('/animap.json.sha256')
    ? new Response(`${digest}  animap.json\n`)
    : new Response(JSON.stringify([
      { id: 1, monitored: true, tvdbId: 100 },
      { id: 2, monitored: false, tvdbId: 200 },
    ]));

test('blocks all Sonarr series records, including unmonitored titles', async () => {
  const calls = [];
  const gate = createSonarrOwnershipGuard({
    sonarrBaseUrl: 'http://192.168.50.138:8999', sonarrApiKey: 'PrivateKey1234567',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), key: options.headers?.['X-Api-Key'] });
      return responseFor(String(url));
    }, now: () => nowMs,
  });
  assert.equal(gate.status(11), 'unavailable');
  assert.deepEqual(await gate.refresh(), { state: 'ready',
    monitoredSeries: 1, blockedTitles: 2 });
  assert.equal(gate.status(10), 'owned');
  assert.equal(gate.status(11), 'owned');
  assert.equal(gate.status(999), 'unmapped');
  assert.equal(calls.filter((call) => call.key === 'PrivateKey1234567').length, 1);
  assert.equal(calls.filter((call) => call.key === undefined).length, 2);
});

test('fails closed when Sonarr is unavailable after a valid refresh', async () => {
  let fail = false;
  const gate = createSonarrOwnershipGuard({
    sonarrBaseUrl: 'http://192.168.50.138:8999', sonarrApiKey: 'PrivateKey1234567',
    fetchImpl: async (url) => {
      if (fail && String(url).includes('192.168.50.138')) throw new Error('offline');
      return responseFor(String(url));
    }, now: () => nowMs,
  });
  assert.equal((await gate.refresh()).state, 'ready');
  fail = true;
  assert.deepEqual(await gate.refresh(), { state: 'held',
    reason: 'sonarr_ownership_unavailable' });
  assert.equal(gate.status(11), 'unavailable');
});

test('rejects a stale or mismatched public map', async () => {
  const stale = createSonarrOwnershipGuard({
    sonarrBaseUrl: 'http://192.168.50.138:8999', sonarrApiKey: 'PrivateKey1234567',
    fetchImpl: async (url) => String(url).endsWith('/animap.json')
      ? new Response(JSON.stringify({ ...map,
        generated_at: '2026-10-01T00:00:00Z' })) : responseFor(String(url)),
    now: () => nowMs,
  });
  assert.equal((await stale.refresh()).state, 'held');
  assert.equal(stale.status(11), 'unavailable');
  const staleText = JSON.stringify({ ...map,
    generated_at: '2026-10-01T00:00:00Z' });
  const staleDigest = createHash('sha256').update(staleText).digest('hex');
  const validChecksumButOld = createSonarrOwnershipGuard({
    sonarrBaseUrl: 'http://192.168.50.138:8999',
    sonarrApiKey: 'PrivateKey1234567',
    fetchImpl: async (url) => String(url).endsWith('/animap.json')
      ? new Response(staleText)
      : String(url).endsWith('/animap.json.sha256')
        ? new Response(`${staleDigest}  animap.json\n`)
        : responseFor(String(url)),
    now: () => nowMs,
  });
  assert.deepEqual(await validChecksumButOld.refresh(), { state: 'held',
    reason: 'ownership_map_unavailable' });
});

test('map generation expiry invalidates both the map and short ownership cache', async () => {
 let time=nowMs,calls=0;
 const text=JSON.stringify({...map,generated_at:new Date(time-14*86400000+1000).toISOString()});
 const sha=createHash('sha256').update(text).digest('hex');
 const gate=createSonarrOwnershipGuard({sonarrBaseUrl:'http://127.0.0.1:8999',sonarrApiKey:'SyntheticKey1234567',now:()=>time,
 fetchImpl:async url=>{calls++;return String(url).endsWith('/animap.json')?new Response(text):String(url).endsWith('.sha256')?new Response(`${sha}  animap.json\n`):Response.json([]);}});
 assert.equal((await gate.refresh()).state,'ready');time+=1001;
 assert.equal(gate.status(10),'unavailable');
 assert.equal((await gate.refresh({force:false})).state,'held');assert.equal(calls,5);
});

test('a native HTTP redirect cannot forward the configured Sonarr key', async () => {
 const {createServer}=await import('node:http');let leaked=0;
 const receiver=createServer((req,res)=>{leaked++;res.end('[]');});
 const redirect=createServer((_req,res)=>{res.writeHead(302,{location:`http://127.0.0.1:${receiver.address().port}/capture`});res.end();});
 await new Promise(r=>receiver.listen(0,'127.0.0.1',r));await new Promise(r=>redirect.listen(0,'127.0.0.1',r));
 try {
  const gate=createSonarrOwnershipGuard({sonarrBaseUrl:`http://127.0.0.1:${redirect.address().port}`,sonarrApiKey:'SyntheticKey1234567',now:()=>nowMs,
   fetchImpl:(url,options)=>String(url).startsWith('https://github.com/')?Promise.resolve(responseFor(String(url))):fetch(url,options)});
  assert.equal((await gate.refresh()).state,'held');assert.equal(leaked,0);
 }finally{receiver.closeAllConnections();redirect.closeAllConnections();await Promise.all([new Promise(r=>receiver.close(r)),new Promise(r=>redirect.close(r))]);}
});
