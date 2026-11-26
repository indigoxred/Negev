import test from'node:test';import assert from'node:assert/strict';import{createVerifiedAniMapReader}from'../src/acquisition/verified-animap-reader.mjs';import{createSonarrOwnershipGuard}from'../src/acquisition/sonarr-ownership-guard.mjs';
for(const cancelMode of ['normal','pending','reject'])for(const kind of ['shared','sonarr'])for(const bad of ['checksum','map'])test(`${cancelMode}: ${kind} cancels the active ${bad==='checksum'?'map':'checksum'} reader after ${bad} transport fails`,async()=>{
 let releaseFailure,releaseChunk,cancelled=0,afterFailure=0,failed=false;
 const sibling=new Response(new ReadableStream({async pull(c){await new Promise(resolve=>releaseChunk=resolve);if(failed)afterFailure++;if(cancelled)return;c.enqueue(new TextEncoder().encode('x'))},cancel(){cancelled++;releaseChunk?.();if(cancelMode==='pending')return new Promise(()=>{});if(cancelMode==='reject')return Promise.reject(Error('cancel failed'))}},{highWaterMark:0}));
 const broken=new Response(new ReadableStream({start(c){releaseFailure=()=>{failed=true;c.error(Error('original transport failure'))}}}));
 const fetchImpl=async url=>String(url).endsWith('.sha256')===(bad==='checksum')?broken:sibling;
 const reader=kind==='shared'?createVerifiedAniMapReader({fetchImpl}):createSonarrOwnershipGuard({sonarrBaseUrl:'http://synthetic.invalid',sonarrApiKey:'syntheticKey1234567',fetchImpl});
 const result=(kind==='shared'?reader.read().then(()=>null,error=>error):reader.refresh());await new Promise(resolve=>setImmediate(resolve));assert.ok(releaseChunk,'sibling bounded reader started');releaseFailure();const answer=await result;
 if(kind==='shared')assert.equal(answer.message,'original transport failure');else assert.equal(answer.state,'held');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,1,'locked sibling read must be cancelled before it resumes');assert.equal(afterFailure,1); // cancelled pending pull can finish, but produces no data
});
