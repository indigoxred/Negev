/** Development-only visual fixture host. No production modules, credentials, database, or acquisition. */
import { createServer } from 'node:http';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
const root = fileURLToPath(new URL('../src/web/public/', import.meta.url));
const stamp = () => Date.now();
const present = count => ({ state: count ? 'in_library' : 'unknown', verifiedEpisodeCount: count });
// Public catalogue artwork; illustrative fixture identities/counts are not production evidence.
const entries = [
 [17164,'Sousou no Frieren','Frieren: Beyond Journey’s End','https://cdn.myanimelist.net/images/anime/1015/138006l.jpg',28,8,['Fantasy','Adventure','Drama']],
 [15748,'Bocchi the Rock!','Bocchi the Rock!','https://cdn.myanimelist.net/images/anime/1448/127956l.jpg',12,8,['Music','Comedy','Slice of life']],
 [17823,'Dungeon Meshi','Delicious in Dungeon','https://cdn.myanimelist.net/images/anime/1711/142478l.jpg',24,0,['Fantasy','Adventure','Comedy']],
 [15051,'Kusuriya no Hitorigoto','The Apothecary Diaries','https://cdn.myanimelist.net/images/anime/1708/138033l.jpg',24,0,['Mystery','Drama','Historical']],
 [17465,'Violet Evergarden','Violet Evergarden','https://cdn.myanimelist.net/images/anime/1795/95088l.jpg',13,13,['Drama','Fantasy']],
 [9589,'Kotonoha no Niwa','The Garden of Words','https://cdn.myanimelist.net/images/anime/1597/112995.jpg',1,1,['Romance','Drama']],
 [4158,'Pale Cocoon','Pale Cocoon',null,1,0,['Science fiction']],
 [18000,'Preview installment A · fictional fixture','Preview installment A · fictional fixture','https://cdn.myanimelist.net/images/anime/1015/138006l.jpg',12,0,['Fantasy','Adventure']],
 [18001,'Preview installment B with a deliberately long name · fictional fixture','Preview installment B · fictional fixture','https://cdn.myanimelist.net/images/anime/1015/138006l.jpg',12,12,['Fantasy','Adventure']],
 [18002,'Bocchi the Rock! Re:','Bocchi the Rock! Re:','https://cdn.myanimelist.net/images/anime/1448/127956l.jpg',1,0,['Music','Comedy']],
 [17824,'Dungeon Meshi: Senshi no Cooking','Delicious in Dungeon: Senshi’s Cooking','https://cdn.myanimelist.net/images/anime/1711/142478l.jpg',12,0,['Fantasy','Comedy']],
 [18003,'A Very Long Unannounced Anime Title About Starting Another Journey with Friends','Preview airing anime · fictional fixture',null,12,8,['Adventure']],
].map(([anidbId,title,englishTitle,poster,total,verified,tags],i)=>({anidbId,title,englishTitle,poster,total,verified,tags,adult:false,type:total===1?'Movie':'TV Series',kind:total===1?'movie':'series',releaseStatus:anidbId===18003?'ONGOING':'FINISHED',rating:{source:'anilist',score:9.2-i*.17,votes:5000,members:800000-i*53000,checkedMs:stamp()},libraryPresence:present(verified),verifiedLibraryPresence:present(verified)}));
// Fictional Airing examples use public poster art solely to exercise the layout.
entries.push(...[entries[0],entries[1],entries[2]].map((base,i)=>({...base,
 anidbId:19000+i,title:base.title+' · airing layout fixture',englishTitle:base.englishTitle+' · airing fixture',
 total:12,verified:8,startYear:2026,startDate:'2026-10-01',catalogueSeason:'FALL',releaseStatus:'ONGOING',libraryPresence:present(8),verifiedLibraryPresence:present(8)})));
for(const e of entries){const ongoing=e.releaseStatus==='ONGOING',aired=ongoing?8:e.total;
 e.specialTotal=e.anidbId===17164?1:e.anidbId===15748?2:0;e.specialVerified=e.specialTotal?1:0;
 e.regularCoverage={kind:e.kind,specialTotal:e.specialTotal,specialVerified:e.specialVerified,total:e.total,verified:e.verified,aired,verifiedAired:Math.min(e.verified,aired),upcoming:e.total-aired,undated:0};
 e.libraryPresence.verifiedEpisodeCount=e.verified+e.specialVerified;e.verifiedLibraryPresence.verifiedEpisodeCount=e.verified+e.specialVerified;
 e.libraryPresence.regularCoverage=e.regularCoverage;e.verifiedLibraryPresence.regularCoverage=e.regularCoverage;
}
const find = id => entries.find(e=>e.anidbId===Number(id));
let requests,preferences,previews,sequence,errorSample;
const progress = (state,total,count=0) => ({state,targetCount:total,publicAvailability:count?'verified_recently':'unverified',publicVerifiedTargets:count});
function reset(){preferences={mode:'library',trackedAnidbIds:[18003]};previews=new Map();sequence=100;errorSample=false;requests=[
 {id:1,requesterId:1,requesterName:'Owner',anidbId:17823,title:'Dungeon Meshi',englishTitle:'Delicious in Dungeon',kind:'series',status:'held',episodeIds:Array.from({length:24},(_,i)=>1782301+i),monitorFuture:false,canCancel:false,progress:{...progress('download_unverified',24),transfer:{observedMs:stamp(),progressBasisPoints:6420,transferState:'active',etaSeconds:660}}},
 {id:2,requesterId:1,requesterName:'Owner',anidbId:15051,title:'Kusuriya no Hitorigoto',englishTitle:'The Apothecary Diaries',kind:'series',status:'held',episodeIds:Array.from({length:24},(_,i)=>1505101+i),monitorFuture:false,canCancel:false,progress:progress('review_needed',24)},
 {id:3,requesterId:1,requesterName:'Owner',anidbId:9589,title:'Kotonoha no Niwa',englishTitle:'The Garden of Words',kind:'movie',status:'held',episodeIds:[958901],monitorFuture:false,canCancel:false,progress:progress('saved',1,1)},
 {id:4,requesterId:1,requesterName:'Owner',anidbId:4158,title:'Pale Cocoon',kind:'movie',status:'cancelled',episodeIds:[415801],monitorFuture:false,canCancel:false,progress:progress('saved',1)},
 {id:5,requesterId:1,requesterName:'Owner',anidbId:18003,title:'Preview airing anime · fictional fixture',kind:'series',status:'held',episodeIds:Array.from({length:8},(_,i)=>1800301+i),monitorFuture:true,canCancel:true,progress:progress('saved',8,8)}];}
reset();
const descriptions={17164:'The Demon King has been defeated, and the hero’s party returns home. For the elven mage Frieren, ten years together passed in the blink of an eye. When she returns decades later, a farewell sends her on a new journey to understand the people she once travelled beside. With Fern and Stark at her side, everyday detours become memories worth keeping. This quiet adventure follows the traces of friendship, the passing of time, and the magic found in ordinary moments.',15748:'Hitori Gotoh dreams of playing guitar in a band, but meeting people is harder than learning a solo. When she joins Kessoku Band, rehearsals, live shows and awkward little victories begin to change her world.'};
const details=e=>{
 const ongoing=e.releaseStatus==='ONGOING';
 const activeWatch=requests.find(r=>r.anidbId===e.anidbId&&r.monitorFuture&&!r.watchClosed&&r.status!=='cancelled');
 const regular=Array.from({length:e.total},(_,i)=>({id:e.anidbId*100+i+1,number:i+1,type:'Episode',airDate:ongoing?(i<8?'2026-11-14':i===8?'2026-11-28':i===9?'2026-12-05':i===10?'2026-12-12':'2026-12-19'):'2024-03-22',title:e.anidbId===17164?['The Journey’s End','It Didn’t Have to Be Magic','Killing Magic','The Land Where Souls Rest'][i%4]:`Episode ${i+1}`,availability:i<e.verified?'available':'unknown'}));
 const specials=Array.from({length:e.specialTotal??0},(_,i)=>({id:e.anidbId*100+80+i,number:i+1,type:'Special',title:'Bonus special '+(i+1),availability:i<e.specialVerified?'available':'unknown'}));
 return {...e,state:'details',restricted:false,requestsOpen:true,futureEpisodesMonitored:Boolean(activeWatch),...(activeWatch?{activeWatchRequestId:activeWatch.id}:{}),page:1,total:regular.length+specials.length,nextPage:null,episodeCount:regular.length+specials.length,monitorFuture:ongoing,releaseState:ongoing?'airing':'completed',...(ongoing?{regularSchedule:{aired:8,upcoming:4,undated:0,verifiedAired:Math.min(e.verified,8),total:12,asOf:'2026-11-21',nextAirDate:'2026-11-28',nextEpisodeNumber:9}}:{}),regularSeason:{total:e.total,verified:e.verified},episodes:[...regular,...specials]};
};
const display=e=>({...e,state:'display',restricted:false,startYear:e.startYear??2023,startDate:e.startDate??'2023-09-29',endDate:e.releaseStatus==='ONGOING'?null:'2024-03-22',episodeCount:e.total,description:descriptions[e.anidbId]??'A new journey, an unexpected friendship, and a world full of stories. Follow this installment as its characters find their own way forward.',season:e.startYear===2026?'Autumn 2026':'Autumn 2023',studio:e.anidbId===17164?'Madhouse':'Production studio',durationMinutes:24});
function save(body){const e=find(body.anidbId)||entries[0],id=++sequence;requests.unshift({id,requesterId:1,requesterName:'Owner',...e,status:'held',episodeIds:body.episodeIds??details(e).episodes.filter(x=>x.type==='Episode'&&x.availability!=='available').map(x=>x.id),monitorFuture:body.monitorFuture===true,watchClosed:false,canCancel:true,progress:progress('saved',(body.episodeIds??details(e).episodes.filter(x=>x.type==='Episode'&&x.availability!=='available').map(x=>x.id)).length)});return {state:'held',requestId:id,created:true};}
function candidates(e){
 const variants=[['SubsPlease','WEB',1080,'japanese',true],['EMBER','BD',1080,'dual',true],['Judas','BD',720,'japanese',true],['Erai-raws','WEB',720,'japanese',false],['LostYears','WEB',1080,'english',false]];
 return variants.map(([group,source,resolution,audio,pack],i)=>({guid:'fixture-'+i,indexerId:1,title:'['+group+'] '+e.englishTitle+' - '+(pack?'01-'+String(e.total).padStart(2,'0')+' (Batch)':String(Math.min(e.verified+1,e.total)).padStart(2,'0'))+' ('+resolution+'p) ['+(source==='BD'?'BD':'WEB-DL')+'] ['+(audio==='dual'?'Dual Audio':audio==='english'?'English Dub':'Japanese Audio')+']',group,source,resolution,audio,...(i===2?{groupRegistration:{state:'listed',scope:'global',groupId:12345,name:group}}:{}),audioLabel:audio==='dual'?'JP+EN*':audio==='english'?'EN dub*':'JP*',qualityLabel:source+' / '+resolution+'p',size:1073741824*(pack?e.total:1),seeders:128-i*21,indexer:'Preview indexer · fixture',coverage:pack?'Full '+e.total+'-episode pack advertised':'Single episode advertised',coverageKind:pack?'advertised_pack':'single_episode',languageHints:audio==='dual'?'Japanese + English audio · English subtitles':audio==='english'?'English dub':'Japanese audio · English subtitles',eligible:true,token:'fixture-token-'+i}));
}
function filterCandidates(e,params){return candidates(e).filter(c=>{
 const q=(params.get('query')??'').toLowerCase(),quality=params.get('quality')??'bd1080',audio=params.get('audio')??'japanese';
 const qualityPass=quality==='all'||quality==='bd'&&c.source==='BD'||quality==='bd1080'&&(c.source==='BD'||c.resolution>=1080)||quality==='1080'&&c.resolution>=1080||quality==='720'&&c.resolution>=720;
 const audioPass=audio==='japanese_dual'?['japanese','dual'].includes(c.audio):audio===c.audio;
 return qualityPass&&audioPass&&(!q||c.title.toLowerCase().includes(q))&&(params.get('packsOnly')!=='true'||c.coverageKind==='advertised_pack');
 });}
function inspection(e,token,body={}){
 const index=Number(token?.split('-').at(-1))||0,c=candidates(e)[index]??candidates(e)[0];
 const requested=(body.episodeIds??details(e).episodes.filter(x=>x.type==='Episode'&&x.availability!=='available').map(x=>x.id));
 const represented=c.coverageKind==='advertised_pack'?details(e).episodes:details(e).episodes.filter(x=>x.number===Math.min(e.verified+1,e.total));
 const files=represented.filter(x=>requested.includes(x.id)).map(x=>({name:e.englishTitle+' - '+String(x.number).padStart(2,'0')+'.mkv',size:1073741824,episodeIds:[x.id]}));
 const filesToExclude=represented.filter(x=>!requested.includes(x.id)).map(x=>({name:e.englishTitle+' - '+String(x.number).padStart(2,'0')+'.mkv',size:1073741824,episodeIds:[x.id]}));
 const episodeIds=files.flatMap(f=>f.episodeIds);return {state:'preflight',torrentHash:'a'.repeat(40),episodeIds,files,filesToExclude,correspondence:{files:files.map(f=>({...f,state:index===0?'previously_verified':index===1?'likely':'unknown'}))},coverage:{coveredEpisodeCount:episodeIds.length,requestedEpisodeCount:requested.length}};
}
const banner=`<aside class="fixture-banner" aria-label="Development preview"><strong>Preview · sample data</strong><span>Local memory only. No real requests or downloads.</span><a href="/#/title/17164">Title sample</a><a href="/#/title/15748">8/12 partial season</a><a href="/__preview/comparison">Before / after</a><a href="/__preview/reset">Reset</a><a href="/__preview/error">Next read error</a></aside>`;
const bannerCss=`.fixture-banner{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:9px 16px;background:#30283e;color:#eee5ff;font:13px/1.4 system-ui;position:relative;z-index:5}.fixture-banner a{color:#dfc9ff;text-decoration:underline}.fixture-banner strong{font-size:12px;letter-spacing:.04em}@media(max-width:600px){.fixture-banner{gap:6px 12px;padding:7px 10px}.fixture-banner span,.fixture-banner a:nth-of-type(-n+3){display:none}}`;
const screenshotRoot=process.env.NEGEV_PREVIEW_SHOTS?resolve(process.env.NEGEV_PREVIEW_SHOTS):null;
const screenshotName=/^[a-z-]+\.jpg$/;
const escapeHtml=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const galleryCss='.preview-gallery{max-width:1440px;margin:auto;padding:24px;font:16px/1.5 system-ui;color:#ececf1}.preview-gallery a{color:#d5c2ff}.preview-gallery-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:24px}.preview-gallery figure{margin:0;min-width:0}.preview-gallery img{display:block;width:100%;height:260px;object-fit:contain;object-position:top;background:#121418;border:1px solid #333743;border-radius:10px}.preview-gallery figcaption{padding:8px 0}.preview-gallery h1{font-size:28px}.preview-gallery .muted{color:#b9bbc6}';
const mime={'.ttf':'font/ttf','.txt':'text/plain; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
export const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:4318'),path=url.pathname;
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Negev-Preview','fixture-only');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' https://cdn.myanimelist.net; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
 const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 const redirect=where=>{res.writeHead(303,{Location:where});res.end();};
 try{
  if(path==='/__preview/reset'){reset();return redirect('/#/discover');}
  if(path==='/__preview/error'){errorSample=true;return redirect('/#/discover');}
  if(path==='/__preview/comparison') {
   const afterRoot=screenshotRoot&&resolve(screenshotRoot,'../negev-visual-revision');
   const names=afterRoot?(await readdir(afterRoot)).filter(name=>screenshotName.test(name)).sort():[];
   const order=['desktop-discover.jpg','intermediate-discover.jpg','mobile-discover.jpg','desktop-title.jpg','mobile-title.jpg','desktop-request-scope.jpg','mobile-request-scope.jpg','desktop-release-picker.jpg','mobile-release-picker.jpg','desktop-request-receipt.jpg','desktop-auto-receipt.jpg','desktop-requests.jpg','mobile-requests.jpg','desktop-account.jpg','mobile-account.jpg','mobile-long-title.jpg','desktop-error-state.jpg'];names.sort((a,b)=>order.indexOf(a)-order.indexOf(b));
   const baselines=new Set(screenshotRoot?await readdir(screenshotRoot):[]);
   const pairs=names.filter(name=>baselines.has(name)).map(name=>'<section><h2>'+escapeHtml(name.replace('.jpg','').replaceAll('-',' '))+'</h2><div class="preview-gallery-grid"><figure><figcaption>Before</figcaption><a href="/__preview/screens/'+name+'"><img src="/__preview/screens/'+name+'" alt="Before '+escapeHtml(name)+'" loading="lazy"></a></figure><figure><figcaption>Revised</figcaption><a href="/__preview/revised/'+name+'"><img src="/__preview/revised/'+name+'" alt="Revised '+escapeHtml(name)+'" loading="lazy"></a></figure></div></section>').join('');
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Negev · Before and after</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/__preview/gallery.css"></head><body><main class="preview-gallery"><p><a href="/#/discover">Open working preview →</a></p><h1>Before and after</h1><p class="muted">Same sample data and viewport sizes. Open an image for its full capture.</p>'+pairs+'</main></body></html>');
  }
  if(path.startsWith('/__preview/revised/')) {
   const name=path.slice('/__preview/revised/'.length);if(!screenshotRoot||!screenshotName.test(name)){res.writeHead(404);return res.end();}
   const bytes=await readFile(resolve(screenshotRoot,'../negev-visual-revision',name));res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(bytes);
  }
  if(path==='/__preview/gallery.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});return res.end(galleryCss);}
  if(path==='/__preview/screens'||path==='/__preview/screens/'){
   let names=[];if(screenshotRoot)names=(await readdir(screenshotRoot,{withFileTypes:true})).filter(entry=>entry.isFile()&&screenshotName.test(entry.name)).map(entry=>entry.name).sort();
   const figures=names.map(name=>'<figure><a href="/__preview/screens/'+name+'"><img src="/__preview/screens/'+name+'" alt="'+escapeHtml(name.replace('.jpg','').replaceAll('-',' '))+'" loading="lazy"></a><figcaption><a href="/__preview/screens/'+name+'">'+escapeHtml(name.replace('.jpg','').replaceAll('-',' '))+'</a></figcaption></figure>').join('');
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Negev · Preview screenshots</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/__preview/gallery.css"></head><body><main class="preview-gallery"><p><a href="/#/discover">← Open working preview</a></p><h1>Development preview screenshots</h1><p class="muted">Captured fixture screens. All data and requests in the working preview are fictional.</p>'+(names.length?'<div class="preview-gallery-grid">'+figures+'</div>':'<p>No screenshots are configured yet.</p>')+'</main></body></html>');
  }
  if(path.startsWith('/__preview/screens/')){
   const name=path.slice('/__preview/screens/'.length);if(!screenshotRoot||!screenshotName.test(name))return json({error:'Screenshot not found'},404);
   const directory=await realpath(screenshotRoot),file=await realpath(resolve(directory,name));if(!file.startsWith(directory+sep))return json({error:'Screenshot not found'},404);
   const content=await readFile(file);res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(content);
  }
  if(path==='/__preview/banner.css'){res.writeHead(200,{'Content-Type':'text/css'});return res.end(bannerCss);}
  let body={};if(!['GET','HEAD'].includes(req.method)){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536)return json({error:'Fixture payload too large'},413);}body=raw?JSON.parse(raw):{};}
  if(errorSample&&req.method==='GET'&&['/api/seasons','/api/catalogue/search'].includes(path)){errorSample=false;return json({error:'Preview sample: catalogue temporarily unavailable. Retry to recover.'},503);}
  if(path==='/api/session')return json({user:{id:1,username:'Preview Owner',role:'admin',adultAllowed:true},csrfToken:'development-fixture-only',capabilities:{acquisitionState:'enabled',availabilityChecks:true,titleChecks:true,detailLoad:true,releaseSearch:true}});
  if(path==='/api/client-revision')return json({revision:'visual-preview'});
  if(path==='/api/admin/users')return json({state:'users',items:[{id:1,username:'Preview Owner',role:'admin',adultAllowed:true}]});
  if(path==='/api/seasons'||path==='/api/catalogue/search'){
   let items=[...entries];const q=(url.searchParams.get('q')??'').toLowerCase(),tag=(url.searchParams.get('tag')??url.searchParams.get('tags')??'').toLowerCase();
   if(q)items=items.filter(e=>`${e.title} ${e.englishTitle}`.toLowerCase().includes(q));
   if(tag)items=items.filter(e=>tag.split(',').filter(Boolean).every(value=>e.tags.some(t=>t.toLowerCase()===value)));
   const year=Number(url.searchParams.get('year')),season=url.searchParams.get('season');
   if(year)items=items.filter(e=>(e.startYear??2023)===year);
   if(season&&season!=='ALL')items=items.filter(e=>(e.catalogueSeason??'FALL')===season);
   const kind=url.searchParams.get('kind');if(kind&&kind!=='all')items=items.filter(e=>e.kind===kind);
   if(url.searchParams.get('status')==='ongoing')items=items.filter(e=>e.releaseStatus==='ONGOING');
   const sort=url.searchParams.get('sort');
   if(sort==='newest')items.sort((a,b)=>(b.startYear??2023)-(a.startYear??2023));
   if(sort==='oldest')items.sort((a,b)=>(a.startYear??2023)-(b.startYear??2023));
   if(sort==='title_asc')items.sort((a,b)=>a.title.localeCompare(b.title));
   if(sort==='title_desc')items.sort((a,b)=>b.title.localeCompare(a.title));
   if(sort==='score_desc')items.sort((a,b)=>b.rating.score-a.rating.score);
   if(sort==='popular_desc')items.sort((a,b)=>b.rating.members-a.rating.members);
   return json({state:path.endsWith('search')?'results':'ready',page:1,total:items.length,year:Number(url.searchParams.get('year')??2026),season:url.searchParams.get('season')??'FALL',sourceDate:'2026-11-21',availableTags:['Adventure','Comedy','Drama','Fantasy','Historical','Music','Mystery','Romance','Science fiction','Slice of life'],items,nextAfter:null,nextPage:null,catalogueSource:'development_fixture',orderState:sort==='score_desc'?'anilist_score':sort==='popular_desc'?'anilist_popular':undefined});
  }
  if(path==='/api/library')return json({state:'current_proofs',items:entries.filter(e=>e.verified).map(e=>({...e,verifiedEpisodeCount:e.verified+e.specialVerified,lastVerifiedMs:stamp()})),nextAfterAnidbId:null});
  if(path==='/api/airing/preferences'){if(req.method==='PUT')preferences=body;return json(preferences);}
  if(path==='/api/airing')return json({state:'ready',week:'2026-W47',checkedMs:stamp(),items:[{...find(18003),scheduledDate:'2026-11-28',episodeNumber:'9'},{...find(17823),scheduledDate:'2026-11-22',episodeNumber:'10'}]});
  if(path==='/api/request-preparations')return json({items:[],nextBeforeId:null});
  if(path==='/api/requests/seasons'&&req.method==='POST')return json({items:body.seasons.map(e=>({anidbId:e.anidbId,status:202,result:save(e)}))},202);
  if(path==='/api/requests'){if(req.method==='POST')return json(save(body),202);for(const item of requests)if(item.progress?.transfer)item.progress.transfer.observedMs=stamp();const id=Number(url.searchParams.get('requestId')),view=url.searchParams.get('view');const items=id?requests.filter(r=>r.id===id):view==='watching'?requests.filter(r=>r.monitorFuture&&!r.watchClosed&&r.status!=='cancelled'):view==='history'?requests.filter(r=>!r.monitorFuture||r.watchClosed||r.status==='cancelled'):requests;return json({items,nextBeforeId:null});}
  if(/^\/api\/requests\/\d+\/cancel$/.test(path)&&req.method==='POST'){const r=requests.find(r=>r.id===Number(path.split('/')[3]));if(r){r.status='cancelled';r.canCancel=false;}return json({state:'cancelled'});}
  if(path==='/api/release-previews'&&req.method==='POST'){const id=`preview-${++sequence}`;previews.set(id,{body,control:{mode:'manual',phase:'selecting',revision:1}});return json({state:'preview',previewId:id},201);}
  const release=path.match(/^\/api\/(release-previews|requests)\/([^/]+)\/(release-choice|releases|release-inspection)$/);
  if(release){const [,kind,id,action]=release;let p=previews.get(id);if(kind==='requests'){p=previews.get(`request-${id}`);if(!p){const r=requests.find(r=>r.id===Number(id));p={body:{anidbId:r?.anidbId??17164},control:{mode:'manual',phase:'selecting',revision:1},requestId:Number(id)};previews.set(`request-${id}`,p);}}if(!p)return json({error:'Fixture preview expired',reason:'release_preview_expired'},404);
   const e=find(p.body.anidbId)??entries[0],context={completedSeries:e.releaseStatus==='FINISHED',confirmedAiring:e.releaseStatus==='ONGOING',preferredGroup:p.control.preference?.group??null};
   if(action==='releases'){const items=filterCandidates(e,url.searchParams);return json({...context,state:'candidates',items,filteredOut:candidates(e).length-items.length,nextOffset:null});}
   if(action==='release-inspection'||body.action==='inspect')return json(inspection(e,url.searchParams.get('token')??body.token,p.body));
   if(req.method==='POST'){p.control.revision++;if(body.action==='begin'){p.control.mode=body.mode;p.control.phase='selecting';}if(body.action==='preference')p.control.preference=body.group?{group:body.group}:null;
    if(['choose','auto'].includes(body.action)){const candidate=candidates(e).find(c=>c.token===body.token)??candidates(e)[0];p.control.mode=body.action==='auto'?'auto':'manual';p.control.phase='chosen';p.control.selection={candidate,preview:inspection(e,candidate.token,p.body),registration:'confirmed'};p.requestId??=save(p.body).requestId;previews.set(`request-${p.requestId}`,p);}
   }
   return json({state:req.method==='POST'?'updated':'ready',control:p.control,context,...(p.requestId?{requestId:p.requestId,created:true}:{})});
  }
  const catalogue=path.match(/^\/api\/catalogue\/(\d+)(?:\/(.*))?$/);
  if(catalogue){const e=find(catalogue[1]);if(!e)return json({error:'No fixture exists for this title'},404);const suffix=catalogue[2];if(suffix==='display')return json(display(e));if(suffix==='related')return json({state:'related_titles',anidbId:e.anidbId,completeness:'unproven',incomplete:false,items:(e.anidbId===17164?[18000,18001]:e.anidbId===15748?[18002]:[]).map(id=>({...find(id),relation:'Sequel'}))});if(suffix==='title-check')return json({state:'not_started'});if(suffix?.startsWith('episodes/')){const id=Number(suffix.split('/')[1]),episode=details(e).episodes.find(x=>x.id===id);return json({state:episode?.availability??'unknown',availability:episode?.availability??'unknown'});}return json(details(e));}
  const poster=path.match(/^\/api\/catalogue\/posters\/anidb\/(\d+)$/);if(poster){const e=find(poster[1]);if(e?.poster){res.writeHead(302,{Location:e.poster});return res.end();}res.writeHead(404);return res.end();}
  if(path.startsWith('/api/'))return json({error:'This action is unavailable in the development fixture.'},404);
  if(!['GET','HEAD'].includes(req.method))return json({error:'Development fixture only'},405);
  const relative=path==='/'?'index.html':decodeURIComponent(path).slice(1),file=resolve(root,relative);if(!file.startsWith(resolve(root)+sep))return json({error:'Not found'},404);
  let content=await readFile(file);if(relative==='index.html')content=content.toString().replace('</head>','<link rel="stylesheet" href="/__preview/banner.css"></head>').replace('<body>','<body>'+banner);
  res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream'});res.end(req.method==='HEAD'?undefined:content);
 }catch(error){if(error.code==='ENOENT'){res.writeHead(404);res.end();}else{console.error('Fixture handler:',error.message);json({error:'Preview fixture could not handle this action'},500);}}
});
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){server.listen(4318,'127.0.0.1',()=>console.log('Negev DEV FIXTURE preview: http://127.0.0.1:4318 · no real requests/downloads'));}


