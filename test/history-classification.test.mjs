import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {openAccountLedger} from '../src/auth/account-ledger.mjs';import {openRequestLedger} from '../src/requests/request-ledger.mjs';import {createUserService} from '../src/web/user-service.mjs';
for(const mode of ['all_ages','mixed','revoked'])test('real history classification never waits for optional map facts ('+mode+')',async()=>{
 const mixed=mode==='mixed';
 const dir=await mkdtemp(path.join(tmpdir(),'negev-history-classification-')),dbPath=path.join(dir,'db.sqlite');let accounts,requests,service,pending;const gate=Promise.withResolvers();let mapReads=0,rawReads=[];
 try{
  accounts=openAccountLedger(dbPath,{now:()=>1000});const owner=await accounts.bootstrapAdmin({username:'Owner',password:'long-owner-passphrase'}),invite=accounts.createInvite({adminUserId:owner.id,expiresMs:10000});
  const member=await accounts.registerInvite({code:invite.code,username:'Member',password:'long-member-passphrase'});accounts.setAdultAllowed({adminUserId:owner.id,userId:member.id,allowed:false});
  requests=openRequestLedger(dbPath);for(const id of [1,2,3])requests.submit({requesterId:member.id,requestKey:'history-'+id,nowMs:1000,intent:{state:'ready',anidbId:id,title:'Saved '+id,kind:'movie',monitorFuture:false,episodeIds:[id*100]}});
  service=await createUserService({dbPath,shokoBaseUrl:'http://shoko.invalid',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,now:()=>1000,fetchImpl:async value=>{
   const url=new URL(value);if(url.pathname.startsWith('/api/v1/map/')){mapReads++;await gate.promise;return new Response(null,{status:503});}
   const match=/^\/api\/anidb\/(\d+)$/.exec(url.pathname);if(match){const id=Number(match[1]);rawReads.push(id);if(mode==='revoked'&&id===3)accounts.setDisabled({adminUserId:owner.id,userId:member.id,disabled:true});return Response.json({anidb_id:id,title:'SECRET-'+id,restricted:mixed&&id===2?true:mixed&&id===3?null:false,tags:[]});}
   return new Response(null,{status:404});
  }});
  const login=await service.app.inject({method:'POST',url:'/api/login',headers:{origin:'http://localhost:3000'},payload:{username:'Member',password:'long-member-passphrase'}});assert.equal(login.statusCode,200,login.body);const cookie=login.headers['set-cookie'].split(';')[0];
  let finished=false;pending=service.app.inject({url:'/api/requests?view=history',headers:{cookie}}).then(response=>{finished=true;return response});
  for(let i=0;i<50&&!finished&&mapReads===0;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mapReads,0,'optional map/studio reads cannot enter the history decision path');
  const response=await pending;if(mode==='revoked'){assert.equal(response.statusCode,401,response.body);assert.equal(response.body.includes('Saved'),false);return;}assert.equal(response.statusCode,200,response.body);assert.equal(response.json().items.length,3);assert.deepEqual([...new Set(rawReads)].sort(),[1,2,3]);
  if(mixed){for(const id of [2,3]){assert.equal(response.json().items.find(item=>item.anidbId===id).metadataHidden,true);assert.equal(response.body.includes('Saved '+id),false);}}
 }finally{gate.resolve();if(pending)await pending;await service?.close();requests?.close();accounts?.close();await rm(dir,{recursive:true,force:true});}
});
