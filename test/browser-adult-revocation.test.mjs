import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTestBrowser, browserSkipReason } from './helpers/browser-executable.mjs';
import { createSessionController } from '../src/web/public/session-controller.mjs';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';
const browser = findTestBrowser();
test('browser session revocation removes retained title DOM and preserves unchanged typed work',
  { skip: browser ? false : browserSkipReason }, () => {
    const html = `<!doctype html><meta charset="utf-8"><input id="draft" value="unfinished text">
      <div id="results"><span>Restricted title</span></div><div id="library-list"><img alt="Restricted poster"></div>
      <pre id="result">pending</pre><script>
      const createResponseEpoch = ${createResponseEpoch.toString()};
      const createSessionController = ${createSessionController.toString()};
      const byId = id => { let node = document.getElementById(id); if (!node) {
        node = document.createElement(id.endsWith('-form') ? 'form' : 'div'); node.id = id; document.body.append(node);
      } return node; };
      const epoch = createResponseEpoch(), before = epoch.current();
      const state = { user: { id: 1, username: 'Fixture', role: 'member', adultAllowed: true },
        showAdult: true, searchToken: 1, searchItems: new Map([[99,{adult:true}]]),
        detailHydrationQueued: new Set(), selected: 99 };
      const cache = new Map([[99,{restricted:true}]]); let allowed = true, preferred = true, renders = 0;
      const args = { state, sessionResponses: epoch, displayCache: cache, byId,
        airingResponses:createResponseEpoch(),airingSeasonResponses:createResponseEpoch(),libraryResponses:createResponseEpoch(),
        reviewResponses:createResponseEpoch(),seasonalResponses:createResponseEpoch(),
        api:async()=>({user:{id:1,username:'Fixture',role:'member',adultAllowed:allowed},csrfToken:'fresh'}),
        admin:{resetReview(){}},auth:{},browse:{setAiringFilters(){}},detail:{invalidate(){}},tracking:{resetTracking(){}},
        genreSelections:{airing:new Set(),season:new Set()},
        element:(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;},
        ensureTrackingPreferences:async()=>{},readAdultPreference:()=>preferred,readChinesePreference:()=>true,readEnglishTitlePreference:()=>false,
        renderRoute:()=>{renders++;},currentAcquisitionNotice:()=>'' };
      for (const key of ['applyAdultVisibility','applyPendingLinkCode','applyTitlePreference','dismissRequestDialogs',
        'invalidateRequestResponses','loadOperationalReview','loadRequests','message','renderTrackedTitles',
        'resetRoutePosition','stopBrowsePageObserver','stopLibraryPageObserver','updateRequestScopeButtons']) args[key]=()=>{};
      const session = createSessionController(args);
      (async()=>{
        await session.refreshSession({background:true});
        const unchanged={draft:byId('draft').value,renders};
        allowed=false;await session.refreshSession({background:true});
        const revoked={stale:epoch.isCurrent(before),cache:cache.size,search:byId('results').children.length,
          posters:byId('library-list').querySelectorAll('img').length,selected:state.selected,allowed:state.user.adultAllowed};
        allowed=true;preferred=false;await session.refreshSession({background:true});
        byId('result').textContent=JSON.stringify({unchanged,revoked,reenabled:{allowed:state.user.adultAllowed,showAdult:state.showAdult}});
      })().catch(error=>{byId('result').textContent=JSON.stringify({error:error.stack});});
      </script>`;
    const dir = mkdtempSync(join(tmpdir(), 'negev-browser-adult-'));
    try {
      const file = join(dir, 'access.html'); writeFileSync(file, html);
      const output = execFileSync(browser, ['--headless=new', '--no-first-run', '--disable-gpu',
        '--disable-dev-shm-usage', '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`,
        '--virtual-time-budget=3000', '--dump-dom', new URL(`file:///${file.replaceAll('\\', '/')}`).href],
      { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'ignore'] });
      const match = output.match(/<pre id="result">([^<]+)<\/pre>/); assert.ok(match);
      const result = JSON.parse(match[1].replaceAll('&quot;', '"'));
      assert.equal(result.error, undefined, result.error);
      assert.deepEqual(result.unchanged, { draft: 'unfinished text', renders: 0 });
      assert.deepEqual(result.revoked, { stale: false, cache: 0, search: 0, posters: 0, selected: null, allowed: false });
      assert.deepEqual(result.reenabled, { allowed: true, showAdult: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
