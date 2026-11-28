import test from 'node:test';import assert from 'node:assert/strict';
import {element,descendants} from './helpers/controller-dom.mjs';import {createResponseEpoch} from '../src/web/public/response-epoch.mjs';import {createAdminController} from '../src/web/public/admin-controller.mjs';
test('invitation management can append an older active page',async()=>{
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},calls=[];
 const controller=createAdminController({byId,element,state:{user:{id:7,role:'admin'}},sessionResponses:createResponseEpoch(),api:async url=>{calls.push(url);return url.includes('?')?{items:[{id:1,status:'active',expiresMs:5000,createdMs:1000}],nextBeforeId:null}:{items:[{id:51,status:'revoked',revokedMs:2000,createdMs:1000}],nextBeforeId:51}}});
 await controller.loadInvites();const more=descendants(byId('admin-invites')).find(n=>n.tag==='button'&&n.textContent==='Show older invitations');assert.ok(more);await more.click();
 assert.deepEqual(calls,['/api/admin/invitations','/api/admin/invitations?beforeId=51']);assert.match(byId('admin-invites').textContent,/Revoked/);assert.match(byId('admin-invites').textContent,/Active/);
});

test('older invitations remain retryable after a failed append',async()=>{
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)};let reads=0;
 const controller=createAdminController({byId,element,state:{user:{id:7,role:'admin'}},sessionResponses:createResponseEpoch(),api:async()=>{reads++;if(reads===2)throw Error('temporary');return reads===1?{items:[{id:51,status:'revoked'}],nextBeforeId:51}:{items:[{id:1,status:'active'}],nextBeforeId:null}}});
 await controller.loadInvites();const more=descendants(byId('admin-invites')).find(n=>n.tag==='button');await more.click();assert.equal(more.disabled,false);await more.click();assert.equal(reads,3);assert.match(byId('admin-invites').textContent,/Active/);
});
