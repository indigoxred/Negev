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
let control={mode:'manual',phase:'selecting',revision:1},autoCalls=0,chooseCalls=0,decision=null,failedMore=false,preferredFlag=false;
const api=async(url,options={})=>{
 if(url.endsWith('/release-choice')&&!options.method)return {control};
 if(url.includes('offset=50')&&!failedMore){failedMore=true;throw new Error('Temporary indexer outage');}
 if(url.includes('/releases'))return url.includes('offset=50')
   ?{state:'candidates',items:[{...candidate,guid:'two',title:'[Another] Example WEB 1080p',token:'second'}],nextOffset:null,confirmedAiring:true}
   :{state:'candidates',items:[candidate],nextOffset:50,confirmedAiring:true};
 const body=JSON.parse(options.body);
 if(body.action==='inspect')return {state:'preflight',...preview};
 if(body.action==='begin')control={mode:body.mode,phase:'selecting',revision:control.revision+1};
 if(body.action==='choose'){preferredFlag=body.preferFutureGroup===true;chooseCalls++;control={mode:'manual',phase:'chosen',revision:control.revision+1,selection};}
 if(body.action==='auto'){autoCalls++;control={mode:'auto',phase:'proposal',revision:control.revision+1,expiresMs:Date.now()+300000,proposal:{registered:{...selection,registration:'likely'},better:{...selection,candidate:{...candidate,title:'[Better] Example BD 1080p',source:'Blu-ray'}},benefit:'Blu-ray source'}};}
 if(['better','registered'].includes(body.action)){decision=body.action;control={mode:'auto',phase:'chosen',revision:control.revision+1,selection};}
 return {state:'updated',control};
};
const dialog=createReleaseDialog({api,element});
const tick=()=>new Promise(r=>setTimeout(r,20));
const click=text=>[...document.querySelectorAll('dialog button')].find(b=>b.textContent===text).click();
(async()=>{
 let modePicked=null;const picker=makeReleaseActions(element,{onAuto:()=>{modePicked='auto'},onManual:()=>{modePicked='manual'}});document.body.append(picker.element);
 picker.auto.click();picker.manual.click();const requestModes=picker.auto.textContent==='Auto-Pick'&&picker.manual.textContent==='Manual Pick'&&modePicked==='manual';
 await dialog.open({requestId:1,title:'Example',mode:'manual'});
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
 const saved=document.querySelector('dialog').textContent.includes('Exact release saved')&&chooseCalls===1;
 click('Close');control={mode:'auto',phase:'selecting',revision:10};
 await dialog.open({requestId:1,title:'Example',mode:'auto'});
 const prompt=document.querySelector('dialog').textContent.includes('Grab better release')&&document.querySelector('dialog').textContent.includes('Use registered release')&&document.querySelector('dialog').textContent.includes('five minutes');
 click('Use registered release');await tick();
 dialog.close();
 const closed=!document.querySelector('dialog');
 document.querySelector('#result').textContent=JSON.stringify({requestModes,manualHasNoPrompt,recoveredPage,paged,survived,unknownGrey,coverage,compact,defaults,saved,prompt,decision,autoCalls,closed,preferredFlag});
})().catch(e=>{document.querySelector('#result').textContent='ERROR '+e.message;});
</script>`;
      const file=join(dir,'test.html');writeFileSync(file,html);
      const dom=execFileSync(browser,['--headless=new','--no-first-run','--disable-gpu','--disable-dev-shm-usage','--no-sandbox',
        `--user-data-dir=${join(dir,'profile')}`,'--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],
        {encoding:'utf8',timeout:25000,stdio:['ignore','pipe','ignore'],windowsHide:true});
      const match=dom.match(/<pre id="result">([^<]+)<\/pre>/);assert.ok(match,dom.slice(-600));
      const result=JSON.parse(match[1].replaceAll('&quot;','"'));
      assert.deepEqual(result,{requestModes:true,manualHasNoPrompt:true,recoveredPage:true,paged:true,survived:true,unknownGrey:true,coverage:true,compact:true,defaults:true,saved:true,prompt:true,decision:'registered',autoCalls:1,closed:true,preferredFlag:true});
    }finally{rmSync(dir,{recursive:true,force:true});}
});
