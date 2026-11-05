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
        if (pageTwoReads === 1 && url.searchParams.has('afterAnidbId')) {
          json(response, { error: 'temporarily unavailable' }, 503);
        } else {
          json(response, { state: 'current_proofs', items: [{
            anidbId: url.searchParams.has('afterAnidbId') ? 2 : 1,
            title: url.searchParams.has('afterAnidbId') ? 'Second title' : 'First title',
            verifiedEpisodeCount: 1 }],
          nextAfterAnidbId: url.searchParams.has('afterAnidbId') ? null : 1 });
        }
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
        assert.fail(`UI did not reach expected state: ${expression}; detail=${await evaluate("document.querySelector('#detail')?.textContent")}; error=${await evaluate("document.querySelector('#message')?.textContent")}`);
      };
      const base = `http://127.0.0.1:${server.address().port}`;
      await send('Page.navigate', { url: `${base}/#/title/1` });
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
    } finally {
      if (heldDetailResponse) json(heldDetailResponse, { state: 'pending' });
      socket?.close();
      child.kill();
      await closed;
      await new Promise((resolve) => server.close(resolve));
      await rm(profile, { recursive: true, force: true,
        maxRetries: 5, retryDelay: 100 });
    }
  });
