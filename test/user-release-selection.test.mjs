import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildUserApp } from '../src/web/user-app.mjs';
async function fixture(run) {
  let role='member',adultAllowed=false;const calls=[];
  const user=()=>({id:7,username:'member',role,adultAllowed,sessionVersion:1});
  const accounts={authenticate:async()=>user(),getSessionUser:()=>user(),registerInvite:async()=>null,
    createInvite:()=>null,revokeSessions:()=>false};
  const selection={snapshot:()=>({mode:'manual',phase:'selecting',revision:1}),
    search:async(id,query)=>{calls.push([id,query]);return {state:'candidates',items:[]};},
    begin:()=>({state:'updated'}),choose:()=>({state:'updated'}),auto:()=>({state:'updated'}),
    decide:()=>({state:'updated'}),inspect:()=>({state:'preflight',files:[]})};
  const app=await buildUserApp({accounts,sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,
    submitRequest:async()=>({state:'held'}),readRequest:id=>({id,requesterId:id===1?7:8,anidbId:id===3?99:42,episodeIds:[1]}),
    loadDetail:async({anidbId})=>({restricted:anidbId===99}),releaseSelection:selection});
  try {
    const login=await app.inject({method:'POST',url:'/api/login',headers:{origin:'http://localhost:3000'},payload:{username:'member',password:'test-passphrase'}});
    const cookie=login.headers['set-cookie'].split(';')[0];
    const session=await app.inject({url:'/api/session',headers:{cookie}});
    const headers={cookie,origin:'http://localhost:3000','x-negev-csrf':session.json().csrfToken};
    await run({app,headers,calls,selection,setAdmin:()=>{role='admin'},allowAdult:()=>{adultAllowed=true}});
  } finally {await app.close();}
}
test('members can search their own request, but not another user or adult title',()=>fixture(async({app,headers,calls,setAdmin})=>{
  assert.equal((await app.inject({url:'/api/requests/1/releases',headers})).statusCode,200);
  assert.equal((await app.inject({url:'/api/requests/2/releases',headers})).statusCode,404);
  setAdmin();assert.equal((await app.inject({url:'/api/requests/3/releases',headers})).statusCode,403);
  assert.equal(calls.length,1);
  assert.equal((await app.inject({url:'/api/requests/1/releases?offset=200',headers})).statusCode,400);
  assert.equal((await app.inject({url:'/api/requests/1/releases?offset=50',headers})).statusCode,200);
}));
test('selection writes require CSRF and a valid revision, and provider failures are recoverable',()=>fixture(async({app,headers,selection})=>{
  assert.equal((await app.inject({method:'POST',url:'/api/requests/1/release-choice',headers:{cookie:headers.cookie,origin:headers.origin},payload:{action:'begin',mode:'manual',revision:1}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/requests/1/release-choice',headers,payload:{action:'begin',mode:'manual',revision:-1}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/requests/1/release-choice',headers,payload:{action:'begin',mode:'manual',revision:1}})).statusCode,200);
  selection.search=async()=>{throw new Error('provider-private-credential');};
  const failed=await app.inject({url:'/api/requests/1/releases',headers});
  assert.equal(failed.statusCode,503);assert.equal(failed.body.includes('provider-private'),false);
}));

test('release filters and future preferences validate input and retain ownership and CSRF boundaries',()=>fixture(async({app,headers,selection})=>{
  const calls=[];selection.setPreference=async(...args)=>{calls.push(args);return {state:'updated'};};
  for(const query of ['quality=invalid','audio=invalid','offset=1'])assert.equal((await app.inject({url:'/api/requests/1/releases?'+query,headers})).statusCode,400);
  assert.equal((await app.inject({url:'/api/requests/1/releases?quality=bd1080&audio=japanese',headers})).statusCode,200);
  const payload={action:'preference',group:'SubsPlease',audio:'japanese',revision:1};
  const post=(id,body=payload,h=headers)=>app.inject({method:'POST',url:`/api/requests/${id}/release-choice`,headers:h,payload:body});
  assert.equal((await post(2)).statusCode,404);
  assert.equal((await post(1,payload,{cookie:headers.cookie,origin:headers.origin})).statusCode,403);
  assert.equal((await post(1,{...payload,audio:'invalid'})).statusCode,400);
  assert.equal((await post(1,{action:'choose',token:'receipt',revision:1,preferFutureGroup:'yes'})).statusCode,400);
  assert.equal(calls.length,0);
  assert.equal((await post(1)).statusCode,200);assert.deepEqual(calls,[[1,'SubsPlease',1,'japanese']]);
}));
