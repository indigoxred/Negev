import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync,readFileSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const browser=[process.env.NEGEV_TEST_BROWSER,'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
const source=readFileSync(new URL('../src/web/public/release-dialog.mjs',import.meta.url),'utf8').replaceAll('export function','function');
test('release dialog preserves manual choice through polling and offers alternatives only in Auto search',
  {skip:browser?false:'No Chrome or Edge browser installed'},()=>{
    const dir=mkdtempSync(join(tmpdir(),'negev-release-browser-'));
    try{
      const html=`<!doctype html><meta charset="utf-8"><div id="request-list"></div><pre id="result">pending</pre><script>
${source}
const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const candidate={guid:'one',indexerId:1,title:'[Group] Example WEB 1080p',group:'Group',source:'WEB',resolution:1080,size:1000,seeders:20,indexer:'Test Nyaa',coverage:'Inspect coverage',languageHints:'Languages not advertised',eligible:true,token:'receipt'};
const preview={torrentHash:'a'.repeat(40),episodeIds:[1],files:[{name:'Example 01.mkv',size:1000,episodeIds:[1]}],correspondence:{files:[{name:'Example 01.mkv',size:1000,state:'unknown'}]}};
const selection={candidate,preview,registration:'unknown'};
let control={mode:'manual',phase:'selecting',revision:1},autoCalls=0,chooseCalls=0,decision=null;
const api=async(url,options={})=>{
 if(url.endsWith('/release-choice')&&!options.method)return {control};
 if(url.includes('/releases'))return {state:'candidates',items:[candidate]};
 const body=JSON.parse(options.body);
 if(body.action==='inspect')return {state:'preflight',...preview};
 if(body.action==='begin')control={mode:body.mode,phase:'selecting',revision:control.revision+1};
 if(body.action==='choose'){chooseCalls++;control={mode:'manual',phase:'chosen',revision:control.revision+1,selection};}
 if(body.action==='auto'){autoCalls++;control={mode:'auto',phase:'proposal',revision:control.revision+1,expiresMs:Date.now()+300000,proposal:{registered:{...selection,registration:'likely'},better:{...selection,candidate:{...candidate,title:'[Better] Example BD 1080p',source:'Blu-ray'}},benefit:'Blu-ray source'}};}
 if(['better','registered'].includes(body.action)){decision=body.action;control={mode:'auto',phase:'chosen',revision:control.revision+1,selection};}
 return {state:'updated',control};
};
const dialog=createReleaseDialog({api,element});
const tick=()=>new Promise(r=>setTimeout(r,20));
const click=text=>[...document.querySelectorAll('dialog button')].find(b=>b.textContent===text).click();
(async()=>{
 const picker=makeReleaseModePicker(element);document.body.append(picker.element);
 const pickerDefaults=picker.value()==='auto_review';
 await dialog.open({requestId:1,title:'Example',mode:'manual'});
 const manualHasNoPrompt=!document.querySelector('dialog').textContent.includes('Grab better release')&&autoCalls===0;
 document.querySelector('#request-list').replaceChildren(element('p','Refreshed request card'));
 const survived=Boolean(document.querySelector('dialog[open] .release-entry'));
 click('Inspect files');await tick();
 const unknownGrey=document.querySelector('.release-entry .registration-unknown')!==null;
 const coverage=document.querySelector('dialog').textContent.includes('AniDB episode 1');
 click('Grab this release');await tick();
 const saved=document.querySelector('dialog').textContent.includes('Exact release saved')&&chooseCalls===1;
 click('Close');control={mode:'auto',phase:'selecting',revision:10};
 await dialog.open({requestId:1,title:'Example',mode:'auto'});
 const prompt=document.querySelector('dialog').textContent.includes('Grab better release')&&document.querySelector('dialog').textContent.includes('Use registered release')&&document.querySelector('dialog').textContent.includes('five minutes');
 click('Use registered release');await tick();
 document.querySelector('#result').textContent=JSON.stringify({pickerDefaults,manualHasNoPrompt,survived,unknownGrey,coverage,saved,prompt,decision,autoCalls});
})().catch(e=>{document.querySelector('#result').textContent='ERROR '+e.message;});
</script>`;
      const file=join(dir,'test.html');writeFileSync(file,html);
      const dom=execFileSync(browser,['--headless=new','--no-first-run','--disable-gpu','--disable-dev-shm-usage','--no-sandbox',
        `--user-data-dir=${join(dir,'profile')}`,'--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],
        {encoding:'utf8',timeout:25000,stdio:['ignore','pipe','ignore'],windowsHide:true});
      const match=dom.match(/<pre id="result">([^<]+)<\/pre>/);assert.ok(match,dom.slice(-600));
      const result=JSON.parse(match[1].replaceAll('&quot;','"'));
      assert.deepEqual(result,{pickerDefaults:true,manualHasNoPrompt:true,survived:true,unknownGrey:true,coverage:true,saved:true,prompt:true,decision:'registered',autoCalls:1});
    }finally{rmSync(dir,{recursive:true,force:true});}
});
