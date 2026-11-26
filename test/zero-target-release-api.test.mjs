import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createHeldRequestSubmitter } from '../src/requests/submit-held-request.mjs';
import { pollAiringWatches } from '../src/requests/airing-watch-poll.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker } from '../src/acquisition/acquisition-request-queue.mjs';
import { createAcquisitionRequestProcessor } from '../src/acquisition/acquisition-request-processor.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

test('authenticated zero-target Manual rejects and Auto review creates a durable watch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-empty-manual-api-'));
  const accounts = openAccountLedger(path.join(root, 'accounts.sqlite'));
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  const ledger = openRequestLedger(path.join(root, 'requests.sqlite'));
  const detail = { state: 'details', anidbId: 42, title: 'Airing series',
    kind: 'series', restricted: false, complete: true, page: 1, total: 1,
    nextPage: null, airDate: '2026-11-01', endDate: null, episodeCount: 12,
    episodes: [{ id: 99, number: 1, type: 'Episode', title: 'First', airDate: '2026-11-01' }] };
  const submit = createHeldRequestSubmitter({ ledger, authorizeRequester: () => ({ active: true, adultAllowed: true }),
    confirmKnownTitle: async () => true, loadDetail: async () => detail, recentlyAvailable: () => true,
    now: () => 1000, today: () => '2026-11-03' });
  const origin = 'http://localhost:3000';
  const app = await buildUserApp({ accounts, submitRequest: submit, readRequest: id => ledger.getRequest(id),
    releaseSelection: {}, sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
    for (const releaseMode of ['manual']) {
      const result = await app.inject({ method: 'POST', url: '/api/requests', headers,
        payload: { anidbId: 42, scope: 'installment', requestKey: releaseMode, releaseMode } });
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(result.json().reason, 'release_selection_requires_targets');
      assert.deepEqual(ledger.listRequests({ requesterId: owner.id }).items, []);
    }
    const auto = await app.inject({ method: 'POST', url: '/api/requests', headers,
      payload: { anidbId: 42, scope: 'installment', requestKey: 'auto', releaseMode: 'auto_review' } });
    assert.equal(auto.statusCode, 202, auto.body);
    assert.equal(ledger.getRequest(auto.json().requestId).monitorFuture, true);
    assert.deepEqual(auto.json().targetIds, []);
    assert.deepEqual(ledger.getReleaseControl(auto.json().requestId), {mode:'auto',phase:'consumed',revision:0});
  } finally { await app.close(); ledger.close(); accounts.close(); await rm(root, { recursive: true, force: true }); }
});


// Exercise the real chooser route, SQLite, metadata poll and acquisition worker.
// Only external provider/availability/download boundaries are simulated.
for (const scenario of ['caught-up', 'pre-premiere', 'catch-up']) test(
  `chooser Auto ${scenario}: durable future episodes dispatch once across restart`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-auto-watch-'));
  const dbPath = path.join(root, 'requests.sqlite');
  const accounts = openAccountLedger(path.join(root, 'accounts.sqlite'));
  await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  let ledger = openRequestLedger(dbPath), queue = openAcquisitionRequestQueue(dbPath);
  let day = scenario === 'pre-premiere' ? 0 : 3;
  let nowMs = Date.parse('2026-11-01T00:00:00Z');
  const today = () => day === 0 ? '2026-10-31' : `2026-11-${String(day).padStart(2, '0')}`;
  const owned = new Set(scenario === 'caught-up' ? [101, 102, 103] : scenario === 'catch-up' ? [101] : []);
  const grabs = [];
  let searches = 0;
  const detail = () => ({state:'details',anidbId:42,title:'Example',kind:'series',restricted:false,
    complete:true,page:1,total:day+1,nextPage:null,airDate:'2026-11-01',
    endDate:null,episodeCount:12,episodes:Array.from({length:day+1},(_,i)=>({
      id:101+i,number:i+1,type:'Episode',title:`Episode ${i+1}`,airDate:`2026-11-${String(i+1).padStart(2,'0')}`}))});
  const submit = createHeldRequestSubmitter({ledger:{findSubmission: input=>ledger.findSubmission(input),
    findActiveWatch: input=>ledger.findActiveWatch(input),findOtherActiveWatch: input=>ledger.findOtherActiveWatch(input),
    submit: input=>ledger.submit(input)},confirmKnownTitle:async()=>true,loadDetail:async()=>detail(),
    recentlyAvailable:({episodeId})=>owned.has(episodeId),authorizeRequester:()=>({active:true,adultAllowed:true}),
    now:()=>nowMs,today});
  const origin='http://localhost:3000';
  const app=await buildUserApp({accounts,submitRequest:submit,readRequest:id=>ledger.getRequest(id),
    releaseSelection:{},sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false});
  try {
    const login=await app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Owner',password:'long-owner-passphrase'}});
    const cookie=login.headers['set-cookie'].split(';')[0];
    const session=await app.inject({method:'GET',url:'/api/session',headers:{cookie}});
    const headers={cookie,origin,'x-negev-csrf':session.json().csrfToken};
    const post=async key=>{
      const result=await app.inject({method:'POST',url:'/api/requests/seasons',headers,
        payload:{seasons:[{anidbId:42,requestKey:key,releaseMode:'auto_review'}]}});
      assert.equal(result.statusCode,200,result.body);
      const row=result.json().items[0];assert.equal(row.status,202,result.body);return row.result;
    };
    const saved=await post('chooser');
    const id=saved.requestId;
    assert.deepEqual(ledger.getRequest(id).episodeIds,scenario==='catch-up'?[102,103]:[]);
    assert.equal(ledger.getRequest(id).monitorFuture,true);
    if(scenario!=='catch-up')assert.deepEqual(ledger.getReleaseControl(id),{mode:'auto',phase:'consumed',revision:0});
    const work=async()=>{
      const processRequest=createAcquisitionRequestProcessor({readRequest:id=>ledger.getRequest(id),
        readReleaseControl:(...args)=>ledger.getReleaseControl(...args),
        selectAutoRelease:(requestId,revision)=>ledger.updateReleaseControl(requestId,revision,{mode:'auto',phase:'consumed'},nowMs),
        readPublicCoverage:async request=>{const ids=request.episodeIds.filter(id=>owned.has(id));return {
          targetCount:request.episodeIds.length,verifiedTargets:ids.length,availableEpisodeIds:ids}},
        discoverCandidates:async request=>{searches++;const ids=ledger.getRequest(id).episodeIds.filter(id=>!owned.has(id));return {
          state:'candidates',requestId:id,anidbId:42,releaseState:'airing',items:[{
            indexerId:7,guid:'release-'+ids.join('-'),title:ids.length>1?'Example - 02-03':'Example - '+String(ids[0]-100).padStart(2,'0'),size:1000,evidence:'unverified',episodeIds:ids}]}},
        previewCandidate:async ({candidate})=>({state:'preflight',requestId:id,anidbId:42,torrentHash:'a'.repeat(40),
          episodeIds:candidate.episodeIds,files:[{name:candidate.title+'.mkv',size:1000,episodeIds:candidate.episodeIds}]}),
        loadDetail:async()=>detail(),submitCandidate:async ({episodeIds})=>{
          grabs.push([...episodeIds]);for(const episodeId of episodeIds)owned.add(episodeId);
          return {state:'stopped_observed',attemptId:grabs.length};},now:()=>nowMs});
      return createAcquisitionPageWorker({queue,processRequest,limit:1,now:()=>nowMs}).runOnce({priorityRequestId:id});
    };
    const restart=()=>{queue.close();ledger.close();ledger=openRequestLedger(dbPath);queue=openAcquisitionRequestQueue(dbPath)};
    const initialWork = await work();
    assert.deepEqual(grabs,scenario==='catch-up'?[[102,103]]:[], JSON.stringify(initialWork));
    if(scenario!=='catch-up')assert.equal(searches,0,'watch-only creation performs no initial acquisition search');
    restart();await work();assert.equal((await post('repeat')).requestId,id);
    assert.equal(ledger.countRequests(),1);
    for(const released of scenario==='pre-premiere'?[1,2]:[4,5]){
      day=released;nowMs+=2*86400000;
      const polled=await pollAiringWatches({ledger,requestId:id,loadDetail:async()=>detail(),today:today(),nowMs,intervalMs:0});
      assert.equal(polled.results[0].state,'advanced');
      assert.equal(ledger.getRequest(id).episodeIds.includes(101+released),false,'known future metadata never becomes an early acquisition target');
      const before=grabs.length;const result=await work();assert.equal(grabs.length,before+1,JSON.stringify(result));
      assert.deepEqual(grabs.at(-1),[100+released],'newly released episodes are individual acquisitions');
      restart();await work();
      await pollAiringWatches({ledger,requestId:id,loadDetail:async()=>detail(),today:today(),nowMs,intervalMs:0});
      await work();assert.equal(grabs.length,before+1,'restart and repeated poll do not dispatch again');
    }
    assert.deepEqual(grabs,scenario==='pre-premiere'?[[101],[102]]:scenario==='catch-up'?[[102,103],[104],[105]]:[[104],[105]]);
  } finally {await app.close();queue.close();ledger.close();accounts.close();await rm(root,{recursive:true,force:true})}
});
