import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPosterRecovery } from '../src/web/public/poster-recovery.mjs';

const fixture=(status=503,retryAfter='90')=>{
  const events={},classes=new Set();let callback,delay,cancelled=0,writes=0,probes=0,src='/api/catalogue/posters/anidb/1';
  const image={isConnected:true,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)},
    addEventListener:(name,fn)=>{events[name]=fn;},getAttribute:()=>src,
    set src(value){src=value;writes++;}};
  attachPosterRecovery(image,{now:()=>1000,probe:async()=>{probes++;return new Response(null,{status,headers:retryAfter?{'Retry-After':retryAfter}:{}});},schedule:(fn,ms)=>{callback=fn;delay=ms;return 1;},cancel:()=>{cancelled++;}});
  return{image,events,classes,run:()=>callback?.(),get probes(){return probes;},get delay(){return delay;},get writes(){return writes;},get cancelled(){return cancelled;}};
};
test('failed native lazy artwork retries once after the actual cooldown, without cache-busting',async()=>{
  const f=fixture();await f.events.error();assert.equal(f.classes.has('missing-art'),true);
  assert.equal(f.delay,90000);f.run();assert.equal(f.writes,1);
  assert.equal(f.classes.has('missing-art'),false);await f.events.error();f.run();
  assert.equal(f.writes,1,'the same timer callback cannot submit another retry');
  assert.equal(f.probes,1,'failed retry cannot create another status probe');
});
test('successful, detached or repurposed image nodes do not retry stale artwork',async()=>{
  const success=fixture();await success.events.error();success.events.load();
  assert.equal(success.cancelled,1);success.run();assert.equal(success.writes,0);
  const detached=fixture();await detached.events.error();detached.image.isConnected=false;detached.run();assert.equal(detached.writes,0);
  const changed=fixture();await changed.events.error();changed.image.src='/other';changed.run();assert.equal(changed.writes,1);
});
test('real missing artwork is not retried and invalid far-future cooldowns cannot overflow timers',async()=>{
  for(const f of[fixture(404,null),fixture(503,'999999999999999999999')]){
    await f.events.error();assert.equal(f.delay,undefined);f.run();assert.equal(f.writes,0);
  }
  const date=fixture(503,'Thu, 01 Jan 1970 00:01:31 GMT');await date.events.error();assert.equal(date.delay,90000);
  const available=fixture(200,null);await available.events.error();assert.equal(available.delay,0);available.run();assert.equal(available.writes,1);
});
