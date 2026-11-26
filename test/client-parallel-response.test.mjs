import assert from 'node:assert/strict';
import test from 'node:test';
import {createVerifiedAniMapReader} from '../src/acquisition/verified-animap-reader.mjs';
import {createSonarrOwnershipGuard} from '../src/acquisition/sonarr-ownership-guard.mjs';

const now=()=>Date.parse('2026-11-12T00:00:00Z');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('parallel cleanup blocked failure')),500);})]);}finally{clearTimeout(timer);}}
function unusedResponse(mode){
 let cancels=0;
 const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('unused sibling'));},cancel(){cancels++;if(mode==='pending')return new Promise(()=>{});if(mode==='reject')return Promise.reject(Error('synthetic cancellation rejection'));}}));
 if(mode==='throw')response.body.cancel=()=>{cancels++;throw Error('synthetic cancellation failure');};
 return {response,cancels:()=>cancels};
}
const readers=[
 ['verified AniMap',fetchImpl=>createVerifiedAniMapReader({fetchImpl,now}).read().then(value=>({value}),error=>({error}))],
 ['Sonarr ownership',fetchImpl=>createSonarrOwnershipGuard({sonarrBaseUrl:'http://sonarr:8989',sonarrApiKey:'SyntheticKey123456',fetchImpl,now}).refresh()],
];
for(const [name,run] of readers)for(const failedSide of ['map','digest'])for(const timing of ['early','late','never'])for(const mode of ['normal','pending','reject','throw']){
 test(`${name} disposes ${timing} sibling when ${failedSide} rejects with ${mode} cancellation`,async()=>{
  const sibling=deferred(),failure=deferred(),fixture=unusedResponse(mode),error=Error('synthetic transport failure');let calls=0;
  const outcome=run(url=>{calls++;return String(url).endsWith('.sha256')===(failedSide==='digest')?failure.promise:sibling.promise;});
  assert.equal(calls,2,'both parallel requests must start');
  if(timing==='early'){sibling.resolve(fixture.response);await new Promise(resolve=>setImmediate(resolve));assert.equal(fixture.cancels(),0);}
  failure.reject(error);
  const result=await promptly(outcome);
  if(name==='verified AniMap')assert.equal(result.error,error);else assert.deepEqual(result,{state:'held',reason:'ownership_map_unavailable'});
  if(timing==='late'){assert.equal(fixture.cancels(),0);sibling.resolve(fixture.response);}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fixture.cancels(),timing==='never'?0:1);assert.equal(fixture.response.body.locked,false);
 });
}
for(const [name,run] of readers)for(const failedSide of ['map','digest'])test(`${name} cleans up an earlier request after synchronous ${failedSide} fetch failure`,async()=>{
 const fixture=unusedResponse('normal'),sibling=deferred(),error=Error('synchronous transport failure');let calls=0;
 const result=await promptly(run(url=>{calls++;if(String(url).endsWith('.sha256')===(failedSide==='digest'))throw error;return sibling.promise;}));
 if(name==='verified AniMap')assert.equal(result.error,error);else assert.deepEqual(result,{state:'held',reason:'ownership_map_unavailable'});
 sibling.resolve(fixture.response);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,failedSide==='map'?1:2);assert.equal(fixture.cancels(),failedSide==='map'?0:1);
});

test('a late rejection stays observed when the second request throws synchronously',async()=>{
 const {spawnSync}=await import('node:child_process');
 const helperUrl=new URL('../src/http/bounded-response.mjs',import.meta.url).href;
 const script=`
  import assert from 'node:assert/strict';
  import {fetchResponsesOrCancel} from ${JSON.stringify(helperUrl)};
  let rejectFirst,started=0;const events=[];
  process.on('unhandledRejection',error=>events.push(error));
  const first=new Promise((_,reject)=>{rejectFirst=reject;});
  const original=Error('second synchronous failure');
  await assert.rejects(fetchResponsesOrCancel([
   ()=>{started++;return first;},
   ()=>{started++;throw original;},
   ()=>{started++;throw Error('must not start');},
  ]),error=>error===original);
  assert.equal(started,2);
  rejectFirst(Error('late first rejection'));
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,[]);
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-'],{input:script,encoding:'utf8',timeout:5_000});
 assert.equal(child.status,0,child.stderr||child.error?.message);
});
