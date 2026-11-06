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
  'request-key.mjs', 'episode-pages.mjs', 'search-pages.mjs',
  'request-progress-text.mjs', 'response-epoch.mjs', 'franchise-explorer.mjs',
  'acquisition-notice.mjs', 'consumer-route.mjs']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('title and library controls recover from pending and failed reads without duplicate writes',
  { skip: browser ? false : 'No Chrome or Edge browser installed' }, async () => {
    let titleReads = 0;
    let detailPosts = 0;
    let detailReady = false;
    let holdNextDetailPost = false;
    let heldDetailResponse = null;
    let failedTitleReads = 0;
    let pageTwoReads = 0;
    let firstLibraryReads = 0;
    let searchReads = 0;
    let requestReads = 0;
    let historyReads = 0;
    let operationalReads = 0;
    let olderRequestReads = 0;
    let proofReady = false;
    let transferObservedMs = null;
    let newHistoryRequest = false;
    let holdWatchingRequests = true;
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
        json(response, { user: { id: 1, username: 'Owner', role: 'admin',
          adultAllowed: true }, csrfToken: 'test', capabilities: {
          detailLoad: true, acquisitionState: 'disabled' } });
      } else if (path === '/api/logout') {
        json(response, { state: 'signed_out' });
      } else if (path === '/api/admin/review') {
        operationalReads++;
        json(response, { items: [], nextAfterAttemptId: null });
      } else if (path === '/api/catalogue/1' && request.method === 'GET') {
        titleReads++;
        json(response, detailReady ? { state: 'details', anidbId: 1,
          title: 'Pending title', kind: 'movie', page: 1, total: 1, nextPage: null,
          episodes: [{ id: 11, number: 1, type: 'Episode', title: 'Film' }] } :
          { state: 'detail_pending', anidbId: 1, title: 'Pending title' });
      } else if (path === '/api/catalogue/1/load-detail' && request.method === 'POST') {
        detailPosts++;
        if (holdNextDetailPost) {
          holdNextDetailPost = false;
          heldDetailResponse = response;
        } else json(response, { state: 'pending' });
      } else if (path === '/api/catalogue/2') {
        failedTitleReads++;
        json(response, failedTitleReads === 1 ? { error: 'temporarily unavailable' } :
          { state: 'details', anidbId: 2, title: 'Recovered title',
            kind: 'movie', page: 1, total: 0, nextPage: null, episodes: [] },
        failedTitleReads === 1 ? 503 : 200);
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
        if (url.searchParams.get('view') === 'watching' && holdWatchingRequests) {
          response.writeHead(200, { 'Content-Type': 'application/json',
            'Cache-Control': 'no-store' });
          response.flushHeaders();
          heldWatchingResponses.push(response);
          return;
        }
        const history = url.searchParams.get('view') === 'history';
        if (history) historyReads++;
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
          { id: 7, anidbId: 1, title: 'Pending title', kind: 'movie',
            episodeIds: [11], monitorFuture: false, watchClosed: true,
            progress: { state: transferObservedMs === null ? 'saved' :
              'download_unverified', targetCount: 1,
              publicAvailability: proofReady ? 'verified_recently' : 'unverified',
              publicVerifiedTargets: proofReady ? 1 : 0,
              ...(transferObservedMs === null ? {} : { transfer: {
                progressBasisPoints: 3750, etaSeconds: 120,
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
      const until = async (expression) => {
        for (let attempt = 0; attempt < 80; attempt++) {
          if (await evaluate(expression)) return;
          await wait(100);
        }
        assert.fail(`UI did not reach expected state: ${expression}; detail=${await evaluate("document.querySelector('#detail')?.textContent")}; requests=${await evaluate("document.querySelector('#request-list')?.textContent")}; reads=${requestReads}; hidden=${await evaluate('document.hidden')}; error=${await evaluate("document.querySelector('#message')?.textContent")}`);
      };
      const base = `http://127.0.0.1:${server.address().port}`;
      await send('Page.navigate', { url: `${base}/#/title/1` });
      for (let attempt = 0; attempt < 80 && heldWatchingResponses.length < 1; attempt++) {
        await wait(100);
      }
      assert.equal(heldWatchingResponses.length, 1);
      assert.ok(historyReads > 0, 'History starts while Watching is pending');
      assert.ok(operationalReads > 0,
        'owner review starts while Watching is pending');
      holdWatchingRequests = false;
      heldWatchingResponses.shift().end(JSON.stringify({ items: [], nextBeforeId: null }));
      await until("document.querySelector('#detail')?.textContent.includes('Load details')");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b => b.textContent === 'Load details').click()");
      await until("document.querySelector('#detail')?.textContent.includes('Check again')");
      assert.equal(detailPosts, 1);
      detailReady = true;
      await evaluate("[...document.querySelectorAll('#detail button')].find(b => b.textContent === 'Check again').click()");
      await until("document.querySelector('#detail')?.textContent.includes('Film · 1 listed AniDB entry')");
      assert.equal(detailPosts, 1, 'ready state must use GET, not repeat hydration POST');
      detailReady = false;
      await evaluate("location.hash = '#/discover'");
      await until("!document.querySelector('#view-discover').hidden");
      await evaluate("location.hash = '#/title/1'");
      await until("document.querySelector('#detail')?.textContent.includes('Load details')");
      holdNextDetailPost = true;
      await evaluate("[...document.querySelectorAll('#detail button')].find(b => b.textContent === 'Load details').click()");
      await until("document.querySelector('#detail button')?.disabled === true");
      await evaluate("location.hash = '#/discover'");
      await until("!document.querySelector('#view-discover').hidden");
      await evaluate("location.hash = '#/title/1'");
      await until("document.querySelector('#detail')?.textContent.includes('Check again')");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b => b.textContent === 'Check again').click()");
      await until("document.querySelector('#detail')?.textContent.includes('Check again')");
      assert.equal(detailPosts, 2, 'an in-flight hydration POST must not be duplicated');
      assert.ok(heldDetailResponse);
      json(heldDetailResponse, { state: 'pending' });
      heldDetailResponse = null;
      detailReady = true;
      await evaluate("[...document.querySelectorAll('#detail button')].find(b => b.textContent === 'Check again').click()");
      await until("document.querySelector('#detail')?.textContent.includes('Film · 1 listed AniDB entry')");
      const beforeReentry = titleReads;
      await evaluate("location.hash = '#/discover'");
      await until("!document.querySelector('#view-discover').hidden");
      await evaluate("location.hash = '#/title/1'");
      await until("window.location.hash === '#/title/1' && document.querySelector('#detail')?.textContent.includes('Film · 1 listed AniDB entry')");
      await wait(100);
      assert.ok(titleReads > beforeReentry, 'returning to title revalidates details');
      await evaluate("location.hash = '#/title/2'");
      await until("document.querySelector('#detail')?.textContent.includes('Try again')");
      await evaluate("[...document.querySelectorAll('#detail button')].find(b => b.textContent === 'Try again').click()");
      await until("document.querySelector('#detail')?.textContent.includes('Recovered title')");
      assert.equal(failedTitleReads, 2);
      await evaluate("location.hash = '#/library'");
      await until("document.querySelector('#library-list')?.textContent.includes('Show more verified titles')");
      await evaluate("[...document.querySelectorAll('#library-list button')].find(b => b.textContent.includes('Show more')).click()");
      await until("document.querySelector('#library-list')?.textContent.includes('Retry loading more titles')");
      assert.equal(await evaluate("document.querySelector('#library-list')?.textContent.includes('First title')"), true);
      await evaluate("[...document.querySelectorAll('#library-list button')].find(b => b.textContent.includes('Retry')).click()");
      await until("document.querySelector('#library-list')?.textContent.includes('Second title')");
      assert.equal(pageTwoReads, 2);
      assert.equal(await evaluate("document.querySelectorAll('#library-list .poster-card').length"), 2);
      const libraryReadsBeforeReturn = firstLibraryReads;
      proofReady = false;
      await evaluate("location.hash = '#/requests'");
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
      await evaluate("location.hash = '#/library'");
      await until("document.querySelector('#library-list')?.textContent.includes('Updated title')");
      assert.ok(firstLibraryReads > libraryReadsBeforeReturn,
        'returning to Library must read current proof instead of keeping its old cards');
      const requestReadsBeforeReturn = requestReads;
      await evaluate("location.hash = '#/requests'");
      await until("document.querySelector('#request-list')?.textContent.includes('Ready to watch') && document.querySelector('#request-list')?.textContent.includes('film is playable in Plex')");
      assert.ok(requestReads > requestReadsBeforeReturn,
        'returning to Requests must read the changed request progress');
      await evaluate("location.hash = '#/discover?q=Pending'");
      await until("document.querySelector('#results')?.textContent.includes('In library')");
      const searchReadsBeforeReturn = searchReads;
      proofReady = false;
      await evaluate("location.hash = '#/requests'");
      await until("!document.querySelector('#view-requests').hidden");
      await evaluate("location.hash = '#/discover?q=Pending'");
      await until("document.querySelector('#results')?.textContent.includes('Availability not checked')");
      assert.ok(searchReads > searchReadsBeforeReturn,
        'returning to the same search must revalidate the availability badge');
      holdWatchingRequests = true;
      const historyBeforeHeldWatch = historyReads;
      await evaluate("location.hash = '#/library'");
      await until("!document.querySelector('#view-library').hidden");
      await evaluate("location.hash = '#/requests'");
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
      await evaluate("location.hash = '#/library'");
      await until("!document.querySelector('#view-library').hidden");
      await evaluate("location.hash = '#/requests'");
      await until("document.querySelector('#request-list')?.textContent.includes('Downloading')");
      await evaluate(`Date.now = () => ${transferObservedMs + 16 * 60_000};
        document.dispatchEvent(new Event('visibilitychange'))`);
      await until("document.querySelector('#request-list')?.textContent.includes('Checking download status')");
      transferObservedMs = null;
      holdWatchingRequests = true;
      await evaluate("location.hash = '#/library'");
      await until("!document.querySelector('#view-library').hidden");
      await evaluate("location.hash = '#/requests'");
      for (let attempt = 0; attempt < 80 && heldWatchingResponses.length < 1; attempt++) {
        await wait(100);
      }
      assert.equal(heldWatchingResponses.length, 1);
      await evaluate("document.querySelector('#signout').click()");
      await until("document.querySelector('#workspace').hidden");
      heldWatchingResponses.shift().end(JSON.stringify({ items: [{
        id: 9, anidbId: 1, title: 'Prior account watch', kind: 'series',
        episodeIds: [11], monitorFuture: true, watchClosed: false,
        progress: { state: 'saved', targetCount: 1,
          publicAvailability: 'unverified' },
      }], nextBeforeId: null }));
      await wait(100);
      assert.equal(await evaluate("document.querySelector('#request-list').children.length"), 0);
      assert.equal(await evaluate("document.querySelector('#watch-list').children.length"), 0);
    } finally {
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
