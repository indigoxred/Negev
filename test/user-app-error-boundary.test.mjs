import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildUserApp} from '../src/web/user-app.mjs';

const origin='http://127.0.0.1:8123',uid='11111111-2222-4333-8444-555555555555';
const cases=[['/api/catalogue/search?q=example','searchTitles'],['/api/catalogue/42','loadDetail'],
 ['/api/catalogue/42/display','readDisplayMetadata'],['/api/catalogue/42/related','loadRelatedTitles'],
 [`/api/catalogue/posters/${uid}`,'readPoster'],['/api/catalogue/posters/anidb/42','readCataloguePoster']];
for(const [url,provider]of cases)test(`unexpected ${provider} errors return no provider text`,async()=>{
 const secret='synthetic-private-key',user={id:1,username:'Owner',role:'admin',sessionVersion:1,adultAllowed:true};let calls=0;
 const accounts={authenticate:async()=>user,getSessionUser:()=>user,registerInvite:async()=>null,createInvite:()=>null,revokeSessions:()=>false};
 const app=await buildUserApp({accounts,sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,
  submitRequest:async()=>null,readRequest:()=>null,confirmKnownTitle:async()=>true,
  titleRegistry:{observe:()=>true,isKnownTitle:()=>true},readPosterTitle:()=>42,
  [provider]:async()=>{calls++;throw Error(`Provider failed: http://private.invalid/api?apikey=${secret}`);}});
 try{
  const login=await app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Owner',password:'long-owner-passphrase'}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const result=await app.inject({method:'GET',url,headers:{cookie}});
  assert.equal(calls,1,'exercise the throwing provider');
  assert.equal(result.statusCode,503);assert.deepEqual(result.json(),{error:'Service unavailable'});
  assert.ok(!result.body.includes(secret));assert.ok(!result.body.includes('private.invalid'));
  assert.equal(result.headers['cache-control'],'no-store');
 }finally{await app.close();}
});
