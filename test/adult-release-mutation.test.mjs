import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createReleaseSelection} from '../src/acquisition/release-selection.mjs';
import {buildUserApp} from '../src/web/user-app.mjs';
const origin='http://localhost:3000';
const candidate={guid:'release',indexerId:1,title:'[Group] Example - 01 [1080p]',size:100,seeders:10};
function fixture({duringInspection=()=>{},duringDetail=()=>{},requesterId=7}={}) {
 const request={id:1,requesterId,anidbId:42,status:'held',kind:'series',episodeIds:[1],monitorFuture:true,watchClosed:false};
 let control={mode:'manual',phase:'selecting',revision:1};const wakes=[];
 const requests={getRequest:()=>request,getReleaseControl:()=>control,updateReleaseControl:(id,revision,next)=>{if(control.revision!==revision)return {state:'held',reason:'stale_release_selection'};control={...next,revision:revision+1};return {state:'updated',control};},updateReleasePreference:(id,revision,preference)=>{control={...control,preference,revision:revision+1};return {state:'updated',control};}};
 const selection=createReleaseSelection({requests,wake:id=>wakes.push(id),discoverCandidates:async()=>({state:'candidates',releaseState:'airing',items:[candidate]}),previewCandidate:async()=>{duringInspection();return {state:'preflight',torrentHash:'a'.repeat(40),episodeIds:[1],files:[{name:'example.mkv',size:100,episodeIds:[1]}]};},readPublicCoverage:async()=>({availableEpisodeIds:[],uncertainEpisodeIds:[]}),loadDetail:async()=>{duringDetail();return {state:'details',kind:'series',endDate:null,airDate:'2026-01-01',episodes:[]};}});
 return {selection,requests,wakes,control:()=>control};
}
test('HTTP admin Grab revoked during inspection cannot save a choice for an adult-enabled owner',async()=>{
 let adultAllowed=true;const user=()=>({id:7,username:'Viewer',role:'admin',adultAllowed,sessionVersion:1});
 const accounts={authenticate:async()=>user(),getSessionUser:()=>user(),getActiveUser:({userId})=>userId===8?{id:8,adultAllowed:true}:user(),registerInvite:async()=>null,createInvite:()=>null,revokeSessions:()=>false};
 const x=fixture({requesterId:8,duringInspection:()=>{adultAllowed=false;}});
 const app=await buildUserApp({accounts,sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,submitRequest:async()=>null,readRequest:x.requests.getRequest,loadDetail:async()=>({restricted:true}),releaseSelection:x.selection});
 try {const login=await app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Viewer',password:'long-passphrase'}});const cookie=login.headers['set-cookie'].split(';')[0];const session=await app.inject({url:'/api/session',headers:{cookie}});const headers={cookie,origin,'x-negev-csrf':session.json().csrfToken};
 const found=await app.inject({url:'/api/requests/1/releases',headers});const token=found.json().items[0].token;
 const response=await app.inject({method:'POST',url:'/api/requests/1/release-choice',headers,payload:{action:'choose',token,revision:1}});
 assert.equal(response.statusCode,403);assert.equal(x.control().phase,'selecting');assert.deepEqual(x.wakes,[]);
 }finally{await app.close();}
});
test('selection preference checks per-call authorization after reading airing context',async()=>{
 let allowed=true;const x=fixture({duringDetail:()=>{allowed=false;}});
 const result=await x.selection.setPreference(1,'Group',1,'japanese',async()=>allowed?null:{state:'held',reason:'account_access_changed'});
 assert.equal(result.reason,'account_access_changed');assert.equal(x.control().revision,1);assert.deepEqual(x.wakes,[]);
});
test('Auto comparison checks per-call authorization before saving its terminal choice',async()=>{
 let allowed=true;const x=fixture({duringInspection:()=>{allowed=false;}});x.selection.begin(1,'auto',1);x.wakes.length=0;
 const result=await x.selection.auto(1,2,async()=>allowed?null:{state:'held',reason:'account_access_changed'});
 assert.equal(result.reason,'account_access_changed');assert.equal(x.control().phase,'selecting');assert.deepEqual(x.wakes,[]);
});
