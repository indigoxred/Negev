import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildUserApp } from '../src/web/user-app.mjs';
const origin='http://localhost:3000';
async function fixture(run) {
 let allowed=false, valid=true; const classes=new Map([[1,false],[2,true],[3,null]]);
 const user=()=>({id:7,username:'Viewer',role:'admin',adultAllowed:allowed,sessionVersion:1});
 const accounts={getAiringPreferences:()=>({mode:'all',trackedAnidbIds:[]}),authenticate:async()=>user(),getSessionUser:()=>valid?user():null,getActiveUser:({userId})=>userId===7?user():{id:8,adultAllowed:false},registerInvite:async()=>null,createInvite:()=>null,revokeSessions:()=>false};
 const items=[1,2,3].map(anidbId=>({anidbId,title:`SECRET-${anidbId}`,relation:'sequel',id:anidbId,requesterId:7,status:'held',canCancel:true,kind:'series',episodeIds:[10],progress:{state:'saved',targetCount:1,publicAvailability:'unverified'},state:'held',reason:'pending',nowMs:1}));
 const selection={search:async()=>({state:'candidates',items:[{title:'SECRET-release'}]}),snapshot:()=>null,context:async()=>({title:'SECRET-context'}),begin:()=>({state:'updated'})};
 const submissions=[]; const gate={refresh:async()=>({state:'ready'}),status:()=> 'eligible'};
 const options={listOperationalReview:async()=>({state:'review',items:items.map(item=>({...item,attemptId:item.id,requestId:item.id,stage:'start_hold',observedMs:0})),nextAfterAttemptId:3}),listLibraryTitles:async()=>({state:'current_proofs',items:items.map(item=>({...item,verifiedEpisodeCount:1,lastVerifiedMs:0})),nextAfterAnidbId:3}),listAiringSchedule:async()=>({state:'ready',week:'2026-W48',checkedMs:0,items:items.map(item=>({...item,adult:false,scheduledDate:'2026-11-28',episodeNumber:'1',libraryPresence:{state:'unknown',verifiedEpisodeCount:0}}))}),listSeasonalTitles:async({year,season})=>({state:'ready',year,season,sourceDate:'2026-11-28',availableTags:[],total:3,items:items.map(item=>({...item,adult:false,type:'TV',releaseStatus:'airing'})),nextAfter:3}),ownershipGate:gate,accounts,sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,submitRequest:async input=>{submissions.push(input);return {state:'held',requestId:1};},readRequest:id=>({...items[id-1],requesterId:id===2?8:7}),listRequests:()=>({items,nextBeforeId:2}),listPendingTitles:()=>({items,nextBeforeId:2}),titleRegistry:{observe:()=>true,isKnownTitle:()=>true},
 loadRelatedTitles:async({anidbId})=>({state:'related_titles',anidbId,completeness:'unproven',items}),
 loadDetail:async({anidbId})=>({state:'details',anidbId,restricted:classes.get(anidbId),title:`SECRET-${anidbId}`}),
 readDisplayMetadata:async({anidbId})=>({state:'display',anidbId,restricted:classes.get(anidbId)}),
 readCataloguePoster:async()=>({state:'image',type:'image/jpeg',bytes:Buffer.from('SECRET-image')}),
 readPoster:async()=>({state:'image',type:'image/jpeg',bytes:Buffer.from('SECRET-image')}),readPosterTitle:async()=>2,
 getTitleCheck:async()=>({state:'done',generation:1,totalCount:1,checkedCount:1,recentAvailableCount:1}),observePublicTarget:async()=>({state:'available'}),releaseSelection:selection};
 const app=await buildUserApp(options);
 try {const login=await app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Viewer',password:'long-passphrase'}});const cookie=login.headers['set-cookie'].split(';')[0];const session=await app.inject({url:'/api/session',headers:{cookie}});await run({app,headers:{cookie,origin,'x-negev-csrf':session.json().csrfToken},classes,selection,options,gate,submissions,allow:value=>{allowed=value},revoke:()=>{valid=false}});}finally{await app.close();}
}
test('related titles verify each current classification and keep only safe metadata',()=>fixture(async({app,headers})=>{
 const response=await app.inject({url:'/api/catalogue/1/related',headers});assert.equal(response.statusCode,200);assert.deepEqual(response.json().items.map(x=>x.anidbId),[1]);
}));
test('history retains cancellation identity and pagination but redacts restricted and unknown metadata',()=>fixture(async({app,headers})=>{
 for(const url of ['/api/requests','/api/request-preparations']) {const response=await app.inject({url,headers});assert.equal(response.statusCode,200);assert.equal(response.json().nextBeforeId,2);assert.equal(response.json().items.length,3);assert.equal(response.json().items[1].id,2);assert.equal(response.body.includes('SECRET-2'),false);assert.equal(response.body.includes('SECRET-3'),false);assert.equal(response.body.includes('SECRET-1'),true);}
}));
test('posters, title checks and episode observations deny restricted and unknown direct targets',()=>fixture(async({app,headers})=>{
 for(const url of ['/api/catalogue/posters/anidb/2','/api/catalogue/posters/anidb/3','/api/catalogue/posters/12345678-1234-1234-1234-123456789012','/api/catalogue/2/title-check','/api/catalogue/3/episodes/1/availability?kind=series']) {const response=await app.inject({url,headers});assert.equal(response.statusCode,403,url);assert.equal(response.body.includes('SECRET'),false);assert.match(response.headers['cache-control'],/no-store/);}
}));
test('release metadata rereads permission after an awaited provider result',()=>fixture(async({app,headers,allow,selection})=>{
 allow(true);selection.search=async()=>{allow(false);return {state:'candidates',items:[{title:'SECRET-release'}]};};const response=await app.inject({url:'/api/requests/3/releases',headers});assert.equal(response.statusCode,403);assert.equal(response.headers['x-negev-adult-allowed'],'false');assert.equal(response.body.includes('SECRET'),false);
}));
test('admin actor cannot use a release picker for a restricted request owner',()=>fixture(async({app,headers,allow})=>{
 allow(true);const response=await app.inject({url:'/api/requests/2/releases',headers});assert.equal(response.statusCode,403);
}));
test('session revocation during a provider await withholds the response',()=>fixture(async({app,headers,allow,revoke,selection})=>{
 allow(true);selection.search=async()=>{revoke();return {state:'candidates',items:[{title:'SECRET-release'}]};};const response=await app.inject({url:'/api/requests/1/releases',headers});assert.equal(response.statusCode,401);assert.equal(response.body.includes('SECRET'),false);
}));
test('direct request history redacts a restricted title while retaining its cancellation identity',()=>fixture(async({app,headers})=>{
 const response=await app.inject({url:'/api/requests/2',headers});assert.equal(response.statusCode,200);assert.equal(response.json().id,2);assert.equal(response.json().state,'held');assert.equal(response.json().status,'held');assert.equal(response.json().canCancel,true);assert.equal(response.body.includes('SECRET-2'),false);
}));
test('reclassification applies to the next request without a process restart',()=>fixture(async({app,headers,classes})=>{
 assert.equal((await app.inject({url:'/api/catalogue/1',headers})).statusCode,200);classes.set(1,true);assert.equal((await app.inject({url:'/api/catalogue/1',headers})).statusCode,403);classes.set(1,null);assert.equal((await app.inject({url:'/api/catalogue/1',headers})).statusCode,403);classes.set(1,false);assert.equal((await app.inject({url:'/api/catalogue/1',headers})).statusCode,200);
}));
test('UID artwork resolves only a server-observed search association and fails closed after app restart',async()=>{
 const user={id:7,username:'Viewer',role:'member',adultAllowed:false,sessionVersion:1};
 const accounts={getAiringPreferences:()=>({mode:'all',trackedAnidbIds:[]}),authenticate:async()=>user,getSessionUser:()=>user,registerInvite:async()=>null,createInvite:()=>null,revokeSessions:()=>false};
 const uid='12345678-1234-1234-1234-123456789012';
 for(let restart=0;restart<2;restart++) {
  const app=await buildUserApp({accounts,sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,submitRequest:async()=>null,readRequest:()=>null,titleRegistry:{observe:()=>true,isKnownTitle:()=>true},searchTitles:async()=>({state:'results',total:1,items:[{anidbId:1,title:'Safe',adult:false,posterUid:uid}]}),readDisplayMetadata:async()=>({restricted:false}),readPoster:async()=>({state:'image',type:'image/jpeg',bytes:Buffer.from('image')})});
  try {const login=await app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Viewer',password:'long-passphrase'}});const headers={cookie:login.headers['set-cookie'].split(';')[0]};
   assert.equal((await app.inject({url:'/api/catalogue/posters/'+uid,headers})).statusCode,403);
   await app.inject({url:'/api/catalogue/search?q=safe',headers});
   const poster=await app.inject({url:'/api/catalogue/posters/'+uid,headers});assert.equal(poster.statusCode,200);assert.equal(poster.body,'image');assert.equal(poster.headers['cache-control'],'no-store');
  } finally {await app.close();}
 }
});

test('permission revocation during request ownership refresh prevents submitting a restricted request',()=>fixture(async({app,headers,allow,gate,submissions})=>{
 allow(true);gate.refresh=async()=>{allow(false);return {state:'ready'};};
 const response=await app.inject({method:'POST',url:'/api/requests',headers,payload:{anidbId:2,scope:'installment',requestKey:'revoke'}});assert.equal(response.statusCode,403);assert.equal(submissions.length,0);
}));
test('a permission change between rows cannot leave an earlier restricted row in a filtered response',()=>fixture(async({app,headers,allow,classes,options})=>{
 let marker=false,ticks=0;const originalGet=classes.get.bind(classes),sessionUser=options.accounts.getSessionUser;
 classes.get=id=>{if(id===1&&!marker){marker=true;allow(true);}return originalGet(id);};
 options.accounts.getSessionUser=input=>{if(marker&&++ticks>=4)allow(false);return sessionUser(input);};
 const response=await app.inject({url:'/api/requests',headers});assert.equal(response.statusCode,200);assert.equal(response.headers['x-negev-adult-allowed'],'false');assert.equal(response.body.includes('SECRET-2'),false);
}));
test('an administrator cannot execute release commands for a disabled request owner',()=>fixture(async({app,headers,allow,classes,options,selection})=>{
 allow(true);classes.set(2,false);options.accounts.getActiveUser=()=>null;let commands=0;selection.begin=()=>{commands++;return {state:'updated'};};
 const response=await app.inject({method:'POST',url:'/api/requests/2/release-choice',headers,payload:{action:'begin',mode:'manual',revision:0}});assert.equal(response.statusCode,403);assert.equal(commands,0);
}));



test('library, airing and season rows use current classification and preserve their original cursors',()=>fixture(async({app,headers})=>{
 for(const [url,cursor] of [['/api/library','nextAfterAnidbId'],['/api/airing',null],['/api/seasons?year=2026&season=FALL','nextAfter']]) {const response=await app.inject({url,headers});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().items.map(item=>item.anidbId),[1]);if(cursor)assert.equal(response.json()[cursor],3);assert.equal(response.body.includes('SECRET-2'),false);assert.equal(response.body.includes('SECRET-3'),false);}
}));
test('binary responses publish the permission reread after classification and keep the correct body length',()=>fixture(async({app,headers,classes,allow})=>{
 const original=classes.get.bind(classes);classes.get=id=>{allow(true);return original(id);};
 const response=await app.inject({url:'/api/catalogue/posters/anidb/2',headers});assert.equal(response.statusCode,200);assert.equal(response.headers['x-negev-adult-allowed'],'true');assert.equal(Number(response.headers['content-length']),Buffer.byteLength(response.body));
}));
test('redacted history supplies a generic title and safe status for the actual request presenter',()=>fixture(async({app,headers})=>{
 const response=await app.inject({url:'/api/requests/2',headers});const item=response.json();
 assert.equal(item.title,'Title hidden by account permissions');assert.equal(item.metadataHidden,true);assert.equal(item.englishTitle,null);assert.equal(item.progress.state,'saved');
 const {createRequestController}=await import('../src/web/public/request-controller.mjs');const {requestItemPresentation}=createRequestController({});assert.equal(requestItemPresentation(item).stage,'Requested');
}));


test('an adult-disabled administrator retains safe review controls without title metadata',()=>fixture(async({app,headers})=>{
 const response=await app.inject({url:'/api/admin/review',headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().nextAfterAttemptId,3);const restricted=response.json().items[1];assert.equal(restricted.attemptId,2);assert.equal(restricted.requestId,2);assert.equal(restricted.stage,'start_hold');assert.equal(restricted.title,'Title hidden by account permissions');assert.equal(response.body.includes('SECRET-2'),false);
}));
test('an administrator losing its role during search cannot return another owner release metadata',()=>fixture(async({app,headers,allow,classes,selection,options})=>{
 allow(true);classes.set(2,false);const original=options.accounts.getSessionUser;
 selection.search=async()=>{options.accounts.getSessionUser=input=>({...original(input),role:'member'});return {state:'candidates',items:[{title:'SECRET-release'}]};};
 const response=await app.inject({url:'/api/requests/2/releases',headers});assert.equal(response.statusCode,404);assert.equal(response.body.includes('SECRET'),false);
}));

test('session payload and permission header use the same final account state',()=>fixture(async({app,headers,allow,options})=>{
 allow(true);let reads=0;const original=options.accounts.getSessionUser;
 options.accounts.getSessionUser=input=>{const value=original(input);if(++reads===1)allow(false);return value;};
 const response=await app.inject({url:'/api/session',headers});assert.equal(response.statusCode,200);assert.equal(response.headers['x-negev-adult-allowed'],'false');assert.equal(response.json().user.adultAllowed,false);
}));

for (const [url,status] of [['/api/admin/review',403],['/api/requests?scope=all',403],['/api/requests/2',404]]) test('role demotion during classification cannot release privileged metadata: '+url,()=>fixture(async({app,headers,classes,options})=>{
 const readClass=classes.get.bind(classes),readUser=options.accounts.getSessionUser;
 classes.get=id=>{options.accounts.getSessionUser=input=>({...readUser(input),role:'member'});return readClass(id);};
 const response=await app.inject({url,headers});assert.equal(response.statusCode,status);assert.equal(response.body.includes('SECRET'),false);
}));

test('revocation during the final target authorization cannot return a previously captured detail payload',()=>fixture(async({app,headers,allow,options})=>{
 allow(true);let reads=0;const original=options.accounts.getSessionUser;
 options.accounts.getSessionUser=input=>{const value=original(input);if(++reads===4)allow(false);return value;};
 const response=await app.inject({url:'/api/catalogue/2',headers});assert.equal(response.statusCode,403);assert.equal(response.body.includes('SECRET-2'),false);
}));
