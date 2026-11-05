import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const browser = [process.env.NEGEV_TEST_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);
const staticRoot = new URL('../src/web/public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/consumer.css', ['consumer.css', 'text/css']],
  ...['request-key.mjs', 'episode-pages.mjs', 'search-pages.mjs',
    'request-progress-text.mjs', 'response-epoch.mjs',
    'franchise-explorer.mjs', 'acquisition-notice.mjs',
    'consumer-route.mjs'].map((name) => [`/${name}`, [name, 'text/javascript']]),
]);

const dump = async (url, profile, captureName, viewport = '1440,900') => new Promise((resolve, reject) => {
  const screenshot = process.env.NEGEV_UI_CAPTURE_DIR && captureName
    ? join(process.env.NEGEV_UI_CAPTURE_DIR, `${captureName}.png`) : null;
  const child = spawn(browser, ['--headless=new', '--no-first-run',
    '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
    `--user-data-dir=${profile}`, '--virtual-time-budget=6000',
    `--window-size=${viewport}`, ...(screenshot ? [`--screenshot=${screenshot}`] : []),
    '--dump-dom', url], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let output = '';
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Browser timed out')); }, 30_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (part) => {
    output += part;
    if (output.length > 2_000_000) child.kill();
  });
  child.on('error', (error) => { clearTimeout(timeout); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timeout);
    if (code !== 0 || output.length > 2_000_000) reject(new Error('Browser failed'));
    else resolve(output);
  });
});

async function inspectMobile(url, profile, width = 390) {
  const child = spawn(browser, ['--headless=new', '--no-first-run',
    '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let socket;
  try {
    let port;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        break;
      } catch { await wait(100); }
    }
    if (!port) throw new Error('Browser debugging port unavailable');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((entry) => entry.type === 'page');
    if (!page) throw new Error('Browser page unavailable');
    socket = new WebSocket(page.webSocketDebuggerUrl);
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
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await send('Page.navigate', { url });
    await wait(1200);
    const { result } = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        accountRight: document.querySelector('#identity').getBoundingClientRect().right,
        accountTop: document.querySelector('#identity').getBoundingClientRect().top,
        headerBottom: document.querySelector('.topbar').getBoundingClientRect().bottom,
        mobileNavVisible: document.querySelector('#mobile-nav').getBoundingClientRect().height > 0,
        searchRight: document.querySelector('#search-form').getBoundingClientRect().right,
        hasContent: document.querySelector('#discover-shelves').textContent.includes('This week on AniDB')})`,
    });
    if (process.env.NEGEV_UI_CAPTURE_DIR && width === 390) {
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(join(process.env.NEGEV_UI_CAPTURE_DIR, 'discover-mobile.png'),
        Buffer.from(shot.data, 'base64'));
    }
    const menu = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const account = document.querySelector('#identity');
        account.open = true; const signout = document.querySelector('#signout');
        return {right: account.querySelector('.account-menu').getBoundingClientRect().right,
          signoutVisible: signout.getBoundingClientRect().width > 0}; })()`,
    });
    return { ...result.value, menu: menu.result.value };
  } finally {
    socket?.close();
    child.kill();
  }
}

test('signed-in consumer routes render real shell with search, library and requests',
  { skip: browser ? false : 'No Chrome or Edge browser installed' }, async () => {
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      response.setHeader('Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'");
      if (path === '/api/session') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ user: { id: 1, username: 'Owner', role: 'admin' },
          csrfToken: 'test-only', capabilities: { acquisitionState: 'disabled' } }));
        return;
      }
      if (path === '/api/requests') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ items: path.includes('never') ? [] : [{
          id: 1, anidbId: 4158, title: 'Pale Cocoon', kind: 'movie',
          episodeIds: [10], monitorFuture: false, watchClosed: false,
          progress: { state: 'requested' },
        }], nextBeforeId: null }));
        return;
      }
      if (path === '/api/catalogue/search') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'results', page: 1, total: 1,
          catalogueSource: 'test', items: [{ anidbId: 4158,
            title: 'Pale Cocoon', libraryPresence: { state: 'unknown',
              verifiedEpisodeCount: 0 } }] }));
        return;
      }
      if (path === '/api/library') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'current_proofs', items: [{
          anidbId: 9589, title: 'The Garden of Words',
          verifiedEpisodeCount: 1, lastVerifiedMs: 1_000,
        }], nextAfterAnidbId: null }));
        return;
      }
      if (path === '/api/airing') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'ready', week: '2026-W45',
          checkedMs: 1_000, items: [{ anidbId: 19847,
            title: 'FX Senshi Kurumi-chan', scheduledDate: '2026-11-05',
            episodeNumber: '4' }] }));
        return;
      }
      if (path === '/api/catalogue/4158') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 4158,
          title: 'Pale Cocoon', kind: 'movie', restricted: false,
          page: 1, total: 1, nextPage: null,
          episodes: [{ id: 15, number: 1, type: 'Episode', title: 'Film',
            availability: 'unknown' }] }));
        return;
      }
      if (path === '/api/catalogue/7') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 7,
          title: 'Film with alternate parts', kind: 'movie', restricted: false,
          page: 1, total: 3, nextPage: null, episodes: [
            { id: 71, number: 1, type: 'Episode', title: 'Complete Movie', availability: 'available' },
            { id: 72, number: 2, type: 'Episode', title: 'Part 1', availability: 'unknown' },
            { id: 73, number: 3, type: 'Episode', title: 'Part 2', availability: 'unknown' },
          ] }));
        return;
      }
      if (path === '/api/catalogue/4158/display') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display', anidbId: 4158,
          title: 'Pale Cocoon', englishTitle: null, type: 'OVA',
          startYear: 2005, description: 'A quiet archive and a lost world.',
          tags: ['Science fiction'] }));
        return;
      }
      const asset = assets.get(path);
      if (!asset) { response.writeHead(404); response.end(); return; }
      try {
        response.setHeader('Content-Type', asset[1]);
        response.end(await readFile(new URL(asset[0], staticRoot)));
      } catch { response.writeHead(500); response.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(join(tmpdir(), 'negev-browser-consumer-'));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const discover = await dump(`${base}/#/discover?q=Pale`, join(dir, 'discover'));
      assert.match(discover, /Pale Cocoon/);
      assert.match(discover, /Availability not checked/);
      assert.match(discover, /id="view-discover" class="page-view"/);
      const browse = await dump(`${base}/#/discover`, join(dir, 'browse'), 'discover');
      assert.match(browse, /This week on AniDB/);
      assert.match(browse, /FX Senshi Kurumi-chan/);
      assert.match(browse, /Verified in your library/);
      assert.match(browse, /The Garden of Words/);
      const mobile = await inspectMobile(`${base}/#/discover`, join(dir, 'mobile'));
      assert.equal(mobile.width, 390);
      assert.equal(mobile.hasContent, true);
      assert.ok(mobile.scrollWidth <= 390, 'mobile page has no horizontal overflow');
      assert.ok(mobile.accountRight <= 390, 'Account control remains visible');
      assert.ok(mobile.searchRight <= 390, 'Search remains visible');
      assert.ok(mobile.menu.right <= 390 && mobile.menu.signoutVisible,
        'Account menu and sign-out remain usable');
      const tablet = await inspectMobile(`${base}/#/discover`, join(dir, 'tablet'), 709);
      assert.ok(tablet.accountTop < tablet.headerBottom,
        'Account control stays inside the tablet header');
      assert.equal(tablet.mobileNavVisible, true,
        'Tablet navigation stays visible after the desktop links no longer fit');
      const library = await dump(`${base}/#/library`, join(dir, 'library'), 'library');
      assert.match(library, /The Garden of Words/);
      assert.match(library, /<div id="library-list" class="poster-grid"><a class="poster-card"/);
      assert.match(library, /1 verified item/);
      const airing = await dump(`${base}/#/airing`, join(dir, 'airing'), 'airing');
      assert.match(airing, /FX Senshi Kurumi-chan/);
      assert.match(airing, /Local availability not checked/);
      const detail = await dump(`${base}/#/title/4158`, join(dir, 'detail'), 'detail');
      assert.match(detail, /Request film/);
      assert.match(detail, /Pale Cocoon/);
      assert.match(detail, /A quiet archive and a lost world/);
      assert.match(detail, /Back to Discover/);
      const alternateFilm = await dump(`${base}/#/title/7`, join(dir, 'alternate-film'));
      assert.match(alternateFilm, /Choose one film entry/);
      assert.match(alternateFilm, /Request selected film entry/);
      assert.doesNotMatch(alternateFilm, /<button class="primary">Request film<\/button>/);
      const requests = await dump(`${base}/#/requests`, join(dir, 'requests'));
      assert.match(requests, /Pale Cocoon/);
      assert.match(requests, /My requests/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
