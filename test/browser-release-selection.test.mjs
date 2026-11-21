import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync,readFileSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const browser=[process.env.NEGEV_TEST_BROWSER,'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
const source=['release-choice-fields.mjs','release-row.mjs','release-dialog.mjs'].map(name=>readFileSync(new URL('../src/web/public/'+name,import.meta.url),'utf8').replace(/^import .*;$/gm,'').replaceAll('export ','')).join('\n');
const css=readFileSync(new URL('../src/web/public/consumer.css',import.meta.url),'utf8');
test('release dialog preserves manual choice through polling and offers alternatives only in Auto search',
  {skip:browser?false:'No Chrome or Edge browser installed'},()=>{
    const dir=mkdtempSync(join(tmpdir(),'negev-release-browser-'));
    try{
      const html=`<!doctype html><meta charset="utf-8"><style>${css}</style><div id="request-list"></div><pre id="result">pending</pre><script>
${source}
const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const candidate={guid:'one',indexerId:1,title:'[Group] Example WEB 1080p',group:'Group',source:'WEB',resolution:1080,size:1000,seeders:20,indexer:'Test Nyaa',coverage:'Inspect coverage',languageHints:'Languages not advertised',eligible:true,token:'receipt'};
const preview={torrentHash:'a'.repeat(40),episodeIds:[1],files:[{name:'Example 01.mkv',size:1000,episodeIds:[1]}],correspondence:{files:[{name:'Example 01.mkv',size:1000,state:'unknown'}]}};
const selection={candidate,preview,registration:'unknown'};
let holdExistingRead=false,releaseExistingRead;let previewWrites=0,previewSaved=null,completedMode=false,delegatedMode=false,alternativeRegistration='likely';let searchUrls=[];
let control={mode:'manual',phase:'selecting',revision:1},autoCalls=0,chooseCalls=0,decision=null,failedMore=false,preferredFlag=false;
const api=async(url,options={})=>{
 if(url.endsWith('/release-choice')&&!options.method&&holdExistingRead)return new Promise((resolve,reject)=>{releaseExistingRead={resolve,reject};});
 if(url.endsWith('/release-choice')&&!options.method)return {control,context:{completedSeries:completedMode,confirmedAiring:!completedMode,...(delegatedMode?{preferredGroup:'SubsPlease',preferredWait:{group:'SubsPlease',deadlineMs:Date.now()+7200000}}:{})}};
 if(url.includes('offset=50')&&!failedMore){failedMore=true;throw new Error('Temporary indexer outage');}
 if(url.includes('/releases'))searchUrls.push(url);
 if(url.includes('/releases'))return url.includes('offset=50')
   ?{state:'candidates',items:[{...candidate,guid:'two',title:'[Another] Example WEB 1080p',token:'second'}],nextOffset:null,confirmedAiring:!completedMode,completedSeries:completedMode}
   :{state:'candidates',items:[candidate],nextOffset:50,confirmedAiring:!completedMode,completedSeries:completedMode};
 const body=JSON.parse(options.body);if(url.includes('/release-previews/'))previewWrites++;
 if(body.action==='inspect')return {state:'preflight',requestId:Number.MAX_SAFE_INTEGER,...preview};
 if(body.action==='preference')control={...control,preference:null,revision:control.revision+1};
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
 const unknownGrey=document.querySelector('.release-entry .registration-unknown')!==null;
 const coverage=document.querySelector('dialog').textContent.includes('AniDB episode 1');
 const compact=document.querySelector('.release-compact-row').getBoundingClientRect().height<160;
 const defaults=document.querySelector('[aria-label=Quality]').value==='bd1080'&&document.querySelector('[aria-label=Audio]').value==='japanese';
 document.querySelector('[aria-label="Prefer this release group for future episodes"]').checked=true;
 click('Pick');await tick();
 const saved=document.querySelector('dialog').textContent.includes('Request #1 submitted')&&chooseCalls===1;
 const savedLink=document.querySelector('dialog a[href="#/requests?requestId=1"]')?.textContent==='View request';
 click('Close');control={mode:'auto',phase:'selecting',revision:10};
 await dialog.open({requestId:1,title:'Example',mode:'auto'});
 const prompt=document.querySelector('dialog').textContent.includes('Grab better release')&&document.querySelector('dialog').textContent.includes('Use likely match')&&!document.querySelector('dialog').textContent.toLowerCase().includes('registered release')&&document.querySelector('dialog').textContent.includes('five minutes');
 click('Use likely match');await tick();
 const autoFeedback=[...document.querySelectorAll('dialog .release-mode-actions button')].find(b=>b.textContent==='Auto-Pick').classList.contains('primary')&&document.querySelector('dialog').textContent.includes('Auto-Pick selected this release');
 dialog.close();
 alternativeRegistration='confirmed';control={mode:'auto',phase:'selecting',revision:1};
 await dialog.open({requestId:1,title:'Verified example',mode:'auto'});
 const confirmedPrompt=document.querySelector('dialog').textContent.includes('Use verified release')&&document.querySelector('dialog').textContent.includes('Previously verified exact AniDB files');dialog.close();
 alternativeRegistration='unknown';control={mode:'auto',phase:'selecting',revision:1};
 await dialog.open({requestId:1,title:'Unknown example',mode:'auto'});
 const unknownPrompt=document.querySelector('dialog').textContent.includes('Use alternative release')&&!document.querySelector('dialog .registration-confirmed');dialog.close();
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
 dialog.close();
 document.querySelector('#result').textContent=JSON.stringify({requestModes,manualHasNoPrompt,recoveredPage,paged,survived,unknownGrey,coverage,compact,defaults,saved,savedLink,autoFeedback,prompt,confirmedPrompt,unknownPrompt,existingSuccess:Boolean(existingSuccess),existingLoadingSafe,existingReadRecovery,decision,autoCalls,closed,abandonedPreview,draftPreferenceUnsubmitted,committedPreview,preferredFlag,airingPackHidden,packDefault,filterReset,packPage,packReadOnly,groupFeedback});
})().catch(e=>{document.querySelector('#result').textContent='ERROR '+e.message;});
</script>`;
      const file=join(dir,'test.html');writeFileSync(file,html);
      const dom=execFileSync(browser,['--headless=new','--no-first-run','--disable-gpu','--disable-dev-shm-usage','--no-sandbox',
        `--user-data-dir=${join(dir,'profile')}`,'--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],
        {encoding:'utf8',timeout:25000,stdio:['ignore','pipe','ignore'],windowsHide:true});
      const match=dom.match(/<pre id="result">([^<]+)<\/pre>/);assert.ok(match,dom.slice(-600));
      const result=JSON.parse(match[1].replaceAll('&quot;','"'));
      assert.deepEqual(result,{requestModes:true,manualHasNoPrompt:true,recoveredPage:true,paged:true,survived:true,unknownGrey:true,coverage:true,compact:true,defaults:true,saved:true,savedLink:true,autoFeedback:true,prompt:true,confirmedPrompt:true,unknownPrompt:true,existingSuccess:true,existingLoadingSafe:true,existingReadRecovery:true,decision:'registered',autoCalls:3,closed:true,abandonedPreview:true,draftPreferenceUnsubmitted:true,committedPreview:true,preferredFlag:true,airingPackHidden:true,packDefault:true,filterReset:true,packPage:true,packReadOnly:true,groupFeedback:true});
    }finally{rmSync(dir,{recursive:true,force:true});}
});
