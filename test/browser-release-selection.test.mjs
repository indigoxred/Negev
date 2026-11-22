import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync,readFileSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const browser=[process.env.NEGEV_TEST_BROWSER,'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
const source=['release-choice-fields.mjs','release-row.mjs','release-dialog.mjs'].map(name=>readFileSync(new URL('../src/web/public/'+name,import.meta.url),'utf8').replace(/^import .*;$/gm,'').replaceAll('export ','')).join('\n');
const css=['style.css','consumer.css'].map(name=>readFileSync(new URL('../src/web/public/'+name,import.meta.url),'utf8')).join('\n');
test('release dialog preserves manual choice through polling and offers alternatives only in Auto search',
  {skip:browser?false:'No Chrome or Edge browser installed'},()=>{
    const dir=mkdtempSync(join(tmpdir(),'negev-release-browser-'));
    try{
      const html=`<!doctype html><meta charset="utf-8"><style>${css}</style><div id="request-list"></div><pre id="result">pending</pre><script>
${source}
window.IntersectionObserver=undefined; // Explicit Details fallback; the next fixture uses native visibility.
const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const candidate={guid:'one',indexerId:1,title:'[Group] Example WEB 1080p',group:'Group',source:'WEB',resolution:1080,size:1000,seeders:20,indexer:'Test Nyaa',coverage:'Inspect coverage',languageHints:'Languages not advertised',eligible:true,token:'receipt'};
const preview={torrentHash:'a'.repeat(40),episodeIds:[1],files:[{name:'Example 01.mkv',size:1000,episodeIds:[1]}],correspondence:{files:[{name:'Example 01.mkv',size:1000,state:'unknown'}]}};
const selection={candidate,preview,registration:'unknown'};
let holdInspection=false,releaseInspection;let inspectionFailure="torrent_preflight_unavailable",inspectionCalls=0;let holdExistingRead=false,releaseExistingRead;let previewWrites=0,previewSaved=null,completedMode=false,delegatedMode=false,alternativeRegistration='likely';let searchUrls=[],lastPreferenceAudio=null;
let control={mode:'manual',phase:'selecting',revision:1},autoCalls=0,chooseCalls=0,decision=null,failedMore=false,preferredFlag=false;
const api=async(url,options={})=>{
 if(url.endsWith('/release-choice')&&!options.method&&holdExistingRead)return new Promise((resolve,reject)=>{releaseExistingRead={resolve,reject};});
 if(url.endsWith('/release-choice')&&!options.method)return {control,context:{completedSeries:completedMode,confirmedAiring:!completedMode,preferredGroup:control.preference?.group??null,...(delegatedMode?{preferredGroup:'SubsPlease',preferredWait:{group:'SubsPlease',deadlineMs:Date.now()+7200000}}:{})}};
 if(url.includes('offset=50')&&!failedMore){failedMore=true;throw new Error('Temporary indexer outage');}
 if(url.includes('/releases'))searchUrls.push(url);
 if(url.includes('/releases'))return url.includes('offset=50')
   ?{state:'candidates',items:[{...candidate,guid:'two',title:'[Another] Example WEB 1080p',token:'second'}],nextOffset:null,confirmedAiring:!completedMode,completedSeries:completedMode}
   :{state:'candidates',items:[candidate],nextOffset:50,confirmedAiring:!completedMode,completedSeries:completedMode};
 const body=JSON.parse(options.body);if(url.includes('/release-previews/'))previewWrites++;
 if(body.action==='inspect'){inspectionCalls++;if(holdInspection)return new Promise((resolve,reject)=>{releaseInspection={resolve,reject};});if(inspectionFailure){const reason=inspectionFailure;inspectionFailure=false;throw Object.assign(Error('Transient inspection failed'),{reason});}}
 if(body.action==='inspect')return {state:'preflight',requestId:Number.MAX_SAFE_INTEGER,...preview};
 if(body.action==='preference'){lastPreferenceAudio=body.audio;control={...control,preference:body.group?{group:body.group,audio:body.audio}:null,revision:control.revision+1};}
 if(body.action==='begin')control={mode:body.mode,phase:'selecting',revision:control.revision+1};
 if(body.action==='choose'){preferredFlag ||=body.preferFutureGroup===true;chooseCalls++;control={mode:'manual',phase:'chosen',revision:control.revision+1,selection};}
 if(body.action==='auto'&&delegatedMode)return {state:'updated',control:{mode:'auto',phase:'consumed',revision:control.revision+1,preference:{group:'SubsPlease'}},context:{confirmedAiring:true,preferredGroup:'SubsPlease',preferredWait:{group:'SubsPlease',deadlineMs:Date.now()+7200000}}};
 if(body.action==='auto'){autoCalls++;control={mode:'auto',phase:'proposal',revision:control.revision+1,expiresMs:Date.now()+300000,proposal:{registered:{...selection,registration:alternativeRegistration},better:{...selection,candidate:{...candidate,title:'[Better] Example BD 1080p',source:'Blu-ray'}},benefit:'Blu-ray source'}};}
 if(['better','registered'].includes(body.action)){decision=body.action;control={mode:'auto',phase:'chosen',revision:control.revision+1,selection};}
 return {state:'updated',control,...(url.includes('/release-previews/')&&body.action==='choose'?{requestId:42}:{})};
};
const dialog=createReleaseDialog({api,element});
const tick=()=>new Promise(r=>setTimeout(r,20));
const click=text=>[...document.querySelectorAll('dialog button')].find(b=>b.textContent===text).click();
(async()=>{
 let modePicked=null;const picker=makeReleaseActions(element,{onAuto:()=>{modePicked='auto'},onManual:()=>{modePicked='manual'}});document.body.append(picker.element);
 picker.auto.click();picker.manual.click();const requestModes=picker.auto.textContent==='Auto-Pick'&&picker.manual.textContent==='Manual Pick'&&modePicked==='manual';
 await dialog.open({requestId:1,title:'Example',mode:'manual'});
 const airingPackHidden=document.querySelector('[aria-label="Season packs only"]')?.closest('label').hidden===true;
 const manualHasNoPrompt=!document.querySelector('dialog').textContent.includes('Grab better release')&&autoCalls===0;
 click('Show more releases');await tick();
 const recoveredPage=document.querySelectorAll('dialog .release-entry').length===1;
 click('Show more releases');await tick();
 const paged=document.querySelectorAll('dialog .release-entry').length===2;
 document.querySelector('#request-list').replaceChildren(element('p','Refreshed request card'));
 const survived=Boolean(document.querySelector('dialog[open] .release-entry'));
 document.querySelector('dialog .release-file-evidence').open=true;await tick();
 const beforeRetry=inspectionCalls,searchesBeforeRetry=searchUrls.length;await tick();const noInspectionLoop=inspectionCalls===beforeRetry;
 const retry=[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Retry inspection');if(retry)retry.click();await tick();
 const sameResultRetry=Boolean(retry)&&inspectionCalls===beforeRetry+1&&!document.querySelector('[role=status]').textContent.includes('Transient inspection failed')&&searchUrls.length===searchesBeforeRetry;

 const unknownGrey=document.querySelector('.release-entry .registration-unknown')!==null;
 const coverage=document.querySelector('dialog').textContent.includes('AniDB episode 1');
 const compact=document.querySelector('.release-row-main').getBoundingClientRect().height<120;
 const defaults=document.querySelector('[aria-label=Quality]').value==='bd1080'&&document.querySelector('[aria-label=Audio]').value==='japanese_dual';
 document.querySelector('[aria-label="Prefer this release group for future episodes"]').checked=true;
 click('Pick');await tick();
 const saved=document.querySelector('dialog').textContent.includes('Request #1 submitted')&&chooseCalls===1;
 const savedLink=document.querySelector('dialog a[href="#/requests?requestId=1"]')?.textContent==='View request';
 click('Close');control={mode:'auto',phase:'selecting',revision:10};
 await dialog.open({requestId:1,title:'Example',mode:'auto'});
 const prompt=document.querySelector('dialog').textContent.includes('Grab better release')&&document.querySelector('dialog').textContent.includes('Use likely match')&&!document.querySelector('dialog').textContent.toLowerCase().includes('registered release')&&document.querySelector('dialog').textContent.includes('five minutes');
 click('Use likely match');await tick();
 const receiptPrefs=document.querySelector('dialog .receipt-preferences');receiptPrefs.open=true;
 document.querySelector('dialog .release-preference-editor').open=true;
 const futurePreferences=document.querySelector('dialog .release-prefer-future input').getBoundingClientRect().width>0&&[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Save group').getBoundingClientRect().width>0;
 const autoFeedback=[...document.querySelectorAll('dialog .release-mode-actions button')].find(b=>b.textContent==='Auto-Pick').classList.contains('primary')&&/[0-9]+ episodes? requested · Auto-Pick/.test(document.querySelector('dialog').textContent)&&document.querySelector('dialog .release-mode-actions').hidden&&document.querySelector('dialog .release-search-actions').hidden;
 dialog.close();
 alternativeRegistration='confirmed';control={mode:'auto',phase:'selecting',revision:1};
 await dialog.open({requestId:1,title:'Verified example',mode:'auto'});
 const confirmedPrompt=document.querySelector('dialog').textContent.includes('Use verified release')&&document.querySelector('dialog').textContent.includes('Previously verified files');dialog.close();
 alternativeRegistration='unknown';control={mode:'auto',phase:'selecting',revision:1};
 await dialog.open({requestId:1,title:'Unknown example',mode:'auto'});
 const unknownPrompt=document.querySelector('dialog').textContent.includes('Use alternative release')&&!document.querySelector('dialog .registration-confirmed');dialog.close();
 control={mode:'manual',phase:'selecting',revision:1};inspectionFailure='release_search_expired';
 await dialog.open({requestId:1,title:'Expired results',mode:'manual'});document.querySelector('dialog .release-file-evidence').open=true;await tick();
 const expiredInspectionNoRetry=![...document.querySelectorAll('dialog button')].some(b=>b.textContent==='Retry inspection')&&document.querySelector('dialog').textContent.includes('Search again');dialog.close();
 control={mode:'auto',phase:'consumed',revision:20};
 await dialog.open({requestId:1,title:'Reopened manual search',mode:'manual'});
 if(document.querySelector('dialog').classList.contains('is-submitted')||document.querySelector('dialog .release-mode-actions').hidden||document.querySelector('dialog').getBoundingClientRect().width<600)throw Error('A reopened search must restore the wide picker and visible mode controls');
 dialog.close();
 const beforeRepeat={autoCalls,chooseCalls};control={mode:'manual',phase:'chosen',revision:22,selection};
 await dialog.open({requestId:1,title:'Existing request',mode:'auto',existing:true});
 const existingSuccess=document.querySelector('dialog').textContent.includes('Request #1 already submitted')&&document.querySelector('dialog a[href="#/requests?requestId=1"]')&&document.querySelector('dialog').textContent.includes('[Group] Example WEB 1080p')&&document.querySelector('dialog .release-mode-actions').hidden&&beforeRepeat.autoCalls===autoCalls&&beforeRepeat.chooseCalls===chooseCalls;
 dialog.close();holdExistingRead=true;
 const slowOpen=dialog.open({requestId:1,title:'Existing slow request',existing:true});await tick();
 const existingLoadingSafe=document.querySelector('dialog .release-mode-actions').hidden&&document.querySelector('dialog .release-search-actions').hidden&&document.querySelector('dialog').textContent.includes('Request #1 already submitted');
 releaseExistingRead.reject(Error('Read temporarily unavailable'));await slowOpen;
 const existingReadRecovery=document.querySelector('dialog').textContent.includes('Request #1 already submitted')&&Boolean(document.querySelector('dialog a[href="#/requests?requestId=1"]'));holdExistingRead=false;dialog.close();
 const closed=!document.querySelector('dialog');
 control={mode:'manual',phase:'selecting',revision:1};
 const draftDialog=createReleaseDialog({api,element,onSaved:data=>{previewSaved=data;}});
 await draftDialog.open({previewId:'preview-token',title:'Preview',mode:'manual'});
 document.querySelector('dialog .release-preference-editor').open=true;click('Clear preference');await tick();
 const draftPreferenceUnsubmitted=previewSaved===null;
 click('Close');await tick();
 const abandonedPreview=previewWrites===1&&previewSaved===null;
 await draftDialog.open({previewId:'preview-token',title:'Preview',mode:'manual'});
 click('Pick');await tick();
 const committedPreview=previewSaved?.requestId===42&&previewSaved?.previewId==='preview-token'&&Boolean(document.querySelector('dialog a[href="#/requests?requestId=42"]'));
 draftDialog.close();
 const beforePack=previewWrites;completedMode=true;control={mode:'manual',phase:'selecting',revision:1};searchUrls=[];
 await draftDialog.open({previewId:'pack-preview',title:'Completed Example',mode:'manual'});
 const checkbox=document.querySelector('[aria-label="Season packs only"]');
 const packDefault=checkbox.checked&&!checkbox.closest('label').hidden&&searchUrls[0].includes('packsOnly=true');
 click('Show more releases');await tick();
 checkbox.checked=false;checkbox.dispatchEvent(new Event('change'));await tick();
 const filterReset=searchUrls.at(-1).includes('packsOnly=false')&&!searchUrls.at(-1).includes('offset=')&&document.querySelectorAll('dialog .release-entry').length===1;
 click('Show more releases');await tick();
 const packPage=searchUrls.at(-1).includes('packsOnly=false')&&searchUrls.at(-1).includes('offset=50');
 const packReadOnly=previewWrites===beforePack;draftDialog.close();
 completedMode=false;delegatedMode=true;control={mode:'auto',phase:'selecting',revision:1,preference:{group:'SubsPlease'}};
 await dialog.open({requestId:1,title:'Airing Example',mode:'auto'});
 const groupFeedback=document.querySelector('dialog').textContent.includes('Preferred group: SubsPlease')&&document.querySelector('dialog').textContent.includes('Until ');
 dialog.close();let lateInspectionGuard=true;delegatedMode=false;
 control={mode:'auto',phase:'consumed',revision:40,preference:{group:'SubsPlease',audio:'dual'}};
 const beforePreferenceSearch=searchUrls.length,beforePreferenceAuto=autoCalls,beforePreferenceChoose=chooseCalls;
 holdExistingRead=true;const preferenceOpening=dialog.open({requestId:1,title:'Airing preference',preferenceOnly:true});await tick();
 const preferenceLoadingSafe=document.querySelector('.release-mode-actions').hidden&&document.querySelector('.release-search-actions').hidden;
 click('Auto-Pick');click('Manual Pick');click('Search');await tick();
 releaseExistingRead.resolve({control,context:{confirmedAiring:true,preferredGroup:'SubsPlease'}});holdExistingRead=false;await preferenceOpening;
 const preferenceOnly=document.querySelector('.release-mode-actions').hidden&&document.querySelector('.release-search-actions').hidden&&document.querySelector('.release-preference-editor').open&&document.querySelector('[aria-label="Preferred release group"]').value==='SubsPlease';
 document.querySelector('[aria-label="Preferred release group"]').value='Erai-raws';click('Save group');await tick();
 const preferenceAudioPreserved=lastPreferenceAudio==='dual'&&control.preference?.group==='Erai-raws'&&control.phase==='consumed'&&document.querySelector('[role=status]').textContent.includes('saved');
 click('Clear preference');await tick();
 const preferenceNoAcquisition=control.preference===null&&control.phase==='consumed'&&searchUrls.length===beforePreferenceSearch&&autoCalls===beforePreferenceAuto&&chooseCalls===beforePreferenceChoose;
 dialog.close();
 for(const outcome of ['success','failure']){
  control={mode:'manual',phase:'selecting',revision:1};await dialog.open({requestId:1,title:'Pending inspection',mode:'manual'});holdInspection=true;
  document.querySelector('dialog .release-file-evidence').open=true;await tick();click('Auto-Pick');await tick();
  if(outcome==='success')releaseInspection.resolve({state:'preflight',...preview});else releaseInspection.reject(Error('Late inspection failure'));
  await tick();holdInspection=false;
  lateInspectionGuard&&=document.querySelector('dialog').textContent.includes('Grab better release')&&document.querySelector('[role=status]').textContent.includes('better release')&&!document.querySelector('[role=status]').textContent.includes('Late inspection failure');dialog.close();
 }
 document.querySelector('#result').textContent=JSON.stringify({requestModes,manualHasNoPrompt,recoveredPage,paged,survived,unknownGrey,noInspectionLoop,sameResultRetry,expiredInspectionNoRetry,lateInspectionGuard,coverage,compact,defaults,saved,savedLink,autoFeedback,futurePreferences,prompt,confirmedPrompt,unknownPrompt,existingSuccess:Boolean(existingSuccess),existingLoadingSafe,existingReadRecovery,decision,autoCalls,closed,abandonedPreview,draftPreferenceUnsubmitted,committedPreview,preferredFlag,airingPackHidden,packDefault,filterReset,packPage,packReadOnly,groupFeedback,preferenceLoadingSafe,preferenceOnly,preferenceAudioPreserved,preferenceNoAcquisition});
})().catch(e=>{document.querySelector('#result').textContent='ERROR '+e.message;});
</script>`;
      const file=join(dir,'test.html');writeFileSync(file,html);
      const dom=execFileSync(browser,['--headless=new','--no-first-run','--disable-gpu','--disable-dev-shm-usage','--no-sandbox',
        `--user-data-dir=${join(dir,'profile')}`,'--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],
        {encoding:'utf8',timeout:25000,stdio:['ignore','pipe','ignore'],windowsHide:true});
      const match=dom.match(/<pre id="result">([^<]+)<\/pre>/);assert.ok(match,dom.slice(-600));
      const result=JSON.parse(match[1].replaceAll('&quot;','"'));
      assert.deepEqual(result,{requestModes:true,manualHasNoPrompt:true,recoveredPage:true,paged:true,survived:true,unknownGrey:true,noInspectionLoop:true,sameResultRetry:true,expiredInspectionNoRetry:true,lateInspectionGuard:true,coverage:true,compact:true,defaults:true,saved:true,savedLink:true,autoFeedback:true,futurePreferences:true,prompt:true,confirmedPrompt:true,unknownPrompt:true,existingSuccess:true,existingLoadingSafe:true,existingReadRecovery:true,decision:'registered',autoCalls:5,closed:true,abandonedPreview:true,draftPreferenceUnsubmitted:true,committedPreview:true,preferredFlag:true,airingPackHidden:true,packDefault:true,filterReset:true,packPage:true,packReadOnly:true,groupFeedback:true,preferenceLoadingSafe:true,preferenceOnly:true,preferenceAudioPreserved:true,preferenceNoAcquisition:true});
    }finally{rmSync(dir,{recursive:true,force:true});}
});

test('release dialog preserves manual choice through polling and offers alternatives only in Auto search: AniDB evidence visibility',
 {skip:browser?false:'No Chrome or Edge browser installed'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'negev-registration-browser-'));let child,socket,closed;const wait=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  const html=`<!doctype html><meta charset="utf-8"><style>${css} dialog{max-height:430px;overflow:auto}.release-compact-row{min-height:110px}</style><pre id="result">pending</pre><script>
${source}
const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const base={guid:'one',indexerId:1,title:'[Group] Example 1080p',size:1000,seeders:20,indexer:'Test',coverage:'Inspect coverage',languageHints:'Languages not advertised',eligible:true};
const items=['likely','previously_verified','unknown','mixed',...Array.from({length:10},(_,i)=>'hidden'+i)].map((state,i)=>({...base,guid:state,title:'[Group] '+state+' 1080p',token:state}));
let inspected=[],inspectedAt=[],commands=[],inFlight=0,maxInFlight=0;
const api=async(url,options={})=>{
 if(!options.method&&url.endsWith('/release-choice'))return{control:{mode:'manual',phase:'selecting',revision:1},context:{}};
 if(url.includes('/releases'))return{state:'candidates',items,nextOffset:null};
 const body=url.includes('/release-inspection?')?{action:'inspect',token:new URL(url,'http://local').searchParams.get('token')}:JSON.parse(options.body);commands.push(body.action);if(body.action!=='inspect')throw Error('Browsing attempted a mutation');
 inspected.push(body.token);inspectedAt.push(performance.now());inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await new Promise(r=>setTimeout(r,10));inFlight--;
 const files=[{name:'01.mkv',size:1000,episodeIds:[1]}];if(body.token==='mixed')files.push({name:'02.mkv',size:2000,episodeIds:[2]});
 return{state:'preflight',episodeIds:[1],files,correspondence:{files:files.map((f,i)=>({...f,state:body.token==='mixed'?(i?'unknown':'likely'):body.token==='likely'||body.token==='previously_verified'?body.token:'unknown'}))}};
};
const tick=()=>new Promise(r=>setTimeout(r,20));const until=async fn=>{for(let i=0;i<400;i++){if(fn())return;await tick();}throw Error('Timed out waiting for visible evidence '+JSON.stringify({inspected,rows:[...document.querySelectorAll('.release-compact-row')].slice(0,4).map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON()})),dialog:document.querySelector('dialog').getBoundingClientRect().toJSON()}));};
(async()=>{
 const dialog=createReleaseDialog({api,element});await dialog.open({requestId:1,title:'Evidence Example'});
 await until(()=>document.querySelector('.release-compact-row .registration-likely'));
 const row=document.querySelector('.release-compact-row'),badge=row.querySelector('.release-registration');
 const likelyGreen=getComputedStyle(badge).color==='rgb(142, 231, 182)'&&getComputedStyle(row.querySelector('strong')).color==='rgb(142, 231, 182)'&&badge.textContent==='Likely AniDB-listed file'&&badge.title.includes('not exact');
 const noDetailsNeeded=!row.querySelector('details').open&&row.textContent.includes('CRC32 and size');
 await until(()=>document.querySelectorAll('.release-compact-row')[1].querySelector('.registration-confirmed'));
 const rows=()=>[...document.querySelectorAll('.release-compact-row')];
 const verified=rows()[1].querySelector('.registration-confirmed')!==null;
 const hiddenUntouched=!inspected.includes('hidden9');
 rows()[3].scrollIntoView();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await until(()=>rows()[3].textContent.includes('AniDB episode'));
 const unknownGrey=rows()[2].querySelector('.registration-unknown')!==null&&!rows()[2].classList.contains('release-anidb-match');
 const mixedGrey=!rows()[3].classList.contains('release-anidb-match')&&rows()[3].querySelector('.registration-unknown')!==null;
 dialog.close();await tick();const before=inspected.length;await tick();await tick();const closedStops=inspected.length===before;
 document.querySelector('#result').textContent=JSON.stringify({likelyGreen,noDetailsNeeded,verified,unknownGrey,mixedGrey,hiddenUntouched,serial:maxInFlight===1,paced:inspectedAt.slice(1).every((t,i)=>t-inspectedAt[i]>=1000),readOnly:commands.every(x=>x==='inspect'),closedStops});
})().catch(e=>document.querySelector('#result').textContent='ERROR '+e.message);
</script>`;
  const file=join(dir,'test.html');writeFileSync(file,html);
  child=spawn(browser,['--headless=new','--no-first-run','--disable-gpu','--disable-dev-shm-usage','--no-sandbox','--remote-debugging-port=0','--user-data-dir='+join(dir,'profile'),pathToFileURL(file).href],{stdio:'ignore',windowsHide:true});
  closed=new Promise(r=>child.once('close',r));let port;
  for(let i=0;i<80;i++){try{port=Number(readFileSync(join(dir,'profile','DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch{await wait(100);}}
  assert.ok(port,'Browser debugging port unavailable');
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let nextId=0;const pending=new Map();socket.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  let result='pending';for(let i=0;i<250;i++){result=(await send('Runtime.evaluate',{expression:"document.querySelector('#result')?.textContent",returnByValue:true})).result.value;if(result&&result!=='pending')break;await wait(100);}
  assert.ok(result&&result!=='pending'&&!result.startsWith('ERROR'),result);assert.deepEqual(JSON.parse(result),{likelyGreen:true,noDetailsNeeded:true,verified:true,unknownGrey:true,mixedGrey:true,hiddenUntouched:true,serial:true,paced:true,readOnly:true,closedStops:true});
 }finally{socket?.close();if(child){child.kill();await closed;}rmSync(dir,{recursive:true,force:true});}
});

test('release dialog preserves manual choice through polling and offers alternatives only in Auto search: Pick during inspection',
 {skip:browser?false:'No Chrome or Edge browser installed'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'negev-pick-pending-'));
 try{
 const html=`<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script>${source}
 const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const tick=()=>new Promise(r=>setTimeout(r,20));
 (async()=>{const outcomes=[];for(const state of ['success','failure','owned']){
 let finish,start,busy=false,chosen=0,errors=[],selected=0;
 const row=compactReleaseRow({candidate:{title:'[EMBER] Example (Batch) 1080p',eligible:true,size:1000,seeders:20},element,
 inspect:()=>new Promise((resolve,reject)=>{finish=()=>state==='failure'?reject(Object.assign(Error('Temporary provider failure'),{reason:'torrent_preflight_unavailable'})):resolve({files:[{name:'01.mkv',size:1000,episodeIds:[1]}],episodeIds:[1],selectionStatus:state==='owned'?'already_available':'eligible'});}),
 choose:async()=>{chosen++;return{requestId:42};},isCurrent:()=>true,isBusy:()=>busy,setBusy:v=>busy=v,onError:(e,opts)=>{errors.push(opts?.background===true?'background':'explicit');return e.message;},onSelected:()=>selected++,observeEvidence:(_el,inspect)=>start=inspect});
 document.body.append(row);const pending=start();await tick();const button=row.querySelector('button');const enabled=!button.disabled;button.click();await tick();const acknowledged=button.textContent==='Checking…';finish();await pending;await tick();outcomes.push({state,enabled,acknowledged,chosen,selected,explicitError:errors.includes('explicit')});row.remove();
 }document.querySelector('#result').textContent=JSON.stringify(outcomes);})().catch(e=>document.querySelector('#result').textContent='ERROR '+e.message);
 </script>`;
 const file=join(dir,'test.html');writeFileSync(file,html);const dom=execFileSync(browser,['--headless=new','--no-first-run','--disable-gpu','--disable-dev-shm-usage','--no-sandbox',`--user-data-dir=${join(dir,'profile')}`,'--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:25000,stdio:['ignore','pipe','ignore'],windowsHide:true});const match=dom.match(/<pre id="result">([^<]+)<\/pre>/);assert.ok(match,dom.slice(-500));assert.deepEqual(JSON.parse(match[1].replaceAll('&quot;','"')),[{state:'success',enabled:true,acknowledged:true,chosen:1,selected:1,explicitError:false},{state:'failure',enabled:true,acknowledged:true,chosen:0,selected:0,explicitError:true},{state:'owned',enabled:true,acknowledged:true,chosen:0,selected:0,explicitError:false}]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('release dialog preserves manual choice through polling and offers alternatives only in Auto search: global group indicator',
 {skip:browser?false:'No Chrome or Edge browser installed'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'negev-global-group-'));
 try{
 const html=`<!doctype html><meta charset="utf-8"><style>${css}</style><pre id="result">pending</pre><script>${source}
 const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const tick=()=>new Promise(r=>setTimeout(r,20));
 (async()=>{const outcomes=[];for(const listed of [true,false]){let start;
 const row=compactReleaseRow({candidate:{title:'[EMBER] Example Batch 1080p',eligible:true,size:1000,groupRegistration:listed?{state:'listed',scope:'global',groupId:16037,name:'EMBER'}:null},element,
 inspect:async()=>{throw Error('File provider unavailable')},choose:async()=>{throw Error('Must not select')},isCurrent:()=>true,isBusy:()=>false,setBusy:()=>{},onError:e=>e.message,onSelected:()=>{},observeEvidence:(_el,fn)=>start=fn});document.body.append(row);
 const badge=row.querySelector('.registration-group');const initialGreen=row.classList.contains('release-anidb-match');const actualGreen=getComputedStyle(row.querySelector('strong')).color==='rgb(142, 231, 182)';await start();await tick();outcomes.push({listed,initialGreen,actualGreen,afterFailure:row.classList.contains('release-anidb-match'),label:badge?.textContent??null,global:badge?.title.includes('globally')??false,enabled:!row.querySelector('.release-pick').disabled});row.remove();}
 document.querySelector('#result').textContent=JSON.stringify(outcomes);})();
 </script>`;
 const file=join(dir,'test.html');writeFileSync(file,html);const dom=execFileSync(browser,['--headless=new','--no-first-run','--disable-gpu','--disable-dev-shm-usage','--no-sandbox',`--user-data-dir=${join(dir,'profile')}`,'--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:25000,stdio:['ignore','pipe','ignore'],windowsHide:true});const match=dom.match(/<pre id="result">([^<]+)<\/pre>/);assert.ok(match,dom.slice(-500));assert.deepEqual(JSON.parse(match[1].replaceAll('&quot;','"')),[{listed:true,initialGreen:true,actualGreen:true,afterFailure:true,label:'Group listed on AniDB (global)',global:true,enabled:true},{listed:false,initialGreen:false,actualGreen:false,afterFailure:false,label:null,global:false,enabled:true}]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('release dialog preserves manual choice through polling and offers alternatives only in Auto search: rejected file listing',
 {skip:browser?false:'No Chrome or Edge browser installed'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'negev-inspection-list-'));
 try{
 const html=`<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script>${source}
 const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const tick=()=>new Promise(r=>setTimeout(r,20));
 (async()=>{let chosen=0;const row=compactReleaseRow({candidate:{title:'[Group] Example Season 02 batch 1080p',eligible:true,size:1000},element,
 inspect:async()=>({state:'inspection',reason:'release_title_mismatch',selectionStatus:'rejected',files:[{name:'Season 02/01.mkv',size:1000,type:'video'},{name:'Season 02/Extras/Soundtrack.flac',size:500,type:null}]}),
 choose:async()=>{chosen++;},isCurrent:()=>true,isBusy:()=>false,setBusy:()=>{},onError:e=>e.reason,onSelected:()=>{throw Error('inspection must not save');}});
 document.body.append(row);row.querySelector('details').open=true;await tick();await tick();row.querySelector('.release-pick').click();
 document.querySelector('#result').textContent=JSON.stringify({files:[...row.querySelectorAll('.release-inspected-file')].map(x=>x.textContent),blocked:row.querySelector('.release-pick').disabled,chosen,summary:row.querySelector('summary').textContent,registration:row.querySelector('.release-registration').textContent});})();
 </script>`;
 const file=join(dir,'test.html');writeFileSync(file,html);const dom=execFileSync(browser,['--headless=new','--no-first-run','--disable-gpu','--disable-dev-shm-usage','--no-sandbox',`--user-data-dir=${join(dir,'profile')}`,'--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:25000,stdio:['ignore','pipe','ignore'],windowsHide:true});const match=dom.match(/<pre id="result">([^<]+)<\/pre>/);assert.ok(match,dom.slice(-500));assert.deepEqual(JSON.parse(match[1].replaceAll('&quot;','"')),{files:['Season 02/01.mkv · 1,000 bytes · video','Season 02/Extras/Soundtrack.flac · 500 bytes · other'],blocked:true,chosen:0,summary:'Details · 2 files · selection not approved',registration:'File registration unknown'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
