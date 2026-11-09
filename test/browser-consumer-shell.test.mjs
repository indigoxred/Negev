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
  ...['request-key.mjs', 'request-feedback.mjs', 'episode-pages.mjs', 'search-pages.mjs',
    'request-progress-text.mjs', 'response-epoch.mjs',
    'franchise-explorer.mjs', 'acquisition-notice.mjs',
    'adult-search-visibility.mjs',
    'consumer-route.mjs', 'season-availability-presentation.mjs',
    'detail-refresh.mjs', 'relation-label.mjs']
    .map((name) => [`/${name}`, [name, 'text/javascript']]),
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
  const closed = new Promise((resolve) => child.once('close', resolve));
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
        hasContent: document.querySelector('#season-list').textContent.includes('Pale Cocoon')})`,
    });
    await send('Page.navigate', { url: url.replace('#/discover',
      '#/discover?year=2025&season=ALL&after=12') });
    await wait(800);
    const mobilePager = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const pager = document.querySelector('.season-pages');
        const previous = document.querySelector('#season-previous');
        const next = document.querySelector('#season-next');
        return {label: document.querySelector('#season-page-position')?.textContent,
          visible: !pager?.hidden,
          fits: pager?.getBoundingClientRect().right <= innerWidth &&
            pager?.getBoundingClientRect().left >= 0,
          previousEnabled: !previous?.disabled, nextEnabled: !next?.disabled}; })()`,
    });
    await send('Page.navigate', { url });
    await wait(300);
    const tagBrowse = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const picker = document.querySelector('#season-form .genre-picker');
        picker.open = true;
        const choices = document.querySelector('#season-tags');
        const more = document.querySelector('#season-tag-more');
        const before = choices.querySelectorAll('input').length;
        more?.click();
        const after = choices.querySelectorAll('input').length;
        const late = [...choices.querySelectorAll('input')]
          .find((input) => input.value === 'genre 55');
        late?.click();
        const search = document.querySelector('#season-tag-search');
        search.value = 'genre 55'; search.dispatchEvent(new Event('input'));
        return {before, after, moreHidden: more?.hidden,
          selected: choices.querySelector('input[value="genre 55"]')?.checked,
          summary: picker.querySelector('summary')?.textContent}; })()`,
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
    const adultChoice = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const toggle = document.querySelector('#adult-toggle');
        const before = toggle.getAttribute('aria-pressed'); toggle.click();
        return {before, after: toggle.getAttribute('aria-pressed'),
          saved: localStorage.getItem('negev:show-adult:1')}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/discover?q=Lovely') });
    await wait(1200);
    const searchAdult = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const cards = [...document.querySelectorAll('#results [data-anidb-id]')];
        const shown = cards.filter((card) => !card.hidden).map((card) => Number(card.dataset.anidbId));
        return {shown, adultsHidden: cards.filter((card) =>
          ['14974', '11003'].includes(card.dataset.anidbId)).every((card) => card.hidden)}; })()`,
    });
    const searchAdultLabels = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { document.querySelector('#adult-toggle').click();
        return [...document.querySelectorAll('#results [data-adult="true"]')]
          .map((card) => ({id: Number(card.dataset.anidbId),
            label: card.querySelector('.adult-label')?.textContent})); })()`,
    });
    await send('Runtime.evaluate', { expression:
      `document.querySelector('#adult-toggle').click()` });
    await send('Page.navigate', { url: url.replace('#/discover', '#/discover?year=2026&season=FALL') });
    await wait(800);
    const filtered = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({adultHidden: document.querySelector('#season-list [data-anidb-id="9589"]')?.hidden,
        normalVisible: !document.querySelector('#season-list [data-anidb-id="4158"]')?.hidden})`,
    });
    const liveToggle = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const toggle = document.querySelector('#adult-toggle');
        toggle.click();
        const adultVisible = !document.querySelector('#season-list [data-anidb-id="9589"]')?.hidden;
        toggle.click();
        const adultHiddenAgain = document.querySelector('#season-list [data-anidb-id="9589"]')?.hidden;
        return {adultVisible, adultHiddenAgain}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/4158') });
    await wait(800);
    const franchiseBefore = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const button = document.querySelector('.related-trigger');
        const before = {button: button?.textContent,
          count: document.querySelectorAll('.related-card').length};
        button?.click(); return before; })()`,
    });
    await wait(300);
    const franchiseAfter = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const cards = [...document.querySelectorAll('.related-list .related-card')];
        const firstTop = cards[0]?.getBoundingClientRect().top;
        return {listed: document.querySelector('.related-list')?.textContent,
          posterCards: document.querySelectorAll('.related-list .related-card img').length,
          relationLabels: [...document.querySelectorAll('.related-relation')]
            .map((label) => label.textContent),
          relationBelowPoster: cards.every((card) => {
            const poster = card.querySelector('.related-art')?.getBoundingClientRect();
            const relation = card.querySelector('.related-relation')?.getBoundingClientRect();
            return poster && relation && relation.top >= poster.bottom - 1;
          }),
          firstRowCount: cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2).length,
          next: document.querySelector('.related-trigger')?.textContent}; })()`,
    });
    if (process.env.NEGEV_UI_CAPTURE_DIR && width === 1200) {
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true,
        captureBeyondViewport: true });
      await writeFile(join(process.env.NEGEV_UI_CAPTURE_DIR, 'related-desktop.png'),
        Buffer.from(shot.data, 'base64'));
    }
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/42') });
    await wait(700);
    const requestReview = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        const button = action?.querySelector('.primary'); button?.click();
        return {button: button?.textContent,
          reviewVisible: !action?.querySelector('.request-review')?.hidden,
          summary: action?.querySelector('.request-review p')?.textContent}; })()`,
    });
    const requestCancelled = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        action.querySelector('.request-review button').click();
        return {reviewHidden: action.querySelector('.request-review').hidden,
          button: action.querySelector('.primary').textContent,
          status: action.querySelector('.request-feedback').textContent}; })()`,
    });
    await send('Runtime.evaluate', { expression:
      `document.querySelector('.request-action .primary').click()` });
    const requestSelection = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        const select = action.querySelector('select'); select.value = '43';
        select.dispatchEvent(new Event('change'));
        return {route: location.hash, summary: action.querySelector('.request-review p')?.textContent,
          cancelLabel: action.querySelector('.request-review button')?.textContent}; })()`,
    });
    await send('Runtime.evaluate', { expression: `document.querySelector('.request-action .primary').click()` });
    await wait(250);
    const requestSaved = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return {reviewHidden: action.querySelector('.request-review')?.hidden,
          receipt: action.querySelector('.request-feedback')?.textContent}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/19848') });
    await wait(700);
    const coldBeforeFallback = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({loading: document.querySelector('#detail')?.textContent.includes('Loading episode details'),
        hasRequest: Boolean(document.querySelector('#detail .request-action'))})`,
    });
    await wait(10_200);
    const coldRequestReview = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        const button = action?.querySelector('.primary'); button?.click();
        return {button: button?.textContent,
          reviewVisible: !action?.querySelector('.request-review')?.hidden,
          summary: action?.querySelector('.request-review p')?.textContent}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/19849') });
    await wait(700);
    await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        action?.querySelector('.primary')?.click();
        [...document.querySelectorAll('#detail button')]
          .find((button) => button.textContent === 'Retry loading details')?.click();
        return true; })()`,
    });
    await wait(700);
    const reviewAfterRetry = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return {button: action?.querySelector('.primary')?.textContent,
          reviewVisible: !action?.querySelector('.request-review')?.hidden}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/20291') });
    await wait(700);
    const unlistedFilm = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('#detail .request-action');
        const message = document.querySelector('#detail')?.textContent;
        const button = action?.querySelector('.primary');
        const label = button?.textContent;
        button?.click();
        return { message, action: label,
          summary: action?.querySelector('.request-review p')?.textContent }; })()`,
    });
    let airingTrack = null;
    if (width === 390) {
      await send('Page.navigate', { url: url.replace('#/discover', '#/airing') });
      await wait(800);
      const weeklyPresence = await send('Runtime.evaluate', { returnByValue: true,
        expression: `(() => [...document.querySelectorAll('#airing-list .result')]
          .map((card) => ({title: card.querySelector('strong')?.textContent,
            badge: card.querySelector('.presence')?.textContent})))()`,
      });
      const defaultMode = await send('Runtime.evaluate', { returnByValue: true,
        expression: `document.querySelector('#airing-view-mode')?.value`,
      });
      await send('Runtime.evaluate', { expression: `(() => {
        const mode = document.querySelector('#airing-view-mode');
        mode.value = 'all'; mode.dispatchEvent(new Event('change'));
      })()` });
      await wait(800);
      const allWeeklyPresence = await send('Runtime.evaluate', { returnByValue: true,
        expression: `(() => [...document.querySelectorAll('#airing-list .result')]
          .map((card) => ({title: card.querySelector('strong')?.textContent,
            badge: card.querySelector('.presence')?.textContent})))()`,
      });
      await send('Runtime.evaluate', { expression:
        `document.querySelector('.tracked-title button')?.click()` });
      await wait(300);
      const tracked = await send('Runtime.evaluate', { returnByValue: true,
        expression: `document.querySelector('.tracked-title button')?.textContent`,
      });
      await send('Runtime.evaluate', { expression: `(() => {
        const mode = document.querySelector('#airing-view-mode');
        mode.value = 'custom'; mode.dispatchEvent(new Event('change'));
      })()` });
      await wait(800);
      const custom = await send('Runtime.evaluate', { returnByValue: true,
        expression: `({mode: document.querySelector('#airing-view-mode')?.value,
          card: document.querySelector('.tracked-title .poster-card')?.textContent,
          fits: document.documentElement.scrollWidth <= innerWidth})`,
      });
      airingTrack = { defaultMode: defaultMode.result.value,
        tracked: tracked.result.value, ...custom.result.value,
        weeklyPresence: weeklyPresence.result.value,
        allWeeklyPresence: allWeeklyPresence.result.value };
      await send('Runtime.evaluate', { expression: `(() => {
        const mode = document.querySelector('#airing-view-mode');
        mode.value = 'library'; mode.dispatchEvent(new Event('change'));
      })()` });
      await wait(300);
    }
    return { ...result.value, mobilePager: mobilePager.result.value,
      tagBrowse: tagBrowse.result.value,
      menu: menu.result.value,
      adultChoice: adultChoice.result.value, searchAdult: searchAdult.result.value,
      searchAdultLabels: searchAdultLabels.result.value,
      filtered: filtered.result.value,
      liveToggle: liveToggle.result.value,
      franchise: { before: franchiseBefore.result.value,
        ...franchiseAfter.result.value },
      requestReview: requestReview.result.value,
      requestSelection: requestSelection.result.value,
      requestCancelled: requestCancelled.result.value,
      requestSaved: requestSaved.result.value,
      coldBeforeFallback: coldBeforeFallback.result.value,
      coldRequestReview: coldRequestReview.result.value,
      reviewAfterRetry: reviewAfterRetry.result.value,
      unlistedFilm: unlistedFilm.result.value, airingTrack };
  } finally {
    socket?.close();
    child.kill();
    await closed;
  }
}

test('signed-in consumer routes render real shell with search, library and requests',
  { skip: browser ? false : 'No Chrome or Edge browser installed' }, async () => {
    let allowAdult = true;
    let airingPreference = { mode: 'library', trackedAnidbIds: [] };
    let coldSeasonReads = 0;
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      response.setHeader('Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'");
      if (path === '/api/session') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ user: { id: 1, username: 'Owner', role: 'admin',
          adultAllowed: allowAdult },
          csrfToken: 'test-only', capabilities: { acquisitionState: 'disabled',
            titleChecks: true, detailLoad: true } }));
        return;
      }
      if (path === '/api/admin/users') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'users', items: [{ id: 1,
          username: 'Owner', role: 'admin', disabled: false, adultAllowed: true }] }));
        return;
      }
      if (path === '/api/requests') {
        if (request.method === 'POST') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'pending', requestId: 7,
            waitingFor: 'release_schedule' }));
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ items: [{
          id: 1, anidbId: 4158, title: 'Pale Cocoon', kind: 'movie', status: 'held',
          episodeIds: [10], monitorFuture: false, watchClosed: false,
          progress: { state: 'saved', targetCount: 1,
            publicAvailability: 'unverified', publicVerifiedTargets: 0 },
        }, {
          id: 2, anidbId: 9589, title: 'The Garden of Words', kind: 'movie',
          episodeIds: [11], monitorFuture: false, watchClosed: false,
          progress: { state: 'saved', targetCount: 1,
            publicAvailability: 'verified_recently', publicVerifiedTargets: 1 },
        }, {
          id: 3, anidbId: 7, title: 'A title needing help', kind: 'series',
          episodeIds: [12], monitorFuture: false, watchClosed: false,
          progress: { state: 'review_needed', targetCount: 1,
            publicAvailability: 'unverified', publicVerifiedTargets: 0 },
        }], nextBeforeId: null }));
        return;
      }
      if (path === '/api/request-preparations') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ items: [{ id: 12, anidbId: 19847,
          title: 'FX Senshi Kurumi-chan', state: 'pending',
          reason: 'detail_pending', createdMs: 1_000 }], nextBeforeId: 12 }));
        return;
      }
      if (path === '/api/catalogue/search') {
        if (new URL(request.url, 'http://localhost').searchParams.get('q') === 'Lovely') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'results', page: 1, total: 3,
            catalogueSource: 'test', items: [
              { anidbId: 14974, title: 'Lovely' },
              { anidbId: 11003, title: 'Lovely x Cation' },
              { anidbId: 2498, title: 'Lovely Angels' }] }));
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'results', page: 1, total: 1,
          catalogueSource: 'test', items: [{ anidbId: 4158,
            title: 'Pale Cocoon', libraryPresence: { state: 'unknown',
              verifiedEpisodeCount: 0 } }] }));
        return;
      }
      if (['/api/catalogue/14974/display', '/api/catalogue/11003/display',
        '/api/catalogue/2498/display'].includes(path)) {
        const anidbId = Number(path.split('/')[3]);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display', anidbId,
          title: 'Verified title', restricted: anidbId !== 2498 }));
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
            episodeNumber: '4', adult: false,
            libraryPresence: { state: 'in_library', verifiedEpisodeCount: 2 } },
          { anidbId: 19765, title: 'Psyren',
            scheduledDate: '2026-11-05', episodeNumber: '5', adult: false,
            libraryPresence: { state: 'unknown', verifiedEpisodeCount: 0 } }] }));
        return;
      }
      if (path === '/api/airing/preferences') {
        if (request.method === 'PUT') {
          let body = '';
          for await (const chunk of request) body += chunk;
          airingPreference = JSON.parse(body);
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(airingPreference));
        return;
      }
      if (path === '/api/seasons') {
        const params = new URL(request.url, 'http://localhost').searchParams;
        if (params.get('year') === '2025') {
          const after = Number(params.get('after') ?? 0);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'ready', year: 2025,
            season: 'ALL', sourceDate: '2026-11-05', availableTags: [], total: 25,
            items: [{ anidbId: 4158, title: `Page ${after / 12 + 1}`,
              type: 'OVA', adult: false }],
            nextAfter: after + 12 < 25 ? after + 12 : null }));
          return;
        }
        const ongoing = params.get('status') === 'ongoing';
        if (ongoing && params.get('sort') !== 'popular_desc') {
          response.statusCode = 400;
          response.end('Expected popularity-first airing order');
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'ready', year: 2026, season: 'FALL',
          sourceDate: '2026-11-05', availableTags: ['action', 'fantasy', 'romance',
            ...Array.from({ length: 65 }, (_, index) => `genre ${index + 1}`)],
          ...(ongoing ? { orderState: 'score_loading' } : {}),
          items: ongoing ? [{ anidbId: 19847, title: 'FX Senshi Kurumi-chan',
            type: 'TV Series', releaseStatus: 'ONGOING', adult: false,
            rating: { score: 7.8, votes: 1400, members: 3000,
              checkedMs: 1_000 },
            libraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 } }] :
            [{ anidbId: 4158,
            title: 'Pale Cocoon', type: 'OVA', releaseStatus: 'FINISHED',
            adult: false, libraryPresence: { state: 'unknown',
              verifiedEpisodeCount: 0 } }, { anidbId: 9589, title: 'The Garden of Words',
            type: 'Movie', releaseStatus: 'FINISHED', adult: true,
            libraryPresence: { state: 'in_library',
              verifiedEpisodeCount: 1 } }],
          nextAfter: null }));
        return;
      }
      if (path === '/api/catalogue/4158/title-check') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'not_started' }));
        return;
      }
      if (path === '/api/catalogue/4158/related') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'related_titles', anidbId: 4158,
          completeness: 'unproven', items: [{ anidbId: 9589,
            title: 'The Garden of Words', relation: 'SideStory',
            libraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 } },
          { anidbId: 9600, title: 'Another related film', relation: 'Sequel' },
          { anidbId: 9601, title: 'Prequel season', relation: 'Prequel' },
          { anidbId: 9602, title: 'A separate special', relation: 'SideStory' },
          { anidbId: 9603, title: 'Another installment', relation: 'Alternative' }] }));
        return;
      }
      if (/^\/api\/catalogue\/(9589|9600|9601|9602|9603|9604|9605)\/related$/.test(path)) {
        const anidbId = Number(path.split('/')[3]);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'related_titles', anidbId,
          completeness: 'unproven', items: anidbId === 9589 ? [
            { anidbId: 9604, title: 'Next film', relation: 'Sequel' },
            { anidbId: 9605, title: 'Extra episode', relation: 'SideStory' },
          ] : [] }));
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
      if (path === '/api/catalogue/20291') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 20291,
          title: 'Unlisted future film', kind: 'movie', restricted: false,
          page: 1, total: 0, nextPage: null, episodes: [] }));
        return;
      }
      if (path === '/api/catalogue/7') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 7,
          title: 'Film with alternate parts', kind: 'movie', restricted: false,
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 2 },
          page: 1, total: 4, nextPage: 2, episodes: [
            { id: 71, number: 1, type: 'Episode', title: 'Complete Movie',
              availability: 'available', availabilityNote: 'alternate_card' },
            { id: 72, number: 2, type: 'Episode', title: 'Part 1', availability: 'unknown' },
            { id: 73, number: 3, type: 'Episode', title: 'Part 2', availability: 'unknown' },
          ] }));
        return;
      }
      if (path === '/api/catalogue/42') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 42,
          title: 'Example Series', kind: 'series', restricted: false,
          page: 1, total: 1, nextPage: null, monitorFuture: true,
          episodes: [{ id: 4201, number: 1, type: 'Episode', title: 'First',
            availability: 'available' }] }));
        return;
      }
      if (path === '/api/catalogue/42/related') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'related_titles', anidbId: 42,
          completeness: 'unproven', items: [{ anidbId: 43,
            title: 'Example Season Two', relation: 'Sequel' }] }));
        return;
      }
      if (path === '/api/catalogue/96') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 96,
          title: 'Partly verified season', kind: 'series', restricted: false,
          monitorFuture: true, episodeCount: 4,
          regularSeason: { verified: 1, total: 4 },
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 2 },
          page: 1, total: 5, nextPage: 2,
          episodes: [{ id: 9601, number: 1, type: 'Episode',
            title: 'First', availability: 'available' },
          { id: 9602, number: 2, type: 'Episode',
            title: 'Second', availability: 'unknown' }] }));
        return;
      }
      if (path === '/api/catalogue/95') {
        coldSeasonReads++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 95,
          title: 'Cold partly verified season', kind: 'series', restricted: false,
          monitorFuture: true, episodeCount: 4,
          ...(coldSeasonReads > 1 ?
            { regularSeason: { verified: 1, total: 4 } } : {}),
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 2 },
          page: 1, total: 5, nextPage: 2,
          episodes: [{ id: 9501, number: 1, type: 'Episode',
            title: 'First', availability: 'available' },
          { id: 9502, number: 2, type: 'Episode',
            title: 'Second', availability: 'unknown' }] }));
        return;
      }
      if (path === '/api/catalogue/99' || path === '/api/catalogue/98') {
        const secondPage = new URL(request.url, 'http://localhost')
          .searchParams.get('page') === '2';
        const missingLast = path.endsWith('/98');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: missingLast ? 98 : 99,
          title: missingLast ? 'Incomplete paginated series' : 'Complete paginated series',
          kind: 'series', restricted: false,
          monitorFuture: false, episodeCount: 4, endDate: '2020-01-01',
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 4 },
          page: secondPage ? 2 : 1, total: 4, nextPage: secondPage ? null : 2,
          episodes: (secondPage ? [3, 4] : [1, 2]).map((number) => ({
            id: (missingLast ? 9800 : 9900) + number, number, type: 'Episode',
            title: `Episode ${number}`,
            availability: missingLast && number === 4 ? 'unknown' : 'available',
          })) }));
        return;
      }
      if (path === '/api/catalogue/97') {
        const page = Number(new URL(request.url, 'http://localhost')
          .searchParams.get('page') ?? 1);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 97,
          title: 'Long complete series', kind: 'series', restricted: false,
          monitorFuture: false, episodeCount: 10, endDate: '2020-01-01',
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 10 },
          page, total: 10, nextPage: page === 10 ? null : page + 1,
          episodes: [{ id: 9700 + page, number: page, type: 'Episode',
            title: `Episode ${page}`, availability: 'available' }] }));
        return;
      }
      if (path === '/api/catalogue/4158/display') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display', anidbId: 4158,
          title: 'Pale Cocoon', englishTitle: null, type: 'OVA',
          startYear: 2005, startDate: '2005-12-10', endDate: '2005-12-10',
          episodeCount: 1, description: 'A quiet archive and a lost world.',
          tags: ['Science fiction'] }));
        return;
      }
      if (path === '/api/catalogue/19847/display') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display', anidbId: 19847,
          title: 'FX Senshi Kurumi-chan', restricted: false,
          englishTitle: null, type: 'TV Series',
          startYear: 2026, startDate: '2026-10-01', endDate: null,
          episodeCount: 12, description: 'A new anime description.', tags: [] }));
        return;
      }
      if (path === '/api/catalogue/19848/display') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display', anidbId: 19848,
          title: 'Cold title', restricted: false }));
        return;
      }
      if (path === '/api/catalogue/19847') {
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
      }
      if (path === '/api/catalogue/19848') {
        // A cold catalogue read may outlive the first render. The title must
        // remain requestable while the episode list is still loading.
        setTimeout(() => {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'detail_pending', anidbId: 19848,
            title: 'Cold title', restricted: false }));
        }, 13_000);
        return;
      }
      if (path === '/api/catalogue/19849/load-detail') {
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
      }
      if (path === '/api/catalogue/19849') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'detail_pending', anidbId: 19849,
          title: 'Pending title', restricted: false }));
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
      assert.match(browse, /Pale Cocoon/);
      assert.match(browse, /<h1>Browse anime\.<\/h1>/);
      assert.doesNotMatch(browse, /id="discover-shelves"/);
      assert.match(browse, /The Garden of Words/);
      const mobile = await inspectMobile(`${base}/#/discover`, join(dir, 'mobile'));
      assert.equal(mobile.width, 390);
      assert.equal(mobile.hasContent, true);
      assert.ok(mobile.scrollWidth <= 390, 'mobile page has no horizontal overflow');
      assert.ok(mobile.accountRight <= 390, 'Account control remains visible');
      assert.ok(mobile.searchRight <= 390, 'Search remains visible');
      assert.deepEqual(mobile.mobilePager, { label: 'Page 2 of 3',
        visible: true, fits: true, previousEnabled: true, nextEnabled: true });
      assert.deepEqual(mobile.tagBrowse, { before: 40, after: 68,
        moreHidden: true, selected: true, summary: 'Genres & themes · 1' });
      assert.ok(mobile.menu.right <= 390 && mobile.menu.signoutVisible,
        'Account menu and sign-out remain usable');
      assert.deepEqual(mobile.adultChoice, { before: 'true', after: 'false', saved: 'off' });
      assert.deepEqual(mobile.searchAdult, { shown: [2498], adultsHidden: true });
      assert.deepEqual(mobile.searchAdultLabels, [
        { id: 14974, label: '18+' }, { id: 11003, label: '18+' }]);
      assert.deepEqual(mobile.filtered, { adultHidden: true, normalVisible: true });
      assert.deepEqual(mobile.liveToggle, { adultVisible: true, adultHiddenAgain: true });
      assert.deepEqual(mobile.franchise.before,
        { button: 'Show more related titles', count: 5 });
      assert.match(mobile.franchise.listed, /The Garden of Words/);
      assert.match(mobile.franchise.listed, /Side story/);
      assert.match(mobile.franchise.listed, /1 verified item in library/);
      assert.equal(mobile.franchise.posterCards, 7);
      assert.deepEqual(mobile.franchise.relationLabels,
        ['Prequel', 'Sequel', 'Sequel', 'Side story', 'Side story',
          'Side story', 'Alternative']);
      assert.equal(mobile.franchise.relationBelowPoster, true,
        'relation labels remain readable below poster artwork');
      assert.equal(mobile.franchise.next, 'No more cached links to explore');
      assert.deepEqual(mobile.requestReview, { button: 'Confirm request',
        reviewVisible: true,
        summary: 'Example Series · this installment’s regular episodes and future episodes' });
      assert.deepEqual(mobile.requestSelection, { route: '#/title/42',
        summary: 'Example Season Two · Negev will check its film or episodes before saving',
        cancelLabel: 'Cancel' });
      assert.deepEqual(mobile.requestCancelled, { reviewHidden: true,
        button: 'Watch future episodes', status: '' });
      assert.equal(mobile.requestSaved.reviewHidden, true);
      assert.deepEqual(mobile.coldBeforeFallback, { loading: true, hasRequest: false });
      assert.match(mobile.requestSaved.receipt, /Request #7 saved/);
      assert.deepEqual(mobile.coldRequestReview, { button: 'Confirm request',
        reviewVisible: true,
        summary: 'Anime 19848 · Negev will identify the film or episodes and check the library first' });
      assert.equal(mobile.reviewAfterRetry.button, 'Confirm request');
      assert.equal(mobile.reviewAfterRetry.reviewVisible, true);
      assert.equal(mobile.unlistedFilm.action, 'Request if missing');
      assert.match(mobile.unlistedFilm.message,
        /wait for an exact film entry before any download/i);
      assert.equal(mobile.unlistedFilm.summary,
        'Unlisted future film · Negev will identify the film or episodes and check the library first');
      assert.equal(mobile.airingTrack.defaultMode, 'library');
      assert.equal(mobile.airingTrack.tracked, 'Stop tracking');
      assert.equal(mobile.airingTrack.mode, 'custom');
      assert.match(mobile.airingTrack.card, /FX Senshi Kurumi-chan/);
      assert.equal(mobile.airingTrack.fits, true);
      assert.deepEqual(mobile.airingTrack.weeklyPresence, [
        { title: 'FX Senshi Kurumi-chan', badge: '✓ In library' },
      ]);
      assert.deepEqual(mobile.airingTrack.allWeeklyPresence, [
        { title: 'FX Senshi Kurumi-chan', badge: '✓ In library' },
        { title: 'Psyren', badge: 'Local availability not checked' },
      ]);
      const desktopRelated = await inspectMobile(`${base}/#/discover`,
        join(dir, 'related-desktop'), 1200);
      assert.ok(desktopRelated.franchise.firstRowCount >= 4,
        'related anime use the desktop page width');
      const tablet = await inspectMobile(`${base}/#/discover`, join(dir, 'tablet'), 709);
      assert.ok(tablet.accountTop < tablet.headerBottom,
        'Account control stays inside the tablet header');
      assert.equal(tablet.mobileNavVisible, true,
        'Tablet navigation stays visible after the desktop links no longer fit');
      const library = await dump(`${base}/#/library`, join(dir, 'library'), 'library');
      assert.match(library, /Negev’s Library/);
      assert.match(library, /The Garden of Words/);
      assert.match(library, /<div id="library-list" class="poster-grid"><a class="poster-card"/);
      assert.match(library, /1 verified item/);
      const airing = await dump(`${base}/#/airing`, join(dir, 'airing'), 'airing');
      assert.match(airing, /<h1>Airing anime<\/h1>/);
      assert.doesNotMatch(airing, /Ongoing this season/);
      assert.match(airing, /id="airing-sort"/);
      assert.match(airing, /id="airing-view-mode"/);
      assert.match(airing, /id="airing-kind"/);
      assert.match(airing, /FX Senshi Kurumi-chan/);
      assert.match(airing, /★ 7\.8 · 3K members/);
      assert.match(airing, /✓ In library/);
      assert.doesNotMatch(airing, /Psyren/);
      const season = await dump(`${base}/#/discover?year=2026&season=FALL`,
        join(dir, 'season'), 'season');
      assert.match(season, /Pale Cocoon/);
      assert.match(season, /The Garden of Words/);
      assert.match(season, /18\+/);
      assert.match(season, /✓ In library · 1 verified item/);
      const pageOne = await dump(`${base}/#/discover?year=2025&season=ALL`,
        join(dir, 'page-one'));
      assert.match(pageOne, /Page 1 of 3/);
      assert.match(pageOne, /id="season-previous"[^>]*disabled/);
      const pageTwo = await dump(`${base}/#/discover?year=2025&season=ALL&after=12`,
        join(dir, 'page-two'));
      assert.match(pageTwo, /Page 2 of 3/);
      assert.doesNotMatch(pageTwo, /id="season-previous"[^>]*disabled/);
      const pageThree = await dump(`${base}/#/discover?year=2025&season=ALL&after=24`,
        join(dir, 'page-three'));
      assert.match(pageThree, /Page 3 of 3/);
      assert.match(pageThree, /id="season-next"[^>]*disabled/);
      const detail = await dump(`${base}/#/title/4158`, join(dir, 'detail'), 'detail');
      assert.match(detail, /Request film/);
      assert.match(detail, /Pale Cocoon/);
      assert.match(detail, /A quiet archive and a lost world/);
      assert.match(detail, /Listed episodes/);
      assert.match(detail, /class="detail-main"/,
        'title synopsis and aliases share a compact column beside the facts');
      assert.match(detail, /Back to Discover/);
      assert.doesNotMatch(detail, /Recheck unknown entries in background/);
      assert.match(detail, /Episode and Special options/);
      assert.doesNotMatch(detail, /Choose a season or installment/);
      const seriesDetail = await dump(`${base}/#/title/42`,
        join(dir, 'series-detail'));
      assert.match(seriesDetail, /Choose a season or installment/);
      assert.match(seriesDetail, /class="installment-choice"/);
      assert.match(seriesDetail, /Watch future episodes/);
      assert.doesNotMatch(seriesDetail, /Already available/);
      const partialSeason = await dump(`${base}/#/title/96`,
        join(dir, 'partial-season'));
      assert.match(partialSeason, /1 of 4 regular episodes verified playable in Plex/);
      assert.doesNotMatch(partialSeason,
        /2 of 4 regular episodes verified playable in Plex/);
      const refreshedSeason = await dump(`${base}/#/title/95`,
        join(dir, 'refreshed-season'));
      assert.ok(coldSeasonReads >= 2,
        'the detail page retries its catalogue count after the raw cache warms');
      assert.match(refreshedSeason,
        /1 of 4 regular episodes verified playable in Plex/);
      const completePaginated = await dump(`${base}/#/title/99`,
        join(dir, 'complete-paginated'));
      assert.match(completePaginated, /4 of 4 regular episodes verified playable in Plex/);
      assert.match(completePaginated,
        /<button class="primary" disabled="">Already available<\/button>/);
      assert.doesNotMatch(completePaginated, /Show more episodes/);
      const incompletePaginated = await dump(`${base}/#/title/98`,
        join(dir, 'incomplete-paginated'));
      assert.match(incompletePaginated, /3 of 4 regular episodes verified playable in Plex/);
      assert.match(incompletePaginated, /<button class="primary">Request series<\/button>/);
      const longComplete = await dump(`${base}/#/title/97`,
        join(dir, 'long-complete'));
      assert.match(longComplete,
        /<button class="primary" disabled="">Already available<\/button>/);
      const throttledDetail = await dump(`${base}/#/title/19847`,
        join(dir, 'throttled-detail'));
      assert.match(throttledDetail, /A new anime description/);
      assert.match(throttledDetail, /Episode details are temporarily unavailable/);
      assert.match(throttledDetail, /Try again/);
      assert.match(throttledDetail, /Request if missing/);
      const coldDetail = await dump(`${base}/#/title/19848`,
        join(dir, 'cold-detail'));
      assert.match(coldDetail, /Request if missing/,
        'the request action appears before a cold episode-list read finishes');
      const busyDetail = await dump(`${base}/#/title/19849`,
        join(dir, 'busy-detail'));
      assert.match(busyDetail, /Episode details are busy/);
      assert.match(busyDetail, /Request if missing/);
      assert.doesNotMatch(busyDetail, /id="message"[^>]*>Too Many Requests/);
      const alternateFilm = await dump(`${base}/#/title/7`, join(dir, 'alternate-film'));
      assert.match(alternateFilm, /Available in Plex · 1 verified main film entry/);
      assert.match(alternateFilm, /Choose one film entry/);
      assert.match(alternateFilm, /Playable in Plex; episode card not linked to this episode/);
      assert.match(alternateFilm, /Request selected film entry/);
      assert.match(alternateFilm, /<button class="primary" disabled="">Already available<\/button>/);
      assert.match(alternateFilm, /Choose the film version or part/);
      const requests = await dump(`${base}/#/requests`, join(dir, 'requests'));
      assert.match(requests, /Pale Cocoon/);
      assert.match(requests, /FX Senshi Kurumi-chan/);
      assert.match(requests, /Preparing episode details/);
      assert.match(requests, /id="more-preparations" type="button">Show older preparations/);
      assert.match(requests, /Cancel request/);
      assert.match(requests, /My requests/);
      assert.match(requests, /class="request-stage">Requested<\/strong>/);
      assert.match(requests, /No download is confirmed in progress/);
      assert.match(requests, /data-request-group="attention">(?:(?!<\/section>)[\s\S])*A title needing help/);
      assert.match(requests, /data-request-group="active">(?:(?!<\/section>)[\s\S])*Pale Cocoon/);
      assert.match(requests, /data-request-group="completed">(?:(?!<\/section>)[\s\S])*The Garden of Words/);
      allowAdult = false;
      const ordinaryDescription = await dump(`${base}/#/title/19847`,
        join(dir, 'ordinary-description-adult-blocked'));
      assert.match(ordinaryDescription, /A new anime description/,
        'disabling 18+ must not hide an ordinary title synopsis');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true,
        maxRetries: 5, retryDelay: 100 });
    }
  });
