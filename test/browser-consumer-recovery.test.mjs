import { preferenceEditorReady, preferenceSaveReady } from './helpers/preference-readiness.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const browser = [process.env.NEGEV_TEST_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);
const root = new URL('../src/web/public/', import.meta.url);
const assets = new Set(['index.html', 'app.js', 'style.css', 'consumer.css',
  'card-availability.mjs', 'request-key.mjs', 'request-feedback.mjs', 'episode-pages.mjs', 'search-pages.mjs',
  'request-progress-text.mjs', 'response-epoch.mjs', 'franchise-explorer.mjs',
  'adult-search-visibility.mjs', 'chinese-visibility.mjs',
  'airing-tracking-controls.mjs',
  'acquisition-notice.mjs', 'consumer-route.mjs',
  'season-availability-presentation.mjs', 'season-request-selection.mjs',
  'episode-schedule.mjs',
  'detail-refresh.mjs', 'poster-recovery.mjs',
  'relation-label.mjs', 'title-preference.mjs', 'release-dialog.mjs', 'release-choice-fields.mjs', 'release-row.mjs']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('title and library controls recover from pending and failed reads without duplicate writes',
  { skip: browser ? false : 'No Chrome or Edge browser installed' }, async () => {
    let monitoredTitle = false;let seasonResult=null;
    let previewPending=false;let previewExisting=false;let previewOpens=0;const preferenceCommands=[];const submittedModes=[]; let filmResult=null; let control={mode:"manual",phase:"selecting",revision:1};
    let holdNextRequest = false;
    let heldRequestResponse = null;
    let titleReads = 0;
    let firstTitleResponse = null;
    let detailPosts = 0;
    let detailReady = false;
    let holdNextDetailPost = false;
    let heldDetailResponse = null;
    let failedTitleReads = 0;
    let recoveredDisplayReads = 0;
    let pageTwoReads = 0;
    let firstLibraryReads = 0;
    let searchReads = 0;
    let requestReads = 0;
    let historyReads = 0;
    let historyBarrier = null;
    let operationalReads = 0;
    let olderRequestReads = 0;
    let proofReady = false;
    let transferObservedMs = null,transferBasisPoints=3750,requestProposal=false,requestAiring=false;
    let newHistoryRequest = false;
    let holdWatchingRequests = true;
    let holdFirstSession = true;
    let heldSessionResponse = null;
    const heldWatchingResponses = [];
    const json = (response, data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      response.setHeader('Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'");
      if (path === '/api/session') {
        if (holdFirstSession) {
          holdFirstSession = false;
          heldSessionResponse = response;
          return;
        }
        json(response, { user: { id: 1, username: 'Owner', role: 'admin',
          adultAllowed: true }, csrfToken: 'test', capabilities: {
          detailLoad: true, releaseSearch: true, acquisitionState: 'disabled' } });
      } else if (path === '/api/logout') {
        json(response, { state: 'signed_out' });
      } else if (path === '/api/admin/review') {
        operationalReads++;
        json(response, { items: [{attemptId:66,requestId:6,anidbId:2,title:'Older completed title',englishTitle:'Full English title',stage:'start_hold',reason:'provider_unavailable',observedMs:1}], nextAfterAttemptId: null });
      } else if (path === '/api/catalogue/1' && request.method === 'GET') {
        titleReads++;
        if (titleReads === 1) { firstTitleResponse = response; return; }
        json(response, detailReady ? { state: 'details', anidbId: 1,
          title: 'Pending title', kind: 'movie', restricted:false, page: 1, total: 1, nextPage: null,
          plexUrl: 'https://app.plex.tv/desktop/#!/server/' + 'a'.repeat(40) +
            '/details?key=%2Flibrary%2Fmetadata%2F502',
          episodes: [{ id: 11, number: 1, type: 'Episode', title: 'Film' }] } :
          { state: 'detail_pending', anidbId: 1, title: 'Pending title' });
      } else if (path === '/api/catalogue/1/load-detail' && request.method === 'POST') {
        detailPosts++;
        if (holdNextDetailPost) {
          holdNextDetailPost = false;
          heldDetailResponse = response;
        } else json(response, { state: 'pending' });
      } else if (path === '/api/catalogue/1/display') {
        json(response, { state: 'display', anidbId: 1, title: 'Pending title',
          englishTitle: null, type: 'TV Series', startYear: 2026,
          description: 'The catalogue summary is already ready.', tags: [] });
      } else if (path === '/api/catalogue/2') {
        failedTitleReads++;
        json(response, failedTitleReads === 1 ? { error: 'temporarily unavailable' } :
          { state: 'details', anidbId: 2, title: 'Recovered title',
            kind: 'movie', page: 1, total: 0, nextPage: null, episodes: [] },
        failedTitleReads === 1 ? 503 : 200);
      } else if (path === '/api/catalogue/2/display') {
        recoveredDisplayReads++;
        json(response, recoveredDisplayReads === 1
          ? { error: 'temporarily unavailable' }
          : { state: 'display', anidbId: 2, title: 'Recovered title',
            description: 'The recovered catalogue summary.', tags: [] },
        recoveredDisplayReads === 1 ? 503 : 200);
      } else if (path === '/api/catalogue/3') {
        json(response,{state:'details',anidbId:3,title:'Series example',kind:'series',restricted:false,page:1,total:1,nextPage:null,...(monitoredTitle?{futureEpisodesMonitored:true,activeWatchRequestId:123}:{}),episodes:[{id:31,number:1,type:'Episode',title:'First episode',availability:'missing'}]});
      } else if(path === '/api/catalogue/3/display') {
        json(response,{state:'display',anidbId:3,title:'Series example',type:'TV Series',description:'Series synopsis',tags:[]});
      } else if(path.endsWith('/related')) {json(response,{state:'related',items:[],nextPage:null});
      } else if(path === '/api/release-previews') {
        previewOpens++;let body='';for await(const chunk of request)body+=chunk;
        json(response,previewPending?{state:'pending',intentId:900,created:false}:previewExisting?{state:'existing',requestId:123,created:false}:{state:'preview',previewId:'preview-'+previewOpens});
      } else if(path.startsWith('/api/release-previews/')&&path.endsWith('/release-choice')) {
        if(request.method==='POST'){let body='';for await(const chunk of request)body+=chunk;const value=JSON.parse(body);if(value.action==='preference')preferenceCommands.push(value);control={...control,mode:value.mode??control.mode,phase:'selecting',revision:control.revision+1,...(value.action==='preference'?{preference:{group:value.group,audio:value.audio}}:{})};}
        json(response,{state:'updated',control,context:{confirmedAiring:true,preferredGroup:control.preference?.group??null}});
      } else if(path.startsWith('/api/release-previews/')&&path.endsWith('/releases')) {
        json(response,{state:'candidates',items:[],nextOffset:null,confirmedAiring:true});
      } else if(path === '/api/requests/seasons' || path === '/api/requests' && request.method === 'POST') {
        let body='';for await(const chunk of request)body+=chunk;
        const value=JSON.parse(body);submittedModes.push(value.seasons?.[0]?.releaseMode??value.releaseMode);
        if (holdNextRequest) { holdNextRequest = false; heldRequestResponse = response; return; }
        json(response,value.seasons?{items:[{anidbId:3,status:201,result:seasonResult??{state:'saved',created:true,requestId:123}}]}:filmResult??{state:'saved',created:true,requestId:123});
      } else if(path === '/api/requests/7/release-choice') {
        json(response,{state:'selection',control:{mode:'auto',phase:'consumed',revision:9,preference:{group:'SubsPlease',audio:'dual'}},context:{confirmedAiring:true,preferredGroup:'SubsPlease'}});
      } else if(path === '/api/requests/123/release-choice') {
        if(request.method==='POST'){let body='';for await(const chunk of request)body+=chunk;const value=JSON.parse(body);control={mode:value.mode??control.mode,phase:value.action==='auto'?'consumed':'selecting',revision:control.revision+1};}
        json(response,{state:'updated',control});
      } else if(path === '/api/requests/123/releases') {json(response,{state:'candidates',items:[],nextOffset:null});
      } else if (path === '/api/library') {
        if (url.searchParams.has('afterAnidbId')) pageTwoReads++;
        else firstLibraryReads++;
        if (pageTwoReads === 1 && url.searchParams.has('afterAnidbId')) {
          json(response, { error: 'temporarily unavailable' }, 503);
        } else {
          json(response, { state: 'current_proofs', items: [{
            anidbId: url.searchParams.has('afterAnidbId') ? 2 : 1,
            title: url.searchParams.has('afterAnidbId') ? 'Second title' :
              proofReady ? 'Updated title' : 'First title',
            verifiedEpisodeCount: 1 }],
          nextAfterAnidbId: url.searchParams.has('afterAnidbId') ? null : 1 });
        }
      } else if (path === '/api/catalogue/search') {
        searchReads++;
        json(response, { state: 'results', page: 1, total: 1,
          catalogueSource: 'test', items: [{ anidbId: 1, title: 'Pending title',
          kind: 'movie', libraryPresence: proofReady
            ? { state: 'in_library', verifiedEpisodeCount: 1 }
            : { state: 'unknown', verifiedEpisodeCount: 0 } }] });
      } else if (path === '/api/requests') {
        requestReads++;
        if(url.searchParams.get('requestId')==='123'){
          assert.equal(url.searchParams.get('view'),'all');
          json(response,{items:[{id:123,anidbId:3,title:'Series example',kind:'series',episodeIds:[31],monitorFuture:true,watchClosed:false,progress:{state:'saved',targetCount:1,publicAvailability:'verified_recently',publicVerifiedTargets:1}}],nextBeforeId:null});return;
        }
        if(url.searchParams.has('requestId')){
          json(response,{items:[{id:6,anidbId:2,title:'Older completed title',englishTitle:'Full English title',kind:'movie',episodeIds:[21],monitorFuture:false,watchClosed:false,
            progress:{state:'saved',targetCount:1,publicAvailability:'verified_recently',publicVerifiedTargets:1,oneTimeAcquisitionComplete:true}}],nextBeforeId:null});return;
        }
        if (url.searchParams.get('view') === 'watching' && holdWatchingRequests) {
          response.writeHead(200, { 'Content-Type': 'application/json',
            'Cache-Control': 'no-store' });
          response.flushHeaders();
          heldWatchingResponses.push(response);
          return;
        }
        const history = url.searchParams.get('view') === 'history';
        if (history) { historyReads++; if(historyBarrier)await historyBarrier; }
        const older = url.searchParams.get('beforeId') === '7';
        if (history && older) olderRequestReads++;
        json(response, { items: history
          ? [...(!older && newHistoryRequest ? [{ id: 8, anidbId: 3,
            title: 'New request', kind: 'movie', episodeIds: [31],
            monitorFuture: false, watchClosed: false,
            progress: { state: 'saved', targetCount: 1,
              publicAvailability: 'unverified' } }] : []),
          older ? { id: 6, anidbId: 2, title: 'Older completed title',
            kind: 'movie', episodeIds: [21], monitorFuture: false,
            watchClosed: false, progress: { state: 'saved', targetCount: 1,
              publicAvailability: 'unverified', publicVerifiedTargets: 0,
              oneTimeAcquisitionComplete: true } } :
          { id: 7, anidbId: 1, title: 'Pending title', kind: requestAiring?'series':'movie', status: 'held', requesterId: 8, canCancel: true,
            episodeIds: [11], monitorFuture: requestAiring, watchClosed: !requestAiring,releasePreference:requestAiring?{group:'SubsPlease',audio:'dual'}:null,
            ...(requestProposal?{releaseSelection:{mode:'auto',phase:'proposal'}}:{}),
            progress: { state: transferObservedMs === null ? 'saved' :
              'download_unverified', targetCount: 1,
              publicAvailability: proofReady ? 'verified_recently' : 'unverified',
              publicVerifiedTargets: proofReady ? 1 : 0,
              ...(transferObservedMs === null || requestProposal ? {} : { transfer: {
                progressBasisPoints: transferBasisPoints, etaSeconds: 120,
                speedBytesPerSecond: 512, transferState: 'active',
                observedMs: transferObservedMs } }) } }] : [],
        nextBeforeId: history && !older ? 7 : null });
      } else {
        const file = path === '/' ? 'index.html' : path.slice(1);
        if (!assets.has(file)) { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' :
          file.endsWith('.html') ? 'text/html' : 'text/javascript');
        response.end(await readFile(new URL(file, root)));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const profile = await mkdtemp(join(tmpdir(), 'negev-recovery-'));
    const child = spawn(browser, ['--headless=new', '--no-first-run',
      '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let socket;
    try {
      let port;
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
          break;
        } catch { await wait(100); }
      }
      assert.ok(port, 'Browser debugging port unavailable');
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      socket = new WebSocket(pages.find((entry) => entry.type === 'page').webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      let nextId = 0;
      const pending = new Map();
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        const target = pending.get(message.id);
        if (!target) return;
        pending.delete(message.id);
        if (message.error) target.reject(new Error(message.error.message));
        else target.resolve(message.result);
      });
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async (expression) => (await send('Runtime.evaluate',
        { expression, returnByValue: true })).result.value;
      // A cached title can still satisfy content assertions while its view is
      // hidden. Await the actual hashchange before interacting; otherwise a
      // legitimate route transition can close the dialog the test just opened.
      const navigate = async (hash) => {
        const expression = 'new Promise(resolve => { const hash = '+JSON.stringify(hash)+'; if(location.hash===hash){resolve(true);return;} window.addEventListener("hashchange",()=>resolve(true),{once:true}); location.hash=hash; })';
        const result = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
        assert.equal(result.result?.value,true,'hash navigation completes before interacting');
      };
      const until = async (expression) => {
        for (let attempt = 0; attempt < 300; attempt++) {
          if (await evaluate(expression)) return;
          await wait(100);
        }
        const release=await evaluate("(() => {const d=document.querySelector('dialog.release-search-dialog[open]');return d?{modal:d.matches(':modal'),text:d.textContent,controls:[...d.querySelectorAll('button,input,summary')].map(e=>({label:e.textContent||e.getAttribute('aria-label'),disabled:e.disabled,visible:e.getClientRects().length>0}))}:null})()");
        assert.fail(`release=${JSON.stringify(release)}; preferenceCommands=${JSON.stringify(preferenceCommands)}; UI did not reach expected state: ${expression}; detail=${await evaluate("document.querySelector('#detail')?.textContent")}; requests=${await evaluate("document.querySelector('#request-list')?.textContent")}; reads=${requestReads}; hidden=${await evaluate('document.hidden')}; error=${await evaluate("document.querySelector('#message')?.textContent")}`);
      };
      await send('Emulation.setDeviceMetricsOverride', {width:1280,height:900,deviceScaleFactor:1,mobile:false});
      const base = `http://127.0.0.1:${server.address().port}`;
      await send('Page.navigate', { url: `${base}/#/title/1` });
      for (let attempt = 0; attempt < 80 && !heldSessionResponse; attempt++) {
        await wait(100);
      }
      assert.ok(heldSessionResponse, 'initial session check is pending');
      assert.deepEqual(await evaluate(`({authHidden: document.querySelector('#auth').hidden,
        authDisplay: getComputedStyle(document.querySelector('#auth')).display,
        loaderVisible: !document.querySelector('#session-loading').hidden,
        workspaceHidden: document.querySelector('#workspace').hidden})`),
      { authHidden: true, authDisplay: 'none', loaderVisible: true,
        workspaceHidden: true }, 'a slow signed-in session must not flash sign-in');
      json(heldSessionResponse, { user: { id: 1, username: 'Owner', role: 'admin',
        adultAllowed: true }, csrfToken: 'test', capabilities: {
          detailLoad: true, releaseSearch: true, acquisitionState: 'disabled' } });
      heldSessionResponse = null;
      await until("document.querySelector('#detail')?.textContent.includes('The catalogue summary is already ready.')");
      assert.equal(await evaluate("document.querySelector('#session-loading').hidden"), true);
      json(firstTitleResponse, { state: 'detail_pending', anidbId: 1,
        title: 'Pending title' });
      firstTitleResponse = null;
      for (let attempt = 0; attempt < 80 && heldWatchingResponses.length < 1; attempt++) {
        await wait(100);
      }
      assert.equal(heldWatchingResponses.length, 1);
      assert.ok(historyReads > 0, 'History starts while Watching is pending');
      assert.ok(operationalReads > 0,
        'owner review starts while Watching is pending');
      holdWatchingRequests = false;
      heldWatchingResponses.shift().end(JSON.stringify({ items: [], nextBeforeId: null }));
      await until("document.querySelector('#detail')?.textContent.includes('You can request this title now')");
      await until("document.querySelector('#detail')?.textContent.includes('The catalogue summary is already ready.')");
      for (let attempt = 0; attempt < 80 && detailPosts < 1; attempt++) await wait(100);
      assert.equal(detailPosts, 1);
      detailReady = true;
      await navigate("#/discover");
      await until("!document.querySelector('#view-discover').hidden");
      await navigate("#/title/1");
      await until("document.querySelector('#detail')?.textContent.includes('Film · 1 listed AniDB entry')");
      assert.equal(await evaluate("document.querySelector('#detail a[data-plex-link]')?.textContent"),
        undefined, 'title details do not add an optional Plex link');
      assert.equal(detailPosts, 1, 'ready state must use GET, not repeat hydration POST');
      detailReady = false;
      await navigate("#/discover");
      await until("!document.querySelector('#view-discover').hidden");
      holdNextDetailPost = true;
      await navigate("#/title/1");
      for (let attempt = 0; attempt < 80 && !heldDetailResponse; attempt++) await wait(100);
      assert.ok(heldDetailResponse, 'detail hydration starts automatically');
      await navigate("#/discover");
      await until("!document.querySelector('#view-discover').hidden");
      await navigate("#/title/1");
      await until("document.querySelector('#detail')?.textContent.includes('You can request this title now')");
      assert.equal(detailPosts, 2, 'an in-flight hydration POST must not be duplicated');
      assert.ok(heldDetailResponse);
      json(heldDetailResponse, { state: 'detail_ready' });
      heldDetailResponse = null;
      detailReady = true;
      await navigate("#/discover");
      await until("!document.querySelector('#view-discover').hidden");
      await navigate("#/title/1");
      await until("document.querySelector('#detail')?.textContent.includes('Film · 1 listed AniDB entry')");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request film'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request film').click()");
      await until("document.querySelector('dialog[open]')?.textContent.includes('Auto-Pick')");
      assert.equal(await evaluate("document.querySelector('dialog[open]')?.textContent.includes('Manual Pick')"),true);
      for(const width of [1280,390]) {
        await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
        const actionStyles=await evaluate("(() => {const actions=document.querySelector('dialog[open] .release-request-actions');if(!actions)return null;const bounds=actions.getBoundingClientRect();return {divider:getComputedStyle(actions).borderBottomWidth,buttons:[...actions.querySelectorAll('button')].map(button=>{const style=getComputedStyle(button),r=button.getBoundingClientRect();return {label:button.textContent,height:r.height,border:parseFloat(style.borderTopWidth),radius:parseFloat(style.borderTopLeftRadius),background:style.backgroundColor,colour:style.color,inside:r.left>=bounds.left-1&&r.right<=bounds.right+1};})};})()");
        assert.ok(actionStyles,'entry actions have their own button styling');
        assert.equal(actionStyles.divider,'0px');
        assert.deepEqual(actionStyles.buttons.map(x=>x.label),['Auto-Pick','Manual Pick']);
        for(const button of actionStyles.buttons){assert.ok(button.height>=44);assert.ok(button.border>=1);assert.ok(button.radius>=12);assert.notEqual(button.background,'rgba(0, 0, 0, 0)');assert.ok(button.inside);}
        assert.notEqual(actionStyles.buttons[0].background,actionStyles.buttons[1].background,'primary action has a distinct fill');
        assert.notEqual(actionStyles.buttons[0].background,actionStyles.buttons[0].colour,'primary label remains readable');
      }
      await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});

      // Browser Back / a receipt link must not leave a hidden native modal
      // keeping the Requests page inert (scrolling can still appear to work).
      await navigate("#/requests");
      await until("!document.querySelector('#view-requests').hidden");
      assert.equal(await evaluate("document.querySelectorAll('dialog:modal').length"),0,
        'leaving a title closes its modal before hiding the title view');
      await navigate("#/title/1");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request film'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request film').click()");
      await until("document.querySelector('dialog[open]')?.textContent.includes('Manual Pick')");
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Cancel').click()");
      assert.equal(submittedModes.length,0,'cancelling the submenu never submits a request');
      await navigate("#/title/3");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request series'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request series').click()");
      await until("document.querySelector('dialog[open]')?.textContent.includes('Manual Pick')");
      await navigate("#/requests");
      await until("!document.querySelector('#view-requests').hidden");
      assert.equal(await evaluate("document.querySelectorAll('dialog:modal').length"),0,
        'the series chooser cannot leave Requests inert');
      await navigate("#/title/3");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request series'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request series').click()");
      await until("document.querySelector('dialog[open]')?.textContent.includes('Manual Pick')");
      assert.equal(await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Manual Pick').disabled"),true);
      await evaluate("document.querySelector('dialog[open] input[type=checkbox]').click()");
      await until("![...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Manual Pick').disabled");
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Manual Pick').click()");
      await until("document.querySelector('dialog[open] [aria-label=Quality]')");
      assert.deepEqual(submittedModes,[],'opening Manual Pick does not submit a request');
      assert.equal(previewOpens,1);
      const pendingPreviewKey=await evaluate("sessionStorage.getItem('negev-request-1-3-installment')");
      assert.ok(pendingPreviewKey);
      // Enabled alone also matches the hidden editor before the initial GET.
      // Use visible controls, then wait for the initial search to settle.
      await until(`(${preferenceEditorReady.toString()})()`);
      await evaluate("document.querySelector('dialog.release-search-dialog[open]:modal .release-preference-editor summary').click()");
      await until(`(${preferenceSaveReady.toString()})()`);
      await evaluate("(() => {const d=document.querySelector('dialog.release-search-dialog[open]:modal');const input=d.querySelector('[aria-label=\"Preferred release group\"]');input.focus();input.value='Group';[...d.querySelectorAll('button')].find(b=>b.textContent==='Save group').click();})()");
      await until("document.querySelector('dialog.release-search-dialog[open]:modal')?.textContent.includes('Future release preference saved')");
      assert.deepEqual(preferenceCommands.map(({action,group,audio})=>({action,group,audio})),[{action:'preference',group:'Group',audio:'japanese'}]);
      assert.equal(await evaluate("sessionStorage.getItem('negev-request-1-3-installment')"),pendingPreviewKey,'preview preference does not clear the pending request key');
      assert.deepEqual(submittedModes,[]);
      assert.equal(await evaluate("document.querySelector('dialog[open] [aria-label=Quality]').value"),'bd1080');
      await navigate("#/requests");
      await until("!document.querySelector('#view-requests').hidden");
      assert.equal(await evaluate("document.querySelectorAll('dialog:modal').length"),0,
        'the body-mounted release picker also closes on navigation');
      previewExisting=true;
      await navigate("#/title/3");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request series'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request series').click()");
      await until("document.querySelector('dialog[open] input[type=checkbox]')");
      await evaluate("document.querySelector('dialog[open] input[type=checkbox]').click()");
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Manual Pick').click()");
      await until("document.querySelector('dialog[open]')?.textContent.includes('Request #123 already submitted')");
      assert.equal(await evaluate("document.querySelector('dialog[open] a[href=\"#/requests?requestId=123\"]')?.textContent"),'View request');
      assert.equal(await evaluate("document.querySelector('dialog[open] .release-mode-actions').hidden"),true);
      assert.deepEqual(submittedModes,[],'existing preview success must not resubmit or begin another acquisition');
      assert.equal(await evaluate("sessionStorage.getItem('negev-request-1-3-installment')"),null,'existing success finishes the pending command key');
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Close').click()");
      previewExisting=false;previewPending=true;
      await navigate("#/discover");await until("!document.querySelector('#view-discover').hidden");
      await navigate("#/title/3");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request series'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request series').click()");
      await until("document.querySelector('dialog[open] input[type=checkbox]')");
      await evaluate("document.querySelector('dialog[open] input[type=checkbox]').click()");
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Manual Pick').click()");
      // The season dialog closes before the asynchronous preview response arrives.
      // Wait for the pending response to finish saving, not the earlier close.
      await until("!document.querySelector('dialog[open]') && sessionStorage.getItem('negev-request-1-3-installment') === null");
      assert.equal(await evaluate("sessionStorage.getItem('negev-request-1-3-installment')"),null);
      assert.deepEqual(submittedModes,[],'pending preparation does not open an invalid preview or submit again');previewPending=false;
      await navigate("#/title/1");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request film'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request film').click()");
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Auto-Pick').click()");
      await until("document.querySelector('dialog[open]')?.textContent.includes('Automatic acquisition is enabled')");
      assert.deepEqual(submittedModes,['auto_review']);
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Close').click()");
      await navigate("#/discover");await until("!document.querySelector('#view-discover').hidden");
      await navigate("#/title/1");await until("document.querySelector('#detail')?.textContent.includes('Film · 1 listed AniDB entry')");
      for(const result of [{state:'pending',intentId:901},{state:'saved',created:false,requestId:123}]){
        filmResult=result;
        await navigate("#/discover");await until("!document.querySelector('#view-discover').hidden");
        await navigate("#/title/1");await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request film'&&!b.disabled)");
        await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request film').click()");
        await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Auto-Pick').click()");
        await until("!document.querySelector('dialog[open]')");
        assert.equal(await evaluate("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Requested')"),true,'pending and idempotent successful requests must finish the submenu');
      }
      // Finish a genuine submission response after navigation, without
      // re-opening an off-page popup or sending the request a second time.
      filmResult = null;
      await navigate("#/discover");
      await until("!document.querySelector('#view-discover').hidden");
      await navigate("#/title/1");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request film'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request film').click()");
      holdNextRequest = true;
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Auto-Pick').click()");
      for (let attempt=0; attempt<80 && !heldRequestResponse; attempt++) await wait(100);
      assert.ok(heldRequestResponse, 'submission is in flight');
      const submissionsBeforeLeaving = submittedModes.length;
      await navigate("#/requests");
      await until("!document.querySelector('#view-requests').hidden");
      json(heldRequestResponse,{state:'saved',created:true,requestId:123});
      heldRequestResponse = null;
      await wait(100);
      assert.equal(await evaluate("document.querySelectorAll('dialog:modal').length"),0,
        'a late successful save cannot reopen a modal on Requests');
      assert.equal(submittedModes.length,submissionsBeforeLeaving);
      const beforeReentry = titleReads;
      await navigate("#/discover");
      await until("!document.querySelector('#view-discover').hidden");
      await navigate("#/title/1");
      await until("window.location.hash === '#/title/1' && document.querySelector('#detail')?.textContent.includes('Film · 1 listed AniDB entry')");
      await wait(100);
      assert.ok(titleReads > beforeReentry, 'returning to title revalidates details');
      await navigate("#/title/2");
      await until("document.querySelector('#detail')?.textContent.includes('Try again')");
      assert.equal(await evaluate("document.querySelector('#detail')?.textContent.includes('No synopsis is available for this title yet.')"),false,
        'provider failure is not a successful missing-synopsis result');
      await evaluate("[...document.querySelectorAll('#detail button')].find(b => b.textContent === 'Try again').click()");
      await until("document.querySelector('#detail')?.textContent.includes('Recovered title')");
      assert.equal(failedTitleReads, 2);
      await navigate("#/discover");
      await until("!document.querySelector('#view-discover').hidden");
      await navigate("#/title/2");
      await until("document.querySelector('#detail')?.textContent.includes('The recovered catalogue summary.')");
      assert.equal(recoveredDisplayReads, 2,
        'a failed display read must be retried when the title is reopened');
      await navigate("#/library");
      await until("document.querySelector('#library-list')?.textContent.includes('First title')");
      assert.equal(await evaluate("document.querySelector('#library-list')?.textContent.includes('Show more verified titles')"), false,
        'the next page starts automatically when the list bottom is visible');
      await evaluate("document.querySelector('.library-page-marker')?.scrollIntoView()");
      await until("document.querySelector('#library-list')?.textContent.includes('Retry loading more titles')");
      assert.equal(pageTwoReads, 1, 'one automatic fetch fails without a retry loop');
      assert.equal(await evaluate("document.querySelector('#library-list')?.textContent.includes('First title')"), true);
      await evaluate("[...document.querySelectorAll('#library-list button')].find(b => b.textContent.includes('Retry')).click()");
      await until("document.querySelector('#library-list')?.textContent.includes('Second title')");
      assert.equal(pageTwoReads, 2);
      assert.equal(await evaluate("document.querySelectorAll('#library-list .poster-card').length"), 2);
      const libraryReadsBeforeReturn = firstLibraryReads;
      proofReady = false;
      await navigate("#/requests");
      await until("document.querySelector('#request-list')?.textContent.includes('Pending title')");
      await evaluate("document.querySelector('#more-requests').click()");
      await until("document.querySelector('#request-list')?.textContent.includes('Older completed title')");
      assert.equal(olderRequestReads, 1);
      assert.equal(await evaluate("document.querySelectorAll('#request-list .request-row').length"), 2);
      assert.equal(await evaluate("document.querySelector('#request-list [data-request-group=completed]')?.textContent.includes('Older completed title')"), true);
      assert.equal(await evaluate("document.querySelector('#request-list')?.textContent.includes('Pending title')"), true);
      assert.equal(await evaluate("document.querySelector('#more-requests').hidden"), true);
      proofReady = true;
      await evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'))");
      assert.equal(await evaluate('document.hidden'), false);
      await until("document.querySelector('#request-list')?.textContent.includes('Ready to watch')");
      assert.equal(await evaluate("document.querySelector('#request-list')?.textContent.includes('Older completed title')"), true);
      assert.equal(await evaluate("document.querySelectorAll('#request-list .request-row').length"), 2);
      newHistoryRequest = true;
      await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
      await until("document.querySelector('#request-list')?.textContent.includes('New request')");
      assert.equal(await evaluate("document.querySelectorAll('#request-list .request-row').length"), 2);
      assert.equal(await evaluate("document.querySelector('#request-list')?.textContent.includes('Older completed title')"), false);
      newHistoryRequest = false;
      await evaluate("document.querySelector('#request-list [data-request-group=completed]').open=true;document.querySelector('[data-request-id=\"7\"] .request-more').open=true;document.querySelector('[data-request-id=\"7\"] .request-technical').open=true");
      await evaluate("document.querySelector('#refresh-requests').click()");
      await until("document.querySelector('#request-list')?.textContent.includes('Ready to watch')");
      assert.equal(await evaluate("document.querySelector('#request-list [data-request-group=completed]').open"),true,'manual Refresh preserves the opened Completed group');
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"7\"] .request-more').open"),true,'manual Refresh preserves the opened card');
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"7\"] .request-technical').open"),true,'manual Refresh preserves nested technical details');
      await navigate("#/library");
      await until("document.querySelector('#library-list')?.textContent.includes('Updated title')");
      assert.ok(firstLibraryReads > libraryReadsBeforeReturn,
        'returning to Library must read current proof instead of keeping its old cards');
      const requestReadsBeforeReturn = requestReads;
      await navigate("#/requests");
      await until("document.querySelector('#request-list')?.textContent.includes('Ready to watch') && document.querySelector('#request-list')?.textContent.includes('film is playable in Plex')");
      assert.ok(requestReads > requestReadsBeforeReturn,
        'returning to Requests must read the changed request progress');
      await navigate("#/discover?q=Pending");
      await until("document.querySelector('#results')?.textContent.includes('In library')");
      const searchReadsBeforeReturn = searchReads;
      proofReady = false;
      await navigate("#/requests");
      await until("!document.querySelector('#view-requests').hidden");
      await navigate("#/discover?q=Pending");
      await until("document.querySelector('#results')?.textContent.includes('Pending title') && !document.querySelector('#results')?.textContent.includes('In library')");
      assert.ok(searchReads > searchReadsBeforeReturn,
        'returning to the same search must revalidate the availability badge');
      holdWatchingRequests = true;
      const historyBeforeHeldWatch = historyReads;
      await navigate("#/library");
      await until("!document.querySelector('#view-library').hidden");
      await navigate("#/requests");
      await until("document.querySelector('#watch-list')?.textContent.includes('Loading watches')");
      assert.equal(heldWatchingResponses.length, 1);
      for (let attempt = 0; attempt < 80 && historyReads === historyBeforeHeldWatch; attempt++) {
        await wait(100);
      }
      assert.ok(historyReads > historyBeforeHeldWatch,
        'history must load even while the separate Watching read is pending');
      assert.equal(await evaluate("document.querySelector('#refresh-requests').dispatchEvent(new MouseEvent('click', { bubbles: true }))"), true);
      for (let attempt = 0; attempt < 80 && heldWatchingResponses.length < 2; attempt++) {
        await wait(100);
      }
      assert.equal(heldWatchingResponses.length, 2);
      holdWatchingRequests = false;
      heldWatchingResponses.shift().end(JSON.stringify({ items: [], nextBeforeId: null }));
      await wait(100);
      heldWatchingResponses.shift().end(JSON.stringify({ items: [], nextBeforeId: null }));
      await until("document.querySelector('#watch-list')?.textContent.includes('No Airing shows')");
      proofReady = false;
      transferObservedMs = Date.now();
      await navigate("#/library");
      await until("!document.querySelector('#view-library').hidden");
      await navigate("#/requests");
      await until("document.querySelector('#request-list')?.textContent.includes('Downloading')");
      assert.equal(await evaluate("document.querySelector('#request-list .request-transfer-progress')?.getAttribute('aria-valuenow')"), '37.5');
      assert.equal(await evaluate("document.querySelector('#request-list .request-transfer-percent')?.textContent"), '37.5%');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#request-list .request-transfer-fill')).animationName"), 'request-transfer-stripes');
      const checkOwnerAlignment = async () => {
        const geometry=await evaluate("(() => { const group=document.querySelector('#request-scope');const buttons=[...group.querySelectorAll('button')];const nodes=[group.querySelector('.toolbar-label'),...buttons];return {buttons:buttons.map(x=>({top:x.getBoundingClientRect().top,height:x.getBoundingClientRect().height})),textCentres:nodes.map(x=>{const range=document.createRange();range.selectNodeContents(x);const r=range.getBoundingClientRect();return r.top+r.height/2;})};})()");
        assert.equal(geometry.buttons.length,2);
        assert.ok(Math.abs(geometry.buttons[0].top-geometry.buttons[1].top)<0.5,'owner buttons share their top edge');
        assert.deepEqual(geometry.buttons.map(x=>x.height),[36,36]);
        assert.ok(Math.max(...geometry.textCentres)-Math.min(...geometry.textCentres)<2,'owner label and both button texts are centred');
      };
      for(const width of [1280,390]) {
        await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
        await evaluate("document.querySelector('[data-request-scope=mine]').click()");
        await checkOwnerAlignment();
        await evaluate("document.querySelector('[data-request-scope=all]').click()");
        await checkOwnerAlignment();
      }
      await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      await until("document.querySelector('#request-list .request-transfer-progress')?.getAttribute('aria-valuenow')==='37.5'");
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"7\"] .request-release-options')"),null,'download cards have no release-selection tools');
      assert.equal(await evaluate('innerWidth'),1280,'exercise the desktop overlap breakpoint');
      const controls = await evaluate("(() => { const row=document.querySelector('[data-request-id=\"7\"]'); const cancel=[...row.querySelectorAll('.request-actions button')].find(x=>x.textContent==='Cancel request'); const more=row.querySelector('.request-more'); if(!cancel)return {cancel:false}; const a=cancel.getBoundingClientRect(),b=more.getBoundingClientRect(); more.open=true;row.querySelector('.request-technical').open=true;window.__requestCard=row;return {cancel:true,overlap:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top}; })()");
      assert.deepEqual(controls,{cancel:true,overlap:false},'admin cancellation and Details have separate hit areas');
      const beforePoll=historyReads;
      await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
      for(let n=0;n<80&&historyReads===beforePoll;n++)await wait(50);
      await until("!window.__requestCard.isConnected");
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"7\"] .request-more').open"),true,'poll preserves expanded card');
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"7\"] .request-technical').open"),true,'poll preserves nested sections');
      let resumeHistory;
      historyBarrier=new Promise(resolve=>{resumeHistory=resolve;});
      await evaluate("window.__requestCard=document.querySelector('[data-request-id=\"7\"]')");
      const beforeClosedPoll=historyReads;
      await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
      for(let n=0;n<80&&historyReads===beforeClosedPoll;n++)await wait(50);
      assert.ok(historyReads>beforeClosedPoll,'refresh must reach the held response');
      await evaluate("document.querySelector('[data-request-id=\"7\"] .request-more').open=false");
      historyBarrier=null;resumeHistory();
      await until("!window.__requestCard.isConnected");
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"7\"] .request-more').open"),false,'poll respects a section the user closed');
      transferBasisPoints=6250;
      await evaluate("document.querySelector('#refresh-requests').click()");
      await until("document.querySelector('#request-list .request-transfer-progress')?.getAttribute('aria-valuenow')==='62.5'");
      assert.equal(await evaluate("document.querySelector('#request-list .request-transfer-fill').style.width"),'62.5%');
      requestProposal=true;await evaluate("document.querySelector('#refresh-requests').click()");
      await until("document.querySelector('#request-list')?.textContent.includes('Release choice ready')");
      assert.equal(await evaluate("document.querySelectorAll('[data-request-id=\"7\"] .request-release-options button').length"),2,'pending proposal retains Auto-Pick and Manual Pick');
      assert.equal(await evaluate("document.querySelector('#request-list')?.textContent.includes('registered option')"),false,'a request card must not call likely evidence registered');
      requestProposal=false;await evaluate("document.querySelector('#refresh-requests').click()");
      await until("document.querySelector('#request-list .request-transfer-progress')?.getAttribute('aria-valuenow')==='62.5'");
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"7\"] .request-release-options')"),null,'release tools disappear when selection is no longer pending');
      requestAiring=true;await evaluate("document.querySelector('#refresh-requests').click()");
      await until("Boolean(document.querySelector('[data-request-id=\"7\"] .request-group-preference button'))");
      await evaluate("document.querySelector('[data-request-id=\"7\"] .request-more').open=true;document.querySelector('[data-request-id=\"7\"] .request-group-preference button').click()");
      await until("Boolean(document.querySelector('dialog .release-preference-editor[open]'))");
      assert.equal(await evaluate("document.querySelector('dialog .release-mode-actions').hidden"),true,'consumed preference editor has no acquisition actions');
      await evaluate("document.querySelector('dialog').close()");
      proofReady=true;requestProposal=true;await evaluate("document.querySelector('#refresh-requests').click()");
      await until("document.querySelector('[data-request-id=\"7\"] .request-stage')?.textContent==='Watching for the next episode'");
      assert.equal(await evaluate("document.querySelector('[data-request-id=\"7\"] .request-release-options')"),null,'fully available proposal has no obsolete release picker');
      requestAiring=false;proofReady=false;requestProposal=false;await evaluate("document.querySelector('#refresh-requests').click()");
      await until("document.querySelector('#request-list .request-transfer-progress')?.getAttribute('aria-valuenow')==='62.5'");
      await evaluate(`Date.now = () => ${transferObservedMs + 16 * 60_000};
        document.dispatchEvent(new Event('visibilitychange'))`);
      await until("document.querySelector('#request-list')?.textContent.includes('Checking download status')");
      assert.equal(await evaluate("document.querySelector('#request-list .request-transfer-progress')"), null);
      transferObservedMs = null;
      await navigate("#/admin");
      await until("!document.querySelector('#view-admin').hidden");
      await until("document.querySelector('#review-list a')?.textContent.includes('Older completed title')");
      assert.equal(await evaluate("document.querySelector('#review-list a').getAttribute('href')"),'#/requests?requestId=6');
      await evaluate("document.querySelector('#review-list a').click()");
      await until("document.querySelector('#request-list [data-request-id=\"6\"]')?.textContent.includes('Request #6')");
      assert.equal(await evaluate("document.querySelector('#request-list details.request-group').open"),true,
        'an older completed request opens visibly instead of remaining collapsed');
      assert.equal(await evaluate("document.querySelector('#request-focus').hidden"),false);
      await evaluate("document.querySelector('#request-focus a').click()");
      await until("document.querySelector('#request-focus').hidden && document.querySelector('#request-list [data-request-id=\"7\"]')");
      seasonResult={state:'pending',intentId:900};
      await navigate("#/title/3");
      await until("[...document.querySelectorAll('#detail button')].some(b=>b.textContent==='Request series'&&!b.disabled)");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='Request series').click()");
      await until("document.querySelector('dialog[open] input[type=checkbox]')");
      await evaluate("document.querySelector('dialog[open] input[type=checkbox]').click()");
      await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Auto-Pick').click()");
      await until("document.querySelector('dialog[open] .request-feedback')?.textContent.includes('1 season requested')");
      assert.equal(await evaluate("document.querySelector('dialog[open] .request-receipt-link').hidden"),false,
        'preparation-only saves retain their generic Requests shortcut');
      assert.equal(await evaluate("document.querySelector('dialog[open] .request-receipt-link').getAttribute('href')"),'#/requests');
      await evaluate("document.querySelector('dialog[open] .request-receipt-link').click()");
      await until("!document.querySelector('#view-requests').hidden");
      seasonResult=null;
      monitoredTitle = true;
      await navigate("#/title/3");
      await until("document.querySelector('.season-already-monitored')?.hidden === false");
      assert.equal(await evaluate("document.querySelector('#detail .request-receipt-link:not([hidden])')?.getAttribute('href')"), '#/requests?requestId=123',
        'a monitored title must link to its exact watch, not the empty Recent list');
      await evaluate("document.querySelector('#detail .request-receipt-link:not([hidden])').click()");
      await until("document.querySelector('#request-list [data-request-id=\"123\"]')?.textContent.includes('Series example')");
      assert.equal(await evaluate("document.querySelector('#request-focus').hidden"), false);
      await evaluate("document.querySelector('#request-focus a').click()");
      await until("document.querySelector('#request-focus').hidden");
      holdWatchingRequests = true;
      await navigate("#/library");
      await until("!document.querySelector('#view-library').hidden");
      await navigate("#/requests");
      for (let attempt = 0; attempt < 80 && heldWatchingResponses.length < 1; attempt++) {
        await wait(100);
      }
      assert.ok(heldWatchingResponses.length >= 1);
      await evaluate("document.querySelector('#signout').click()");
      await until("document.querySelector('#workspace').hidden");
      assert.equal(await evaluate("document.querySelector('#auth').hidden"), false);
      assert.equal(await evaluate("document.querySelector('#session-loading').hidden"), true);
      const staleWatchingBody = JSON.stringify({ items: [{
        id: 9, anidbId: 1, title: 'Prior account watch', kind: 'series',
        episodeIds: [11], monitorFuture: true, watchClosed: false,
        progress: { state: 'saved', targetCount: 1,
          publicAvailability: 'unverified' },
      }], nextBeforeId: null });
      for (const response of heldWatchingResponses.splice(0)) {
        response.end(staleWatchingBody);
      }
      await wait(100);
      assert.equal(await evaluate("document.querySelector('#request-list').children.length"), 0);
      assert.equal(await evaluate("document.querySelector('#watch-list').children.length"), 0);
    } finally {
      if (heldRequestResponse) json(heldRequestResponse,{state:'pending',intentId:901});
      if (firstTitleResponse) json(firstTitleResponse, { state: 'detail_pending',
        anidbId: 1 });
      if (heldDetailResponse) json(heldDetailResponse, { state: 'pending' });
      for (const response of heldWatchingResponses) {
        response.end(JSON.stringify({ items: [], nextBeforeId: null }));
      }
      socket?.close();
      child.kill();
      await closed;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(profile, { recursive: true, force: true,
        maxRetries: 5, retryDelay: 100 });
    }
  });
