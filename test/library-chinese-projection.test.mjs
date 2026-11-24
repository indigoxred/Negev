import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {buildUserApp} from '../src/web/user-app.mjs';
import {hideChineseProduction} from '../src/web/public/chinese-visibility.mjs';
test('authenticated Library retains country flags through both visibility states and rejects malformed evidence',async()=>{
 const user={id:7,username:'Owner',role:'admin',sessionVersion:1,adultAllowed:true},origin='http://localhost:30125';let malformed=false;
 const app=await buildUserApp({accounts:{authenticate:async()=>user,getSessionUser:()=>user,registerInvite:async()=>null,createInvite:()=>null,revokeSessions:()=>false},sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,now:()=>10000,submitRequest:async()=>null,readRequest:()=>null,
  listLibraryTitles:async()=>({state:'current_proofs',items:[
   {anidbId:11,title:'Example A',verifiedEpisodeCount:1,lastVerifiedMs:1000,chineseProduction:malformed?'yes':true},
   {anidbId:22,title:'Example B',verifiedEpisodeCount:1,lastVerifiedMs:1000,chineseProduction:false}],nextAfterAnidbId:null})});
 try{
  const login=await app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Owner',password:'long-owner-passphrase'}}),cookie=login.headers['set-cookie'].split(';')[0];
  const read=()=>app.inject({method:'GET',url:'/api/library',headers:{cookie}}),response=await read();assert.equal(response.statusCode,200,response.body);
  const items=response.json().items;assert.deepEqual(items.map(x=>x.chineseProduction),[true,false]);
  assert.deepEqual(items.filter(x=>!hideChineseProduction(false,x.chineseProduction)).map(x=>x.anidbId),[22]);
  assert.deepEqual(items.filter(x=>!hideChineseProduction(true,x.chineseProduction)).map(x=>x.anidbId),[11,22]);
  malformed=true;assert.equal((await read()).statusCode,503);
 }finally{await app.close()}
});
