import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdultSearchVerifier } from '../src/web/public/adult-search-visibility.mjs';

test('search reveals only verified nonadult titles while 18+ is off', async () => {
  const seen = [];
  const verifier = createAdultSearchVerifier({ readDisplay: async (id) => {
    if (id === 14974) return { state: 'display', anidbId: id, restricted: true };
    if (id === 11003) return { state: 'display', anidbId: id + 1, restricted: false };
    if (id === 2498) return { state: 'display', anidbId: id, restricted: false };
    throw new Error('temporarily unavailable');
  }, pacer: { run: (read) => read(), defer() {} } });
  await verifier.verify([14974, 11003, 2498, 18447], (id, adult) =>
    seen.push({ id, adult }));
  assert.deepEqual(seen, [
    { id: 14974, adult: true }, { id: 2498, adult: false },
  ]);
});

test('duplicate classification reads coalesce and obsolete queued cards never fetch', async () => {
  const queue = [], reads = [];
  const verifier = createAdultSearchVerifier({ readDisplay: async id => {
    reads.push(id); return { state: 'display', anidbId: id, restricted: false };
  }, pacer: { run: (read, current) => new Promise((resolve, reject) => queue.push(async () => {
    if (!current()) return reject(new Error('superseded'));
    resolve(await read());
  })), defer() {} } });
  let active = true;
  const seen = [];
  const a = verifier.verify([1, 1, 2], (id) => seen.push(id), { current: () => active });
  const b = verifier.verify([1], (id) => seen.push(id), { current: () => true });
  assert.equal(queue.length, 2, 'one read per distinct id');
  active = false;
  for (const start of queue) await start();
  await Promise.all([a, b]);
  assert.deepEqual(reads, [1]);
  assert.deepEqual(seen, [1]);
});

test('classification pauses queued reads after provider throttling without retrying the failed title', async () => {
  const deferred = [], reads = [];
  const verifier = createAdultSearchVerifier({ readDisplay: async id => {
    reads.push(id);
    const error = new Error('busy'); error.status = 429; error.retryAfter = '120'; throw error;
  }, pacer: { run: read => read(), defer: (...args) => deferred.push(args) } });
  await verifier.verify([1], () => assert.fail('failed classification stays hidden'));
  assert.deepEqual(reads, [1]);
  assert.deepEqual(deferred, [['120', 60_000]]);
});

test('simultaneous search batches share a rate budget that leaves foreground display capacity', async () => {
  let now = 0;
  const starts = [];
  const { createCatalogueReadPacer } = await import('../src/web/public/search-pages.mjs');
  const pacer = createCatalogueReadPacer({ now: () => now, sleep: async ms => { now += ms; } });
  const verifier = createAdultSearchVerifier({ pacer, readDisplay: async id => {
    starts.push(now); return { state: 'display', anidbId: id, restricted: false };
  } });
  await Promise.all([
    verifier.verify(Array.from({ length: 12 }, (_, i) => i + 1), () => {}),
    verifier.verify(Array.from({ length: 12 }, (_, i) => i + 13), () => {}),
  ]);
  assert.equal(starts.length, 24);
  for (const start of starts) assert.ok(starts.filter(time => time >= start && time < start + 60_000).length <= 10);
  assert.ok(starts[10] >= 60_000, 'background must leave 20 of the route’s 30 reads per minute for foreground');
});

test('small classification batches can use four immediate reads without raising the rolling limit',async()=>{
 const {createCatalogueReadPacer}=await import('../src/web/public/search-pages.mjs');let time=0;const starts=[];
 const pacer=createCatalogueReadPacer({burst:4,now:()=>time,sleep:async ms=>{time+=ms;}});
 const verifier=createAdultSearchVerifier({pacer,readDisplay:async id=>{starts.push(time);return{state:'display',anidbId:id,restricted:false}}});
 await verifier.verify(Array.from({length:14},(_,i)=>i+1),()=>{});
 assert.deepEqual(starts.slice(0,4),[0,0,0,0]);
 for(const start of starts)assert.ok(starts.filter(t=>t>=start&&t<start+60000).length<=10);
});
