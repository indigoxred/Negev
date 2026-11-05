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

const dump = async (url, profile, captureName) => new Promise((resolve, reject) => {
  const screenshot = process.env.NEGEV_UI_CAPTURE_DIR && captureName
    ? join(process.env.NEGEV_UI_CAPTURE_DIR, `${captureName}.png`) : null;
  const child = spawn(browser, ['--headless=new', '--no-first-run',
    '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
    `--user-data-dir=${profile}`, '--virtual-time-budget=6000',
    '--window-size=1440,900', ...(screenshot ? [`--screenshot=${screenshot}`] : []),
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
      const library = await dump(`${base}/#/library`, join(dir, 'library'), 'library');
      assert.match(library, /The Garden of Words/);
      assert.match(library, /Recently verified in public Plex/);
      const airing = await dump(`${base}/#/airing`, join(dir, 'airing'), 'airing');
      assert.match(airing, /FX Senshi Kurumi-chan/);
      assert.match(airing, /Local availability not checked/);
      const detail = await dump(`${base}/#/title/4158`, join(dir, 'detail'));
      assert.match(detail, /Request film/);
      assert.match(detail, /Pale Cocoon/);
      assert.match(detail, /Back to Discover/);
      const requests = await dump(`${base}/#/requests`, join(dir, 'requests'));
      assert.match(requests, /Pale Cocoon/);
      assert.match(requests, /My requests/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
