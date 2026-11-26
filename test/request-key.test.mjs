import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestKeyStore, generateRequestKey } from '../src/web/public/request-key.mjs';

test('a LAN HTTP browser can generate a key without randomUUID', () => {
  const cryptoSource = { getRandomValues(bytes) {
    for (let index = 0; index < bytes.length; index++) bytes[index] = index;
    return bytes;
  } };
  assert.equal(generateRequestKey(cryptoSource),
    '000102030405060708090a0b0c0d0e0f');
  assert.throws(() => generateRequestKey({}), /random/i);
});

test('an uncertain retry reuses its key but a saved request permits another', () => {
  const values = new Map();
  let sequence = 0;
  const keys = createRequestKeyStore({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    createKey: () => `key-${++sequence}`,
  });
  assert.equal(keys.pending({ userId: 4, anidbId: 42 }), 'key-1');
  assert.equal(keys.pending({ userId: 4, anidbId: 42 }), 'key-1');
  assert.equal(keys.pending({ userId: 5, anidbId: 42 }), 'key-2');
  assert.equal(keys.pending({ userId: 4, anidbId: 42,
    selection: 'episode-1001' }), 'key-3');
  assert.equal(keys.pending({ userId: 4, anidbId: 42,
    selection: 'film-entry-1001' }), 'key-4');
  keys.saved({ userId: 4, anidbId: 42 });
  assert.equal(keys.pending({ userId: 4, anidbId: 42 }), 'key-5');
  assert.equal(keys.pending({ userId: 5, anidbId: 42 }), 'key-2');
  assert.equal(keys.pending({ userId: 4, anidbId: 42,
    selection: 'episode-1001' }), 'key-3');
});

test('a refreshed browser rotates only a definitively cancelled key after a lost acknowledgement',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');const {openRequestLedger}=await import('../src/requests/request-ledger.mjs');
 const dir=await mkdtemp(path.join(tmpdir(),'negev-key-recovery-'));let ledger=openRequestLedger(path.join(dir,'db.sqlite'));t.after(async()=>{ledger.close();await rm(dir,{recursive:true,force:true});});
 const values=new Map();let sequence=0;const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const browser=()=>createRequestKeyStore({storage,createKey:()=>`key-${++sequence}`});const scope={userId:7,anidbId:123};
 const input={requesterId:7,requestKey:browser().pending(scope),commandKey:'exact',intent:{state:'ready',anidbId:123,kind:'series',title:'Example',episodeIds:[1],monitorFuture:true},nowMs:1000};
 const saved=ledger.submit(input);ledger.close();ledger=openRequestLedger(path.join(dir,'db.sqlite'));
 const refreshed=browser();refreshed.rejected(scope,{reason:'provider_unavailable'});assert.equal(refreshed.pending(scope),input.requestKey);
 assert.equal(ledger.submit({...input,requestKey:refreshed.pending(scope)}).requestId,saved.requestId);assert.equal(ledger.listRequests({requesterId:7}).items.length,1);
 ledger.cancelRequest({requesterId:7,requestId:saved.requestId,nowMs:2000});const rejected=ledger.submit({...input,requestKey:refreshed.pending(scope)});assert.equal(rejected.reason,'request_cancelled');
 refreshed.rejected(scope,rejected);const next=browser().pending(scope);assert.notEqual(next,input.requestKey);assert.ok(ledger.submit({...input,requestKey:next,nowMs:3000}).requestId);
});

test('a successful acknowledgement clears only its matching key and permits the next request',()=>{
 const values=new Map();let sequence=0;const keys=createRequestKeyStore({storage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},createKey:()=>`saved-key-${++sequence}`});
 const scope={userId:7,anidbId:42},submitted=keys.pending(scope);
 keys.saved(scope,'older-key');assert.equal(keys.pending(scope),submitted);
 keys.saved(scope,submitted);assert.notEqual(keys.pending(scope),submitted);
});
