import { findTestBrowser, browserSkipReason } from './helpers/browser-executable.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const browser = findTestBrowser();
const staticRoot = new URL('../src/web/public/', import.meta.url);
// Serve public/ the way the server does: every page, script, stylesheet and font.
const assets = new Map([
  ...readdirSync(staticRoot).filter(name=>name.endsWith('.png')).map(name=>['/'+name,[name,'image/png']]),
  ...readdirSync(staticRoot).filter((name) => /\.(?:html|m?js|css)$/.test(name)).map((name) =>
    [name === 'index.html' ? '/' : `/${name}`, [name, name.endsWith('.html') ? 'text/html'
      : name.endsWith('.css') ? 'text/css' : 'text/javascript']]),
  ...readdirSync(new URL('fonts/', staticRoot)).filter((name) => name.endsWith('.ttf'))
    .map((name) => [`/fonts/${name}`, [`fonts/${name}`, 'font/ttf']]),
]);

const dump = async (url, profile, captureName, viewport = '1440,900', virtualTimeMs = 6000) => new Promise((resolve, reject) => {
  const screenshot = process.env.NEGEV_UI_CAPTURE_DIR && captureName
    ? join(process.env.NEGEV_UI_CAPTURE_DIR, `${captureName}.png`) : null;
  const child = spawn(browser, ['--headless=new', '--no-first-run',
    '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
    `--user-data-dir=${profile}`, `--virtual-time-budget=${virtualTimeMs}`,
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

async function inspectMobile(url, profile, width = 390, posterOnly = false) {
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
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Browser command timed out: '+method+' '+String(params.expression ?? params.url ?? '').slice(0, 240)));
      }, 30_000);
      pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const settled = async () => {
      for(let attempt=0;attempt<900;attempt++) {
        const {result}=await send('Runtime.evaluate',{returnByValue:true,expression:"[...document.querySelectorAll('#season-state,#airing-season-state,#library-state,.browse-page-marker,.library-page-marker')].some(el=>el.getClientRects().length && (el.classList.contains('browse-page-marker')||el.classList.contains('library-page-marker') ? el.textContent.trim()==='Loading more titles…' : el.textContent.trim().startsWith('Loading ')))"});
        if(!result.value)return;
        await wait(100);
      }
      assert.fail('catalogue read did not settle within its bounded pacing window');
    };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await send('Page.navigate', { url });
    if (posterOnly) {
      for (let attempt=0; attempt<150; attempt++) {
        const {result}=await send('Runtime.evaluate',{returnByValue:true,
          expression:`(() => {const image=document.querySelector('img[src="/api/catalogue/posters/anidb/4158"]');return Boolean(image?.complete&&image.naturalWidth>0&&image.parentElement.classList.contains('has-poster'));})()`});
        if(result.value){
          const html=await send('Runtime.evaluate',{returnByValue:true,expression:'document.documentElement.outerHTML'});
          return html.result.value;
        }
        await wait(100);
      }
      const state=await send('Runtime.evaluate',{returnByValue:true,expression:`({title:document.title,images:[...document.querySelectorAll('img')].map(i=>({src:i.getAttribute('src'),complete:i.complete,width:i.naturalWidth,connected:i.isConnected,parent:i.parentElement.className})),text:document.querySelector('#results')?.textContent})`});
      throw new Error('Native poster recovery did not load: '+JSON.stringify(state.result.value));
    }
    await wait(1200); await settled();
    await send('Runtime.evaluate', {expression:'document.fonts.ready',awaitPromise:true});
    await send('DOM.enable'); await send('CSS.enable');
    const doc = await send('DOM.getDocument');
    const typography = {};
    for (const [key,selector] of [['heading','#view-discover h1'],['control','#discover-search-button']]) {
      const node = await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector});
      typography[key]=(await send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId})).fonts;
    }
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
      '?libraryPages=1#/library') });
    await wait(800); await settled();
    const libraryBrowseFirst = await send('Runtime.evaluate', { returnByValue: true,
      expression: `document.querySelectorAll('#library-list .poster-card').length`,
    });
    await send('Runtime.evaluate', { expression: "location.hash = '#/library?q=Garden'" });
    await wait(500); await settled();
    await send('Runtime.evaluate', { expression: "location.hash = '#/library'" });
    await wait(800); await settled();
    await send('Runtime.evaluate', { expression:
      'window.scrollTo(0, document.documentElement.scrollHeight)' });
    await wait(1000); await settled();
    const libraryBrowseReturned = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({cards: document.querySelectorAll('#library-list .poster-card').length,
        last: [...document.querySelectorAll('#library-list .poster-card strong')].at(-1)?.textContent,
        marker: Boolean(document.querySelector('#library-list .library-page-marker'))})`,
    });
    await send('Page.navigate', { url: url.replace('#/discover',
      '#/discover?year=2025&season=ALL') });
    await wait(800); await settled();
    const browseFirst = await send('Runtime.evaluate', { returnByValue: true,
      expression: `document.querySelectorAll('#season-list .poster-card').length`,
    });
    const browseAhead = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => {
        const marker = document.querySelector('#season-list + .browse-page-marker');
        const top = marker.getBoundingClientRect().top + scrollY;
        window.scrollTo(0, top - innerHeight * 1.5);
        return {markerTop: marker.getBoundingClientRect().top, height: innerHeight,
          cards: document.querySelectorAll('#season-list .poster-card').length};
      })()`,
    });
    await wait(1200); await settled();
    const browseAheadLoaded = await send('Runtime.evaluate', { returnByValue: true,
      expression: `document.querySelectorAll('#season-list .poster-card').length`,
    });
    await send('Runtime.evaluate', { expression:
      'window.scrollTo(0, document.documentElement.scrollHeight)' });
    await wait(1200); await settled();
    const browseScrolled = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({cards: document.querySelectorAll('#season-list .poster-card').length,
        first: document.querySelector('#season-list .poster-card strong')?.textContent,
        retry: Boolean(document.querySelector('#season-list + .browse-page-marker button'))})`,
    });
    await send('Runtime.evaluate', { expression: "location.hash = '#/requests'" });
    await wait(300); await settled();
    await send('Runtime.evaluate', { expression:
      "location.hash = '#/discover?year=2025&season=ALL'" });
    await wait(800); await settled();
    await send('Runtime.evaluate', { expression:
      'window.scrollTo(0, document.documentElement.scrollHeight)' });
    await wait(1000); await settled();
    const browseReturned = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({cards: document.querySelectorAll('#season-list .poster-card').length,
        first: document.querySelector('#season-list .poster-card strong')?.textContent,
        retry: Boolean(document.querySelector('#season-list + .browse-page-marker button'))})`,
    });
    await send('Runtime.evaluate', { expression: `(() => {
      const sort = document.querySelector('#season-sort');
      sort.value = 'title_asc'; sort.dispatchEvent(new Event('change', {bubbles: true}));
    })()` });
    await wait(1000); await settled();
    const browseSorted = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({hash: location.hash,
        cards: document.querySelectorAll('#season-list .poster-card').length,
        first: document.querySelector('#season-list .poster-card strong')?.textContent})`,
    });
    await send('Page.navigate', { url: url.replace('#/discover',
      '#/discover?year=2024&season=ALL') });
    await wait(800); await settled();
    await send('Runtime.evaluate', { expression:
      'window.scrollTo(0, document.documentElement.scrollHeight)' });
    await wait(800); await settled();
    const browseRetry = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const retry = document.querySelector(
        '#season-list + .browse-page-marker button');
        const before = document.querySelectorAll('#season-list .poster-card').length;
        retry?.click(); return {before, visible: Boolean(retry)}; })()`,
    });
    await wait(800); await settled();
    const browseRecovered = await send('Runtime.evaluate', { returnByValue: true,
      expression: `document.querySelectorAll('#season-list .poster-card').length`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/airing') });
    await wait(900); await settled();
    await send('Runtime.evaluate', { expression: `(() => {
      document.querySelector('#airing-year').value = '2025';
      document.querySelector('#airing-form').requestSubmit();
    })()` });
    await wait(900); await settled();
    const airingFirst = await send('Runtime.evaluate', { returnByValue: true,
      expression: `document.querySelectorAll('#airing-season-list .tracked-title').length`,
    });
    await send('Runtime.evaluate', { expression:
      'window.scrollTo(0, document.documentElement.scrollHeight)' });
    await wait(1200); await settled();
    const airingScrolled = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({cards: document.querySelectorAll('#airing-season-list .tracked-title').length,
        retry: Boolean(document.querySelector('#airing-season-list + .browse-page-marker button'))})`,
    });
    await send('Runtime.evaluate', { expression: `(() => {
      document.querySelector('#airing-year').value = '2024';
      document.querySelector('#airing-form').requestSubmit();
    })()` });
    await wait(800); await settled();
    await send('Runtime.evaluate', { expression:
      'window.scrollTo(0, document.documentElement.scrollHeight)' });
    await wait(800); await settled();
    const airingRetry = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const retry = document.querySelector(
        '#airing-season-list + .browse-page-marker button');
        const before = document.querySelectorAll('#airing-season-list .tracked-title').length;
        retry?.click(); return {before, visible: Boolean(retry)}; })()`,
    });
    await wait(800); await settled();
    const airingRecovered = await send('Runtime.evaluate', { returnByValue: true,
      expression: `document.querySelectorAll('#airing-season-list .tracked-title').length`,
    });
    await send('Runtime.evaluate', { expression: `(() => {
      document.querySelector('#airing-year').value = '0';
      document.querySelector('#airing-form').requestSubmit();
    })()` });
    await send('Page.navigate', { url });
    await wait(300); await settled();
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
    const dropdowns = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => {
        const account = document.querySelector('#identity');
        account.open = true;
        document.querySelector('#username').click();
        const accountInside = account.open;
        document.querySelector('main').click();
        const accountOutside = !account.open;
        const filters = document.querySelector('#discover-filters-toggle');
        if (getComputedStyle(filters).display !== 'none' && filters.getAttribute('aria-expanded') !== 'true') filters.click();
        const picker = document.querySelector('#season-form .genre-picker');
        picker.open = true;
        const search = picker.querySelector('input[type=search]');
        search.click();search.focus();search.value='genre 55';search.dispatchEvent(new Event('input',{bubbles:true}));
        const genreSearch=picker.open && Boolean(picker.querySelector('input[type=checkbox]'));
        const choice = picker.querySelector('input[type=checkbox]');
        const before = choice.checked; choice.click();
        const genreInside = picker.open && choice.checked !== before;
        const selected = choice.checked;
        document.querySelector('.brand span').click();
        const genreOutside = !picker.open && choice.checked === selected;
        picker.open = true;
        search.focus();
        search.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
        const escape = !picker.open && document.activeElement === picker.querySelector('summary');
        choice.click();
        const airing = document.querySelector('#airing-form .genre-picker');
        airing.open = true;
        document.querySelector('main').click();
        return {accountInside,accountOutside,genreInside,genreOutside,genreSearch,escape,
          airingOutside:!airing.open};
      })()`,
    });
    await send('Page.navigate',{url:url.replace('#/discover','#/airing')});
    await wait(500); await settled();
    const airingDropdown=await send('Runtime.evaluate',{returnByValue:true,
      expression:`(() => {const filters=document.querySelector('#airing-filters-toggle');if(filters.getAttribute('aria-expanded')!=='true')filters.click();const picker=document.querySelector('#airing-form .genre-picker');
        const visible=picker.getBoundingClientRect().height>0;
        picker.querySelector('summary').click();
        const search=picker.querySelector('input[type=search]');search.click();search.focus();
        search.value='genre';search.dispatchEvent(new Event('input',{bubbles:true}));
        const searchInside=picker.open;
        const choice=picker.querySelector('input[type=checkbox]');
        const before=choice.checked;choice.click();const checkboxInside=picker.open&&choice.checked!==before;
        const selected=choice.checked;document.querySelector('main').click();
        const outside=!picker.open&&choice.checked===selected;
        picker.querySelector('summary').click();search.focus();
        search.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        const escape=!picker.open&&document.activeElement===picker.querySelector('summary');
        choice.click();return{visible,searchInside,checkboxInside,outside,escape};})()`});
    await send('Page.navigate',{url});await wait(300); await settled();
    const toggleGeometry = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { document.querySelector('#identity').open=true; const toggle = document.querySelector('#chinese-toggle');
        const account = document.querySelector('#identity');
        const measure = () => { const b=toggle.getBoundingClientRect();
          const range=document.createRange();range.selectNodeContents(toggle);
          const css=getComputedStyle(toggle);
          return {width:b.width,height:b.height,accountLeft:account.getBoundingClientRect().left,
            fits:range.getBoundingClientRect().width<=b.width-parseFloat(css.borderLeftWidth)-parseFloat(css.borderRightWidth)-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight)}; };
        const on=measure();toggle.click();const off=measure();toggle.click();
        const restored=measure();const original=toggle.style.fontFamily;
        const fontChecks=['serif','monospace','Arial'].map(font=>{
          toggle.style.fontFamily=font;const before=measure();toggle.click();const after=measure();toggle.click();
          return {font,stable:before.width===after.width&&before.height===after.height&&before.accountLeft===after.accountLeft,
            fits:before.fits&&after.fits};
        });toggle.style.fontFamily=original;
        return {on,off,restored,fontChecks}; })()`,
    });
    const adultChoice = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const toggle = document.querySelector('#adult-toggle');
        const before = toggle.getAttribute('aria-pressed'); toggle.click();
        return {before, after: toggle.getAttribute('aria-pressed'),
          saved: localStorage.getItem('negev:show-adult:1')}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/discover?q=Lovely') });
    await wait(1200); await settled();
    const searchAdult = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const cards = [...document.querySelectorAll('#results [data-anidb-id]')];
        const shown = cards.filter((card) => !card.hidden).map((card) => Number(card.dataset.anidbId));
        const safe = cards.find(card => card.dataset.anidbId === '2498');
        document.querySelector('#chinese-toggle').click();
        const safeChineseHidden = safe?.hidden;
        document.querySelector('#chinese-toggle').click();
        return {shown, safeTitle: safe?.querySelector('strong')?.textContent,
          safeChineseHidden,
          safePoster: safe?.querySelector('img')?.getAttribute('src'),
          adultsHidden: cards.filter((card) =>
          ['14974', '11003'].includes(card.dataset.anidbId)).every((card) => card.hidden)}; })()`,
    });
    const searchTrack = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({present: Boolean(document.querySelector('#results .tracked-title .track-toggle'))})`,
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
    await wait(800); await settled();
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
    const chineseChoice = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const toggle = document.querySelector('#chinese-toggle');
        const card = document.querySelector('#season-list [data-anidb-id="4158"]');
        const before = !card.hidden; toggle.click(); const hidden = card.hidden;
        toggle.click(); return {before, hidden, restored: !card.hidden,
          label: toggle.textContent}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/4158') });
    await wait(800); await settled();
    const longSynopsis=await send('Runtime.evaluate',{returnByValue:true,
      expression:`(() => {const description=document.querySelector('#detail .detail-description');
        const toggle=document.querySelector('#detail .detail-description-toggle');
        const collapsed=description.classList.contains('is-collapsed');toggle.click();
        const expanded=!description.classList.contains('is-collapsed')&&toggle.getAttribute('aria-expanded')==='true';
        toggle.click();return{collapsed,expanded,collapsedAgain:description.classList.contains('is-collapsed'),
          label:toggle.textContent};})()`});
    const titleTrack = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const button = document.querySelector('#detail .detail-action-row .track-toggle');
        return {label: button?.textContent, enabled: !button?.disabled,
          nextToRequest: Boolean(button?.parentElement.querySelector('.primary'))}; })()`,
    });
    const franchiseBefore = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const button = document.querySelector('.related-trigger');
        const list = document.querySelector('.related-list');
        const before = {button: button?.textContent, visible: !button?.hidden,
          count: list.querySelectorAll('.related-card').length,
          capacity: getComputedStyle(list).gridTemplateColumns.split(' ').length};
        if (!button.hidden) button.click(); return before; })()`,
    });
    await wait(300); await settled();
    const franchiseAfter = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const cards = [...document.querySelectorAll('.related-list .related-card')];
        const firstTop = cards[0]?.getBoundingClientRect().top;
        return {listed: document.querySelector('.related-list')?.textContent,
          posterCards: document.querySelectorAll('.related-list .related-card img').length,
          relationLabels: [...document.querySelectorAll('.related-relation')]
            .map((label) => label.textContent),
          groupHeadings: [...document.querySelectorAll('.related-group-heading')]
            .map((heading) => heading.textContent),
          relationBelowPoster: cards.every((card) => {
            const poster = card.querySelector('.related-art')?.getBoundingClientRect();
            const relation = card.querySelector('.related-relation')?.getBoundingClientRect();
            return poster && relation && relation.top >= poster.bottom - 1;
          }),
          firstRowCount: cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2).length,
          titleAlignment: cards.filter((card) =>
            Math.abs(card.getBoundingClientRect().top - firstTop) < 2).every((card, _, row) => {
              const title = card.querySelector('strong').getBoundingClientRect();
              const first = row[0].querySelector('strong').getBoundingClientRect();
              return Math.abs(title.top - first.top) < 2 &&
                Math.abs(title.height - first.height) < 2;
            }),
          right: document.querySelector('.related-list')?.getBoundingClientRect().right,
          next: document.querySelector('.related-trigger')?.textContent,
          moreVisible: !document.querySelector('.related-trigger')?.hidden}; })()`,
    });
    if (process.env.NEGEV_UI_CAPTURE_DIR && width === 1200) {
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true,
        captureBeyondViewport: true });
      await writeFile(join(process.env.NEGEV_UI_CAPTURE_DIR, 'related-desktop.png'),
        Buffer.from(shot.data, 'base64'));
    }
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/42') });
    await wait(700);
    const seriesRelated = await send('Runtime.evaluate', { returnByValue: true,
      expression: "[...document.querySelectorAll('#detail .related-presence')].map(node => node.textContent)" });
    const seasonPopup = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const dialog = document.querySelector('.season-request-dialog');
        const trigger = document.querySelector('.season-request-trigger');
        const before = {button: trigger?.textContent, closed: !dialog?.open};
        trigger?.click();
        const box = dialog?.getBoundingClientRect();
        return {...before, opened: dialog?.open,
          centered: Math.abs((box?.left + box?.right) / 2 - innerWidth / 2) < 8,
          heading: dialog?.querySelector('h2')?.textContent,
          close: dialog?.querySelector('.season-request-close')?.textContent}; })()`,
    });
    if (process.env.NEGEV_UI_CAPTURE_DIR && width === 1200) {
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(join(process.env.NEGEV_UI_CAPTURE_DIR, 'season-popup-desktop.png'),
        Buffer.from(shot.data, 'base64'));
    }
    const requestOwnedSelection = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const rows = [...document.querySelectorAll('.season-request-row')];
        return rows.map(row => ({id: Number(row.dataset.anidbId),
          status: row.querySelector('.season-request-status')?.textContent,
          disabled: row.querySelector('input')?.disabled})); })()`,
    });
    await send('Runtime.evaluate', { expression: `(() => {
      for (const id of [43,45]) document.querySelector(
        '.season-request-row[data-anidb-id="' + id + '"] input').click();
    })()` });
    const requestSelection = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return {route: location.hash, button: [...action.querySelectorAll('.primary')].find(button=>button.getClientRects().length)?.textContent,
          chosen: [...action.querySelectorAll('.season-request-row input:checked')]
            .map(input => Number(input.closest('.season-request-row').dataset.anidbId))}; })()`,
    });
    const requestReview = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        const button = [...(action?.querySelectorAll('.primary')??[])].find(button=>button.getClientRects().length); button?.click();
        return {button: button?.textContent,
          reviewVisible: !action?.querySelector('.request-review')?.hidden,
          summary: action?.querySelector('.request-review p')?.textContent}; })()`,
    });
    const requestCancelled = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        action.querySelector('.request-review button').click();
        return {reviewHidden: action.querySelector('.request-review').hidden,
          button: [...action.querySelectorAll('.primary')].find(button=>button.getClientRects().length).textContent,
          status: action.querySelector('.request-feedback').textContent}; })()`,
    });
    const requestSelectionReady = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return {button: [...action.querySelectorAll('.primary')].find(button=>button.getClientRects().length)?.textContent,
          disabled: [...action.querySelectorAll('.primary')].find(button=>button.getClientRects().length)?.disabled}; })()`,
    });
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.request-action .primary')].find(button=>button.getClientRects().length).click()` });
    const reviewAfterSelection = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return {reviewVisible: !action.querySelector('.request-review')?.hidden,
          button: [...action.querySelectorAll('.primary')].find(button=>button.getClientRects().length)?.textContent,
          status: action.querySelector('.request-feedback')?.textContent}; })()`,
    });
    await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.request-action .primary')].find(button=>button.getClientRects().length).click()` });
    await wait(250);
    const requestSaved = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return {reviewHidden: action.querySelector('.request-review')?.hidden,
          receipt: action.querySelector('.request-feedback')?.textContent}; })()`,
    });
    const popupClosed = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const dialog = document.querySelector('.season-request-dialog');
        dialog.querySelector('.season-request-close').click();
        return {closed: !dialog.open, trigger: document.querySelector('.season-request-trigger')?.textContent}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/47') });
    await wait(700);
    const failedSeasonLookup = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => {
        const trigger = document.querySelector('.season-request-trigger');
        const before = { enabled: !trigger?.disabled, label: trigger?.textContent };
        trigger?.click();
        const dialog = document.querySelector('.season-request-dialog');
        return { ...before, open: dialog?.open,
          retry: dialog?.querySelector('.season-lookup-retry')?.textContent,
          notice: dialog?.querySelector('.season-lookup-notice')?.textContent };
      })()`,
    });
    await send('Runtime.evaluate', { expression: `document.querySelector('.season-lookup-retry')?.click()` });
    await wait(350);
    const recoveredSeasonLookup = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => ({ open: document.querySelector('.season-request-dialog')?.open,
        related: [...document.querySelectorAll('.season-request-row')].some(
          row => row.dataset.anidbId === '48'),
        triggerEnabled: !document.querySelector('.season-request-trigger')?.disabled,
        notice: document.querySelector('.season-lookup-notice')?.textContent }))()`,
    });
    const failedSeasonDetail = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const row = document.querySelector(
          '.season-request-row[data-anidb-id="48"]');
        return { status: row?.querySelector('.season-request-status')?.textContent,
          disabled: row?.querySelector('input')?.disabled,
          triggerEnabled: !document.querySelector('.season-request-trigger')?.disabled }; })()`,
    });
    await send('Runtime.evaluate', { expression: `(() => {
      document.querySelector('.season-request-close')?.click();
      document.querySelector('.season-request-trigger')?.click();
    })()` });
    await wait(350);
    const recoveredSeasonDetail = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const row = document.querySelector(
          '.season-request-row[data-anidb-id="48"]');
        return { open: document.querySelector('.season-request-dialog')?.open,
          status: row?.querySelector('.season-request-status')?.textContent,
          disabled: row?.querySelector('input')?.disabled }; })()`,
    });
    await send('Runtime.evaluate', { expression: `document.querySelector('#adult-toggle').click()` });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/46') });
    await wait(1_500);
    const closedPilotTitle = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => ({notice: document.querySelector('.request-preview-gate')?.textContent,
        disabled: document.querySelector('.season-request-trigger')?.disabled,
        visible: document.querySelector('#detail')?.textContent.slice(0, 200)}))()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/19848') });
    await wait(700);
    const coldBeforeFallback = await send('Runtime.evaluate', { returnByValue: true,
      expression: `({loading: document.querySelector('#detail')?.textContent.includes('Loading episode details'),
        hasRequest: Boolean(document.querySelector('#detail .request-action'))})`,
    });
    await wait(4_200);
    const coldRequestReview = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        const button = [...(action?.querySelectorAll('.primary')??[])].find(button=>button.getClientRects().length); button?.click();
        return {button: button?.textContent,
          reviewVisible: !action?.querySelector('.request-review')?.hidden,
          summary: action?.querySelector('.request-review p')?.textContent}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/19849') });
    await wait(700);
    await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        [...(action?.querySelectorAll('.primary')??[])].find(button=>button.getClientRects().length)?.click();
        [...document.querySelectorAll('#detail button')]
          .find((button) => button.textContent === 'Retry loading details')?.click();
        return true; })()`,
    });
    await wait(700);
    const reviewAfterRetry = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return {button: [...(action?.querySelectorAll('.primary')??[])].find(button=>button.getClientRects().length)?.textContent,
          reviewVisible: !action?.querySelector('.request-review')?.hidden}; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/20291') });
    await wait(700);
    const unlistedFilm = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('#detail .request-action');
        const message = document.querySelector('#detail')?.textContent;
        const button = [...(action?.querySelectorAll('.primary')??[])].find(button=>button.getClientRects().length);
        const label = button?.textContent;
        button?.click();
        return { message, action: label,
          summary: action?.querySelector('.request-review p')?.textContent }; })()`,
    });
    const unlistedFilmConfirm = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('#detail .request-action');
        [...(action?.querySelectorAll('.primary')??[])].find(button=>button.getClientRects().length)?.click();
        return { saving: [...(action?.querySelectorAll('.primary')??[])].find(button=>button.getClientRects().length)?.textContent }; })()`,
    });
    await wait(300); await settled();
    const unlistedFilmSaved = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('#detail .request-action');
        return { button: [...(action?.querySelectorAll('.primary')??[])].find(button=>button.getClientRects().length)?.textContent,
          feedback: action?.querySelector('.request-feedback')?.textContent,
          reviewHidden: action?.querySelector('.request-review')?.hidden }; })()`,
    });
    await send('Page.navigate', { url: url.replace('#/discover', '#/title/10') });
    await wait(700);
    const filmChoiceReview = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        const button = [...action.querySelectorAll('.primary')].find(button=>button.getClientRects().length);
        button.click();
        const select = action.querySelector('.film-request-choice select');
        select.value = '1001'; select.dispatchEvent(new Event('change'));
        button.click();
        select.value = '1002'; select.dispatchEvent(new Event('change'));
        return { reviewHidden: action.querySelector('.request-review').hidden,
          button: button.textContent,
          summary: action.querySelector('.request-review p').textContent }; })()`,
    });
    await send('Runtime.evaluate', { expression:
      `[...document.querySelectorAll('.request-action .primary')].find(button=>button.getClientRects().length).click()` });
    const filmChoiceConfirm = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return { reviewHidden: action.querySelector('.request-review').hidden,
          summary: action.querySelector('.request-review p').textContent,
          button: [...action.querySelectorAll('.primary')].find(button=>button.getClientRects().length).textContent }; })()`,
    });
    await send('Runtime.evaluate', { expression:
      `[...document.querySelectorAll('.request-action .primary')].find(button=>button.getClientRects().length).click()` });
    await wait(250);
    const filmChoiceSaved = await send('Runtime.evaluate', { returnByValue: true,
      expression: `(() => { const action = document.querySelector('.request-action');
        return { reviewHidden: action.querySelector('.request-review').hidden,
          feedback: action.querySelector('.request-feedback').textContent,
          view: action.querySelector('.request-receipt-link')?.textContent }; })()`,
    });
    let airingTrack = null;
    if (width === 390) {
      await send('Page.navigate', { url: url.replace('#/discover', '#/airing') });
      await wait(800); await settled();
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
      await wait(800); await settled();
      const allWeeklyPresence = await send('Runtime.evaluate', { returnByValue: true,
        expression: `(() => [...document.querySelectorAll('#airing-list .result')]
          .map((card) => ({title: card.querySelector('strong')?.textContent,
            badge: card.querySelector('.presence')?.textContent})))()`,
      });
      await send('Page.navigate', { url: url.replace('#/discover', '#/title/19847') });
      await wait(800); await settled();
      await send('Runtime.evaluate', { expression:
        `document.querySelector('#detail .detail-action-row [data-track-id]')?.click()` });
      await wait(300); await settled();
      const tracked = await send('Runtime.evaluate', { returnByValue: true,
        expression: `document.querySelector('#detail .detail-action-row [data-track-id]')?.textContent`,
      });
      await send('Page.navigate', { url: url.replace('#/discover', '#/airing') });
      await wait(800); await settled();
      await send('Runtime.evaluate', { expression: `(() => {
        const mode = document.querySelector('#airing-view-mode');
        mode.value = 'custom'; mode.dispatchEvent(new Event('change'));
      })()` });
      await wait(800); await settled();
      const custom = await send('Runtime.evaluate', { returnByValue: true,
        expression: `({mode: document.querySelector('#airing-view-mode')?.value,
          card: [...document.querySelectorAll('.tracked-title .poster-card')]
            .map((card) => card.textContent)
            .find((text) => text.includes('FX Senshi Kurumi-chan')),
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
      await wait(300); await settled();
    }
    const synopsis = [];
    for (const id of [8,9]) {
      await send('Page.navigate', {url:url.replace('#/discover','#/title/'+id)});
      for(let attempt=0;attempt<40;attempt++) {
        const ready=await send('Runtime.evaluate',{returnByValue:true,
          expression:"Boolean(document.querySelector('#detail .detail-main'))"});
        if(ready.result.value)break;
        await wait(100);
      }
      const entry=await send('Runtime.evaluate',{returnByValue:true,
        expression:`({text:document.querySelector('#detail .detail-description')?.textContent,
          expand:Boolean(document.querySelector('#detail .detail-description-toggle'))})`});
      synopsis.push(entry.result.value);
    }
    return { ...result.value, typography, dropdowns:dropdowns.result.value,airingDropdown:airingDropdown.result.value,longSynopsis:longSynopsis.result.value,
      toggleGeometry:toggleGeometry.result.value,synopsis,
      libraryReturn: {first: libraryBrowseFirst.result.value, after: libraryBrowseReturned.result.value},
      browseScroll: { first: browseFirst.result.value,
        ahead: browseAhead.result.value, aheadLoaded: browseAheadLoaded.result.value,
        after: browseScrolled.result.value, returned: browseReturned.result.value, sorted: browseSorted.result.value,
        retry: browseRetry.result.value, recovered: browseRecovered.result.value },
      airingScroll: { first: airingFirst.result.value,
        after: airingScrolled.result.value,
        retry: airingRetry.result.value, recovered: airingRecovered.result.value },
      tagBrowse: tagBrowse.result.value,
      menu: menu.result.value,
      adultChoice: adultChoice.result.value, searchAdult: searchAdult.result.value,
      searchTrack: searchTrack.result.value, titleTrack: titleTrack.result.value,
      searchAdultLabels: searchAdultLabels.result.value,
      filtered: filtered.result.value,
      liveToggle: liveToggle.result.value,
      chineseChoice: chineseChoice.result.value,
      franchise: { before: franchiseBefore.result.value,
        ...franchiseAfter.result.value },
      seasonPopup: seasonPopup.result.value,
      seriesRelated: seriesRelated.result.value,
      requestReview: requestReview.result.value,
      requestOwnedSelection: requestOwnedSelection.result.value,
      requestSelection: requestSelection.result.value,
      requestSelectionReady: requestSelectionReady.result.value,
      reviewAfterSelection: reviewAfterSelection.result.value,
      requestCancelled: requestCancelled.result.value,
      requestSaved: requestSaved.result.value,
      popupClosed: popupClosed.result.value,
      failedSeasonLookup: failedSeasonLookup.result.value,
      recoveredSeasonLookup: recoveredSeasonLookup.result.value,
      failedSeasonDetail: failedSeasonDetail.result.value,
      recoveredSeasonDetail: recoveredSeasonDetail.result.value,
      closedPilotTitle: closedPilotTitle.result.value,
      coldBeforeFallback: coldBeforeFallback.result.value,
      coldRequestReview: coldRequestReview.result.value,
      reviewAfterRetry: reviewAfterRetry.result.value,
      unlistedFilm: unlistedFilm.result.value,
      unlistedFilmConfirm: unlistedFilmConfirm.result.value,
      unlistedFilmSaved: unlistedFilmSaved.result.value,
      filmChoiceReview: filmChoiceReview.result.value,
      filmChoiceConfirm: filmChoiceConfirm.result.value,
      filmChoiceSaved: filmChoiceSaved.result.value, airingTrack };
  } finally {
    socket?.close();
    child.kill();
    await closed;
  }
}

test('signed-in consumer routes render real shell with search, library and requests',
  { skip: browser ? false : browserSkipReason }, async () => {
    const submittedRequests = [];
    let allowAdult = true;
    let airingPreference = { mode: 'library', trackedAnidbIds: [] };
    let coldSeasonReads = 0;
    let completedColdSeasonReads = 0;
    let failedRelatedReads = 0;
    let failedRelatedDetailReads = 0;
    let failedDiscoverContinuation = false;
    let failedAiringContinuation = false;
    let posterGets = 0, posterHeadReads = 0;
    const posterRequests = [];
    let catalogueReads = 0;
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      response.setHeader('Content-Security-Policy',
        `default-src 'none'; script-src 'self'${new URL(request.url, 'http://localhost')
          .searchParams.has('english') ? " 'unsafe-inline'" : ''}; ` +
        "style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'");
      if (path === '/api/catalogue/posters/anidb/4158') {
        posterRequests.push(request.method);
        response.setHeader('Cache-Control','no-store');
        if (request.method === 'HEAD') posterHeadReads++;
        else posterGets++;
        if (request.method === 'HEAD' || posterGets === 1) {
          response.writeHead(503,{'Retry-After':'1'});response.end();
        } else {
          response.setHeader('Cache-Control','private, max-age=3600');
          // A tiny image fixture proves native load/error events, not AniDB validation.
          response.setHeader('Content-Type','image/svg+xml');
          response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>');
        }
        return;
      }
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
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          submittedRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'pending', requestId: 7,
            waitingFor: 'release_schedule' }));
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ items: [{
          id: 1, requesterId: 1, requesterName: 'Owner', anidbId: 4158, title: 'Pale Cocoon',
          englishTitle: 'The Pale Cocoon', kind: 'movie', status: 'held',
          episodeIds: [10], monitorFuture: false, watchClosed: false, canCancel: true,
          progress: { state: 'saved', targetCount: 1,
            publicAvailability: 'unverified', publicVerifiedTargets: 0 },
        }, {
          id: 2, requesterId: 1, requesterName: 'Owner', anidbId: 9589, title: 'The Garden of Words', kind: 'movie',
          episodeIds: [11], monitorFuture: false, watchClosed: false,
          progress: { state: 'saved', targetCount: 1,
            publicAvailability: 'verified_recently', publicVerifiedTargets: 1 },
        }, {
          id: 3, requesterId: 1, requesterName: 'Owner', anidbId: 7, title: 'A title needing help', kind: 'series',
          episodeIds: [12], monitorFuture: true, watchClosed: false, canCancel: false,
          status: 'held',
          nextAir: { nextAirDate: '2026-11-29', nextEpisodeNumber: 2 },
          progress: { state: 'review_needed', targetCount: 1,
            publicAvailability: 'unverified', publicVerifiedTargets: 0 },
        }, {
          id: 4, requesterId: 1, requesterName: 'Owner', anidbId: 8,
          title: 'A cancelled request', kind: 'movie', status: 'cancelled',
          episodeIds: [13], monitorFuture: false, watchClosed: false,
          canCancel: false,
          progress: { state: 'saved', targetCount: 1,
            publicAvailability: 'unverified', publicVerifiedTargets: 0 },
        }], nextBeforeId: null }));
        return;
      }
      if (path === '/api/requests/seasons' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        submittedRequests.push(...body.seasons.map((entry) =>
          ({ ...entry, scope: 'installment' })));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ items: body.seasons.map((entry, index) => ({
          anidbId: entry.anidbId, status: 202,
          result: { state: 'held', requestId: 70 + index },
        })) }));
        return;
      }
      if (path === '/api/request-preparations') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ items: [{ id: 12, anidbId: 19847,
          title: 'FX Senshi Kurumi-chan', englishTitle: 'FX Magical Girl Kurumi',
          state: 'pending',
          reason: 'release_state_unknown', createdMs: 1_000,
          requesterName: 'Owner' }], nextBeforeId: 12 }));
        return;
      }
      if (path === '/api/catalogue/search') {
        const query = new URL(request.url, 'http://localhost').searchParams.get('q');
        if (query === 'Garden') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'results', page: 1, total: 2,
            catalogueSource: 'test', items: [
              ...(!allowAdult ? [{ anidbId: 9589 }] : [{ anidbId: 9589, title: 'The Garden of Words', adult: false,
                libraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 },
                verifiedLibraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 } }]),
              { anidbId: 4158, title: 'Pale Cocoon', adult: false,
                libraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 },
                verifiedLibraryPresence: { state: 'unknown', verifiedEpisodeCount: 0 } }] }));
          return;
        }
        if (query === 'Lovely') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'results', page: 1, total: 3,
            catalogueSource: 'test', items: [
              { anidbId: 14974, title: 'Lovely' },
              { anidbId: 11003, title: 'Lovely x Cation' },
              { anidbId: 2498 }] }));
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
          title: 'Verified title', restricted: anidbId !== 2498,
          chineseProduction: anidbId === 2498 }));
        return;
      }
      if (path === '/api/catalogue/9589/display') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display', anidbId: 9589,
          title: 'The Garden of Words', restricted: false, chineseProduction: false,
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 },
          verifiedLibraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 } }));
        return;
      }
      if (path === '/api/library' && request.headers.referer?.includes('libraryPages=1')) {
        const after = new URL(request.url, 'http://localhost').searchParams.get('afterAnidbId');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({state: 'current_proofs',
          items: Array.from({length: after ? 1 : 18}, (_, index) => ({
            anidbId: 50_000 + (after ? 18 : index),
            title: `Library title ${after ? 19 : index + 1}`,
            verifiedEpisodeCount: 1, lastVerifiedMs: 1_000,
          })), nextAfterAnidbId: after ? null : 50_017}));
        return;
      }
      if (path === '/api/library') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'current_proofs', items: [{
          anidbId: 9589, title: 'The Garden of Words', englishTitle: 'Garden of Words',
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
        if (request.method === 'PATCH') {
          let body = '';
          for await (const chunk of request) body += chunk;
          const intent=JSON.parse(body);
          if(intent.action==='mode')airingPreference={...airingPreference,mode:intent.mode};
          else if(intent.action==='track')airingPreference={...airingPreference,trackedAnidbIds:[...new Set([...airingPreference.trackedAnidbIds,intent.anidbId])]};
          else if(intent.action==='untrack')airingPreference={...airingPreference,trackedAnidbIds:airingPreference.trackedAnidbIds.filter(id=>id!==intent.anidbId)};
          else throw Error('Unexpected preference intent');
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(airingPreference));
        return;
      }
      if (path === '/api/seasons') {
        catalogueReads++;
        const params = new URL(request.url, 'http://localhost').searchParams;
        if (params.get('year') === '2024') {
          const after = Number(params.get('after') ?? 0);
          const ongoing = params.get('status') === 'ongoing';
          if (after && !(ongoing ? failedAiringContinuation : failedDiscoverContinuation)) {
            if (ongoing) failedAiringContinuation = true;
            else failedDiscoverContinuation = true;
            response.statusCode = 503;
            response.end(JSON.stringify({ error: 'Temporary page failure' }));
            return;
          }
          const total = ongoing ? 13 : 19;
          const limit = ongoing ? 12 : 18;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'ready', year: 2024,
            season: 'ALL', sourceDate: '2026-11-05', availableTags: [], total,
            items: Array.from({ length: Math.min(limit, total - after) }, (_, index) => ({
              anidbId: (ongoing ? 30_000 : 40_000) + after + index,
              title: `${ongoing ? 'Airing' : 'Discover'} retry ${after + index + 1}`,
              type: 'TV', adult: false,
              libraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 } })),
            nextAfter: after + limit < total ? after + limit : null }));
          return;
        }
        if (params.get('year') === '2025' && params.get('status') === 'ongoing') {
          const after = Number(params.get('after') ?? 0);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'ready', year: 2025,
            season: 'ALL', sourceDate: '2026-11-05', availableTags: [], total: 15,
            items: Array.from({ length: Math.min(12, 15 - after) }, (_, index) => ({
              anidbId: 20_000 + after + index,
              title: `Ongoing title ${after + index + 1}`,
              type: 'TV', adult: false,
              libraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 } })),
            nextAfter: after + 12 < 15 ? after + 12 : null }));
          return;
        }
        if (params.get('year') === '2025') {
          const after = Number(params.get('after') ?? 0);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ state: 'ready', year: 2025,
            season: 'ALL', sourceDate: '2026-11-05', availableTags: [], total: 25,
            items: Array.from({ length: Math.min(18, 25 - after) }, (_, index) => ({
              anidbId: 10_000 + after + index,
              title: params.get('sort') === 'title_asc'
                ? `Sorted title ${after + index + 1}` : `Title ${after + index + 1}`,
              type: 'OVA', adult: false })),
            nextAfter: after + 18 < 25 ? after + 18 : null }));
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
            rating: { score: 8.2, votes: 2100, members: 9000,
              checkedMs: 1_000 },
            adult: false, chineseProduction: true,
            libraryPresence: { state: 'unknown',
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
          { anidbId: 9603,
            title: 'Another installment with a very long title that must keep the poster row aligned',
            relation: 'Alternative' }] }));
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
      if (path === '/api/catalogue/9589') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 9589,
          title: 'The Garden of Words', kind: 'movie', restricted: false,
          page: 1, total: 1, nextPage: null,
          episodes: [{ id: 958901, number: 1, type: 'Episode',
            title: 'Film', availability: 'available' }] }));
        return;
      }
      if (path === '/api/catalogue/20291') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 20291,
          title: 'Unlisted future film', kind: 'movie', restricted: false,
          page: 1, total: 0, nextPage: null, episodes: [] }));
        return;
      }
      if (path === '/api/catalogue/10') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 10,
          title: 'Two-part film', kind: 'movie', restricted: false,
          page: 1, total: 2, nextPage: null, episodes: [
            { id: 1001, number: 1, type: 'Episode', title: 'Part One' },
            { id: 1002, number: 2, type: 'Episode', title: 'Part Two' },
          ] }));
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
      if (path === '/api/catalogue/8' || path === '/api/catalogue/9') {
        const movie = path.endsWith('/8');
        const anidbId = movie ? 8 : 9;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId,
          title: movie ? 'Film extras only' : 'Series Special only',
          kind: movie ? 'movie' : 'series', restricted: false,
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 1 },
          page: 1, total: 2, nextPage: 2,
          episodes: [{ id: anidbId * 100 + 1, number: 1,
            type: 'Special', title: 'Extra', availability: 'available' }] }));
        return;
      }
      if (path === '/api/catalogue/8/display' ||
          path === '/api/catalogue/9/display') {
        const movie = path.includes('/8/');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display',
          anidbId: movie ? 8 : 9,
          title: movie ? 'Film extras only' : 'Series Special only',
          restricted: false, description: movie ? null : "   " }));
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
      if (path === '/api/catalogue/46') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 46,
          title: 'Closed pilot title', kind: 'series', restricted: false,
          requestsOpen: false, regularSeason: { verified: 0, total: 11 },
          page: 1, total: 11, nextPage: null, episodes: Array.from({ length: 11 },
            (_, index) => ({ id: 4600 + index, number: index + 1,
              type: 'Episode', title: `Episode ${index + 1}`,
              availability: 'unknown' })) }));
        return;
      }
      if (path === '/api/catalogue/46/related') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'related_titles', anidbId: 46,
          completeness: 'unproven', items: [] }));
        return;
      }
      if (path === '/api/catalogue/42/related') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'related_titles', anidbId: 42,
          completeness: 'unproven', items: [{ anidbId: 43,
            title: 'Example Season Two', relation: 'Sequel' },
          { anidbId: 44, title: 'Complete related season',
            relation: 'Sequel' },
          { anidbId: 45, title: 'Partly available season',
            relation: 'Sequel' }] }));
        return;
      }
      if (path === '/api/catalogue/47/related') {
        failedRelatedReads++;
        response.setHeader('Content-Type', 'application/json');
        if (failedRelatedReads === 1) {
          response.writeHead(429);
          response.end(JSON.stringify({ error: 'Rate limited' }));
        } else response.end(JSON.stringify({ state: 'related_titles',
          anidbId: 47, completeness: 'unproven', items: [{ anidbId: 48,
            title: 'Related season after retry', relation: 'Sequel' }] }));
        return;
      }
      if (path === '/api/catalogue/48/related') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'related_titles', anidbId: 48,
          completeness: 'unproven', items: [] }));
        return;
      }
      if (path === '/api/catalogue/47' || path === '/api/catalogue/48') {
        const id = Number(path.split('/')[3]);
        response.setHeader('Content-Type', 'application/json');
        if (id === 48 && ++failedRelatedDetailReads === 1) {
          response.writeHead(503);
          response.end(JSON.stringify({ error: 'Temporarily unavailable' }));
          return;
        }
        response.end(JSON.stringify({ state: 'details', anidbId: id,
          title: id === 47 ? 'Already complete season' : 'Related season after retry',
          kind: 'series', restricted: false, monitorFuture: false,
          regularSeason: { verified: id === 47 ? 1 : 0, total: 1 },
          page: 1, total: 1, nextPage: null,
          episodes: [{ id: id * 100 + 1, number: 1, type: 'Episode',
            title: 'First', availability: id === 47 ? 'available' : 'unknown' }] }));
        return;
      }
      if (path === '/api/catalogue/44') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 44,
          title: 'Complete related season', kind: 'series', restricted: false,
          monitorFuture: false, regularSeason: { verified: 2, total: 2 },
          page: 1, total: 2, nextPage: null,
          episodes: [1, 2].map((number) => ({ id: 4400 + number,
            number, type: 'Episode', availability: 'available' })) }));
        return;
      }
      if (path === '/api/catalogue/43') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 43,
          title: 'Example Season Two', kind: 'series', restricted: false,
          monitorFuture: false, regularSeason: { verified: 0, total: 2 },
          page: 1, total: 2, nextPage: null,
          episodes: [1, 2].map((number) => ({ id: 4300 + number,
            number, type: 'Episode', availability: 'unknown' })) }));
        return;
      }
      if (path === '/api/catalogue/45') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 45,
          title: 'Partly available season', kind: 'series', restricted: false,
          monitorFuture: false, regularSeason: { verified: 1, total: 2 },
          page: 1, total: 2, nextPage: null,
          episodes: [1, 2].map((number) => ({ id: 4500 + number,
            number, type: 'Episode', availability: number === 1 ? 'available' : 'unknown' })) }));
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
      if (/^\/api\/catalogue\/9900[12](?:\/display)?$/.test(path)) {
        const display = path.endsWith('/display');
        const id = Number(path.split('/')[3]);
        const slow = display === (id === 99001);
        setTimeout(() => {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(display ? {
            state: 'display', title: 'Finished long series', type: 'TV Series',
            releaseStatus: 'Finished', restricted: false, tags: [],
          } : {
            state: 'details', anidbId: id, title: 'Finished long series',
            kind: 'series', restricted: false, releaseState: 'airing',
            monitorFuture: true, episodeCount: 220, page: 1, total: 225,
            nextPage: 2, episodes: [{ id: id * 100, number: 1,
              type: 'Episode', title: 'First', availability: 'unknown' }],
          }));
        }, slow ? 300 : 0);
        return;
      }
      if (path === '/api/catalogue/94') {
        completedColdSeasonReads++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 94,
          title: 'Cold complete season', kind: 'series', restricted: false,
          monitorFuture: false, episodeCount: 2,
          ...(completedColdSeasonReads > 1 ?
            { regularSeason: { verified: 2, total: 2 } } : {}),
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 2 },
          page: 1, total: 3, nextPage: 2,
          episodes: [1, 2].map((number) => ({ id: 9400 + number,
            number, type: 'Episode', title: `Episode ${number}`,
            availability: 'available' })) }));
        return;
      }
      if (path === '/api/catalogue/94/display') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display', anidbId: 94,
          title: 'Cold complete season', type: 'TV Series',
          endDate: '2020-01-01', episodeCount: 2, restricted: false,
          tags: [] }));
        return;
      }
      if (path === '/api/catalogue/99999/display') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'display', anidbId: 99999,
          title: 'Chainsaw Man the Movie: Reze Arc',
          englishTitle: 'Chainsaw Man the Movie: Reze Arc',
          type: 'Movie', restricted: false, tags: [] }));
        return;
      }
      if (path === '/api/catalogue/99999') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 99999,
          title: 'Chainsaw Man the Movie: Reze Arc',
          originalTitle: 'Chainsaw Man: Reze-hen', kind: 'movie',
          restricted: false, page: 1, total: 1, nextPage: null,
          episodes: [{ id: 9999901, number: 1, type: 'Episode',
            title: 'Movie', availability: 'unknown' }] }));
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
          regularSeason: { verified: missingLast ? 3 : 4, total: 4 },
          libraryPresence: { state: 'in_library', verifiedEpisodeCount: 4 },
          page: secondPage ? 2 : 1, total: 4, nextPage: secondPage ? null : 2,
          episodes: (secondPage ? [3, 4] : [1, 2]).map((number) => ({
            id: (missingLast ? 9800 : 9900) + number, number, type: 'Episode',
            title: `Episode ${number}`,
            availability: missingLast && number === 4 ? 'unknown' : 'available',
          })) }));
        return;
      }
      if (path === '/api/catalogue/19742') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ state: 'details', anidbId: 19742,
          title: 'Scheduled Precure', kind: 'series', restricted: false,
          activeWatchRequestId: null, futureEpisodesMonitored: true,
          releaseState: 'airing',
          monitorFuture: true, episodeCount: 44, scheduleAsOf: '2026-11-13',
          regularSeason: { verified: 40, total: 44 },
          regularSchedule: { aired: 40, upcoming: 4, undated: 0,
            verifiedAired: 40, total: 44, asOf: '2026-11-13',
            nextAirDate: '2026-11-20', nextEpisodeNumber: 41 },
          page: 1, total: 44, nextPage: null,
          episodes: Array.from({ length: 44 }, (_, index) => ({
            id: 1974200 + index, number: index + 1, type: 'Episode',
            title: `Episode ${index + 1}`,
            airDate: index < 40 ? '2026-11-12' : '2026-11-20',
            availability: index < 40 ? 'available' : 'unknown',
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
          title: 'Pale Cocoon', englishTitle: null, type: 'OVA', restricted: false,
          startYear: 2005, startDate: '2005-12-10', endDate: '2005-12-10',
          episodeCount: 1, description: 'A quiet archive and a lost world. '.repeat(30),
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
        const body = await readFile(new URL(asset[0], staticRoot));
        response.end(path === '/' && new URL(request.url, 'http://localhost')
          .searchParams.has('english')
          ? body.toString().replace('</head>',
            '<script>localStorage.setItem("negev:english-titles:1", "on")</script></head>')
          : body);
      } catch { response.writeHead(500); response.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(join(tmpdir(), 'negev-browser-consumer-'));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const discover = await inspectMobile(`${base}/#/discover?q=Pale`, join(dir, 'discover'),1440,true);
      assert.match(discover, /Pale Cocoon/);
      assert.equal(catalogueReads,0,'text search does not load the hidden catalogue grid');
      console.log('Native poster recovery request sequence:',JSON.stringify(posterRequests));
      const probeIndex=posterRequests.indexOf('HEAD');
      assert.ok(probeIndex>0 && posterRequests[0]==='GET',
        'a native image failure is followed by the status probe');
      assert.ok(posterRequests.slice(probeIndex+1).includes('GET'),
        'a native image GET follows the cooldown probe');
      assert.ok(posterGets>=2);
      assert.equal(posterHeadReads,1,'one HEAD probe reads the cooldown');
      assert.match(discover, /<span[^>]*class="[^"]*\bhas-poster\b[^"]*"[^>]*>[^<]*<img[^>]*src="\/api\/catalogue\/posters\/anidb\/4158"/,
        'the exact poster must remain present and fire its native load handler');
      assert.doesNotMatch(discover, /<img[^>]*src="\/api\/catalogue\/posters\/anidb\/4158"[^>]*missing-art/);
      assert.doesNotMatch(discover, /Availability not checked/);
      assert.match(discover, /id="view-discover" class="page-view"/);
      const completedColdSeason = await dump(`${base}/#/title/94`,
        join(dir, 'completed-cold-season'), undefined, '1440,900', 15000);
      assert.ok(completedColdSeasonReads >= 2,
        'the complete season proof arrives after the initial detail response');
      assert.match(completedColdSeason,
        /2 of 2 regular episodes verified playable in Plex/);
      assert.match(completedColdSeason,
        /Available · 2\/2/);
      for (const id of [99001, 99002]) {
        const finished = await dump(`${base}/#/title/${id}`,
          join(dir, `finished-${id}`));
        assert.match(finished, /Finished long series/);
        assert.match(finished, /TV Series · finished/);
        assert.match(finished, /225 listed AniDB entries/,
          'the incomplete detail roster must also have rendered');
        assert.doesNotMatch(finished, /Next air date unknown/,
          'finished catalogue status suppresses next-air text in either response order');
      }
      const browse = await dump(`${base}/#/discover`, join(dir, 'browse'), 'discover');
      assert.match(browse, /Pale Cocoon/);
      assert.match(browse, /★ 8.2/);
      assert.match(browse, /<h1>Discover<\/h1>/);
      assert.doesNotMatch(browse, /id="discover-shelves"/);
      assert.match(browse, /The Garden of Words/);
      const mobile = await inspectMobile(`${base}/#/discover`, join(dir, 'mobile'));
      assert.equal(mobile.width, 390);
      for(const view of [mobile]) {
        assert.deepEqual(view.dropdowns,{accountInside:true,accountOutside:true,
          genreInside:true,genreOutside:true,genreSearch:true,escape:true,airingOutside:true});
        assert.deepEqual(view.airingDropdown,{visible:true,searchInside:true,checkboxInside:true,outside:true,escape:true});
        assert.deepEqual(view.longSynopsis,{collapsed:true,expanded:true,collapsedAgain:true,label:'Read full synopsis'});
        assert.deepEqual(view.toggleGeometry.on,view.toggleGeometry.off,
          'Chinese toggle and adjacent Account position stay identical in both states');
        assert.deepEqual(view.toggleGeometry.on,view.toggleGeometry.restored);
        assert.equal(view.toggleGeometry.on.fits,true,'both toggle labels fit without clipping');
        assert.ok(view.toggleGeometry.fontChecks.every(result=>result.stable&&result.fits),JSON.stringify(view.toggleGeometry.fontChecks));
        assert.deepEqual(view.synopsis,[
          {text:'No synopsis is available for this title yet.',expand:false},
          {text:'No synopsis is available for this title yet.',expand:false}]);
      }
      assert.deepEqual(mobile.libraryReturn, {first: 18,
        after: {cards: 19, last: 'Library title 19', marker: false}},
        'clearing a Library search restores a working next-page continuation');
      assert.equal(mobile.hasContent, true);
      assert.ok(mobile.scrollWidth <= 390, 'mobile page has no horizontal overflow');
      assert.ok(mobile.accountRight <= 390, 'Account control remains visible');
      assert.ok(mobile.searchRight <= 390, 'Search remains visible');
      assert.ok(mobile.typography.heading.some(f=>f.isCustomFont&&f.familyName.startsWith('Wix Madefor Display')&&f.glyphCount>0),JSON.stringify(mobile.typography));
      assert.ok(mobile.typography.control.some(f=>f.isCustomFont&&f.familyName.startsWith('Wix Madefor Text')&&f.glyphCount>0),JSON.stringify(mobile.typography));
      assert.equal(mobile.browseScroll.first, 18);
      assert.equal(mobile.browseScroll.ahead.cards, 18);
      assert.ok(mobile.browseScroll.ahead.markerTop > mobile.browseScroll.ahead.height + 150,
        'the marker is still offscreen and beyond the old 150px loading margin');
      assert.ok(mobile.browseScroll.ahead.markerTop < mobile.browseScroll.ahead.height * 2,
        'scrolling enters the bounded one-screen loading lead');
      assert.equal(mobile.browseScroll.aheadLoaded, 25,
        'the next page renders before its marker reaches the viewport');
      assert.deepEqual(mobile.browseScroll, { first: 18,
        ahead: mobile.browseScroll.ahead, aheadLoaded: 25,
        after: { cards: 25, first: 'Title 1', retry: false },
        returned: { cards: 25, first: 'Title 1', retry: false },
        sorted: { hash: '#/discover?year=2025&season=ALL&sort=title_asc',
          cards: 18, first: 'Sorted title 1' },
        retry: { before: 18, visible: true }, recovered: 19 });
      assert.ok([12, 15].includes(mobile.airingScroll.first),
        'a short Airing page can load its continuation before scrolling');
      assert.deepEqual(mobile.airingScroll.after, { cards: 15, retry: false });
      assert.deepEqual(mobile.airingScroll.retry,
        { before: 12, visible: true });
      assert.equal(mobile.airingScroll.recovered, 13);
      assert.deepEqual(mobile.tagBrowse, { before: 40, after: 68,
        moreHidden: true, selected: true, summary: 'Genres & themes · 1' });
      assert.ok(mobile.menu.right <= 390 && mobile.menu.signoutVisible,
        'Account menu and sign-out remain usable');
      assert.deepEqual(mobile.adultChoice, { before: 'true', after: 'false', saved: 'off' });
      assert.deepEqual(mobile.searchAdult, { shown: [2498], adultsHidden: true,
        safeChineseHidden: true,
        safeTitle: 'Verified title', safePoster: '/api/catalogue/posters/anidb/2498' });
      assert.deepEqual(mobile.searchTrack, { present: false });
      assert.deepEqual(mobile.titleTrack,
        { label: 'Track this title', enabled: true, nextToRequest: true });
      assert.deepEqual(mobile.searchAdultLabels, [
        { id: 14974, label: '18+' }, { id: 11003, label: '18+' }]);
      assert.deepEqual(mobile.filtered, { adultHidden: true, normalVisible: true });
      assert.deepEqual(mobile.liveToggle, { adultVisible: true, adultHiddenAgain: true });
      assert.deepEqual(mobile.chineseChoice,
        { before: true, hidden: true, restored: true, label: 'Show Chinese productions' });
      assert.deepEqual(mobile.franchise.before,
        { button: 'Show more related titles', visible: true, count: 2, capacity: 2 });
      assert.match(mobile.franchise.listed, /The Garden of Words/);
      assert.match(mobile.franchise.listed, /Side story/);
      assert.match(mobile.franchise.listed, /1 verified item in library/);
      assert.equal(mobile.franchise.posterCards, 7);
      assert.deepEqual(mobile.franchise.relationLabels,
        ['Prequel', 'Sequel', 'Side story', 'Side story', 'Alternative',
          'Sequel · via The Garden of Words',
          'Side story · via The Garden of Words']);
      assert.deepEqual(mobile.franchise.groupHeadings, [],
        'expanded related titles stay in the same continuous grid');
      assert.equal(mobile.franchise.relationBelowPoster, true,
        'relation labels remain readable below poster artwork');
      assert.equal(mobile.franchise.titleAlignment, true);
      assert.equal(mobile.franchise.moreVisible, false,
        'More disappears after all cached relations are visible');
      assert.deepEqual(mobile.seasonPopup, { button: 'Watch future episodes', closed: true,
        opened: true, centered: true, heading: 'Request series', close: 'Close' });
      assert.deepEqual(mobile.requestReview, { button: 'Confirm request',
        reviewVisible: true,
        summary: 'Example Season Two · request episodes not verified in Plex; Partly available season · complete episodes not verified in Plex' });
      assert.deepEqual(mobile.requestOwnedSelection, [
        { id: 42, status: 'Available so far · watch future episodes', disabled: false },
        { id: 43, status: 'Availability unconfirmed · 0/2 verified', disabled: false },
        { id: 44, status: 'Available · 2/2', disabled: true },
        { id: 45, status: 'Partial · 1/2', disabled: false },
      ]);
      assert.deepEqual(mobile.requestSelection, { route: '#/title/42',
        button: 'Request 2 seasons', chosen: [43, 45] });
      assert.deepEqual(mobile.requestSelectionReady,
        { button: 'Request 2 seasons', disabled: false });
      assert.deepEqual(mobile.reviewAfterSelection, { reviewVisible: true,
        button: 'Confirm request', status: 'Review the selected seasons, then confirm.' });
      assert.deepEqual(mobile.requestCancelled, { reviewHidden: true,
        button: 'Request 2 seasons', status: '' });
      assert.equal(mobile.requestSaved.reviewHidden, true);
      assert.deepEqual(mobile.coldBeforeFallback, { loading: true, hasRequest: false });
      assert.match(mobile.requestSaved.receipt, /2 seasons requested/);
      assert.deepEqual(mobile.popupClosed, { closed: true, trigger: 'Watch future episodes' });
      assert.equal(mobile.failedSeasonLookup.enabled, true);
      assert.equal(mobile.failedSeasonLookup.label, 'Find other seasons');
      assert.equal(mobile.failedSeasonLookup.open, true);
      assert.match(mobile.failedSeasonLookup.retry ?? '', /Retry finding seasons/);
      assert.match(mobile.failedSeasonLookup.notice ?? '', /Season list incomplete.*rate limited/i);
      assert.deepEqual(mobile.recoveredSeasonLookup,
        { open: true, related: true, triggerEnabled: true, notice: '' });
      assert.deepEqual(mobile.failedSeasonDetail,
        { status: 'Episode details unavailable · retry later', disabled: true,
          triggerEnabled: true });
      assert.deepEqual(mobile.recoveredSeasonDetail,
        { open: true, status: 'Availability unconfirmed · 0/1 verified',
          disabled: false });
      assert.equal(mobile.closedPilotTitle.notice,
        'Anime requests for this title are temporarily unavailable in Negev. Please try again later.',
        JSON.stringify(mobile.closedPilotTitle));
      assert.equal(mobile.closedPilotTitle.disabled, true);
      assert.deepEqual(mobile.coldRequestReview, { button: 'Confirm request',
        reviewVisible: true,
        summary: 'Anime 19848 · Negev will identify the film or episodes and check the library first' });
      assert.equal(mobile.reviewAfterRetry.button, 'Confirm request');
      assert.equal(mobile.reviewAfterRetry.reviewVisible, true);
      assert.equal(mobile.unlistedFilm.action, 'Request film');
      assert.match(mobile.unlistedFilm.message,
        /wait for an exact film entry before any download/i);
      assert.equal(mobile.unlistedFilm.summary,
        'Unlisted future film · Negev will identify the film entry and check the library first');
      assert.equal(mobile.unlistedFilmConfirm.saving, 'Saving request…');
      assert.equal(mobile.unlistedFilmSaved.button, 'Requested');
      assert.equal(mobile.unlistedFilmSaved.reviewHidden, true);
      assert.match(mobile.unlistedFilmSaved.feedback, /saved|waiting/i);
      assert.deepEqual(mobile.filmChoiceReview, {
        reviewHidden: true, button: 'Request selected film',
        summary: 'Two-part film · main film entry 1 · Part One' });
      assert.deepEqual(mobile.filmChoiceConfirm, {
        reviewHidden: false,
        summary: 'Two-part film · main film entry 2 · Part Two',
        button: 'Confirm request' });
      assert.equal(mobile.filmChoiceSaved.reviewHidden, true);
      assert.match(mobile.filmChoiceSaved.feedback, /Request #7 saved/);
      assert.equal(mobile.filmChoiceSaved.view, 'View in My Requests →');
      assert.ok(submittedRequests.some((body) => body.anidbId === 43 &&
        body.scope === 'installment'), 'selected related season reaches the request API');
      assert.ok(submittedRequests.some((body) => body.anidbId === 45 &&
        body.scope === 'installment'), 'partial season requests its missing episodes');
      assert.ok(!submittedRequests.some((body) => body.anidbId === 44),
        'already available season cannot be submitted');
      assert.ok(submittedRequests.some((body) => body.anidbId === 10 &&
        body.scope === 'episodes' && body.episodeIds?.length === 1 &&
        body.episodeIds[0] === 1002), 'reviewed film entry reaches the request API');
      assert.equal(mobile.airingTrack.defaultMode, 'library');
      assert.equal(mobile.airingTrack.tracked, 'Stop tracking');
      assert.equal(mobile.airingTrack.mode, 'custom');
      assert.match(mobile.airingTrack.card, /FX Senshi Kurumi-chan/);
      assert.equal(mobile.airingTrack.fits, true);
      assert.deepEqual(mobile.airingTrack.weeklyPresence, [
        { title: 'FX Senshi Kurumi-chan', badge: '✓ Show has playable items' },
      ]);
      assert.deepEqual(mobile.airingTrack.allWeeklyPresence, [
        { title: 'FX Senshi Kurumi-chan', badge: '✓ Show has playable items' },
        { title: 'Psyren', badge: 'Scheduled episode' },
      ]);
      const desktopRelated = await inspectMobile(`${base}/#/discover`,
        join(dir, 'related-desktop'), 1200);
      assert.equal(desktopRelated.franchise.posterCards, 7);
      assert.match(desktopRelated.franchise.listed, /Available · 1\/1/,
        'a related film shows availability after the mounted row is observed');
      assert.ok(desktopRelated.seriesRelated.includes('Available · 2/2'),
        'a related complete season shows availability in the mounted desktop row');
      assert.ok(desktopRelated.seriesRelated.includes('Partial · 1/2'),
        'a related partial season shows availability in the mounted desktop row');
      assert.deepEqual(desktopRelated.dropdowns,mobile.dropdowns);
      assert.deepEqual(desktopRelated.airingDropdown,mobile.airingDropdown);
      assert.deepEqual(desktopRelated.longSynopsis,mobile.longSynopsis);
      assert.deepEqual(desktopRelated.toggleGeometry.on,desktopRelated.toggleGeometry.off);
      assert.equal(desktopRelated.toggleGeometry.on.fits,true);
      assert.ok(desktopRelated.toggleGeometry.fontChecks.every(result=>result.stable&&result.fits),JSON.stringify(desktopRelated.toggleGeometry.fontChecks));
      assert.deepEqual(desktopRelated.synopsis,mobile.synopsis);
      assert.equal(desktopRelated.franchise.before.count,
        desktopRelated.franchise.before.capacity,
        'initial desktop view fills its first row');
      assert.equal(desktopRelated.franchise.before.visible,
        desktopRelated.franchise.posterCards > desktopRelated.franchise.before.capacity,
        'More appears only when related titles overflow the current row');
      assert.equal(desktopRelated.franchise.firstRowCount,
        Math.min(7, desktopRelated.franchise.before.capacity));
      assert.equal(desktopRelated.franchise.titleAlignment, true);
      assert.ok(desktopRelated.franchise.right <= 1200,
        'related anime stay within the desktop page width');
      const tablet = await inspectMobile(`${base}/#/discover`, join(dir, 'tablet'), 709);
      assert.ok(tablet.accountTop < tablet.headerBottom,
        'Account control stays inside the tablet header');
      assert.equal(tablet.mobileNavVisible, true,
        'Tablet navigation stays visible after the desktop links no longer fit');
      const library = await dump(`${base}/#/library`, join(dir, 'library'), 'library');
      assert.match(library, /Negev’s Library/);
      assert.match(library, /The Garden of Words/);
      const englishLibrary = await dump(`${base}/?english=1#/library`,
        join(dir, 'english-library'));
      assert.match(englishLibrary, /<strong[^>]*>Garden of Words<\/strong>/);
      assert.match(library, /<div id="library-list" class="poster-grid"><div class="tracked-title"[^>]*><a class="poster-card"/);
      assert.match(library, /In library · coverage unconfirmed/);
      allowAdult = false;
      const librarySearch = await dump(`${base}/#/library?q=Garden`,
        join(dir, 'library-search'), 'library');
      allowAdult = true;
      assert.match(librarySearch, /Search Negev’s Library/);
      assert.match(librarySearch, /The Garden of Words/);
      assert.match(librarySearch, /class="presence unknown">In library · coverage unconfirmed/);
      assert.match(librarySearch, /Pale Cocoon/);
      assert.match(librarySearch, /Not found in Negev’s verified library/);
      assert.match(librarySearch, /id="search-all-catalogue"[^>]*href="#\/discover\?q=Garden"/);
      const catalogueSearch = await dump(`${base}/#/discover?q=Garden`,
        join(dir, 'catalogue-search'), 'discover');
      assert.match(catalogueSearch,
        /id="search-verified-library"[^>]*href="#\/library\?q=Garden"/);
      const airing = await dump(`${base}/#/airing`, join(dir, 'airing'), 'airing');
      assert.match(airing, /<h1>Airing<\/h1>/);
      assert.doesNotMatch(airing, /Ongoing this season/);
      assert.match(airing, /id="airing-sort"/);
      assert.match(airing, /id="airing-view-mode"/);
      assert.match(airing, /id="airing-kind"/);
      assert.match(airing, /FX Senshi Kurumi-chan/);
      assert.match(airing, /★ 7\.8 · 3K members/);
      assert.match(airing, /In library · coverage unconfirmed/);
      assert.doesNotMatch(airing, /Psyren/);
      const season = await dump(`${base}/#/discover?year=2026&season=FALL`,
        join(dir, 'season'), 'season');
      assert.match(season, /Pale Cocoon/);
      assert.match(season, /The Garden of Words/);
      assert.match(season, /18\+/);
      assert.match(season, /class="presence unknown">In library · coverage unconfirmed/);
      const pageOne = await dump(`${base}/#/discover?year=2025&season=ALL`,
        join(dir, 'page-one'));
      assert.equal((pageOne.match(/<button\b[^>]*class="poster-card"/g) ?? []).length,
        25, 'desktop Discover fills the short page ahead while browsing');
      assert.doesNotMatch(pageOne, /class="browse-page-marker/);
      const pageTwo = await dump(`${base}/#/discover?year=2025&season=ALL&after=18`,
        join(dir, 'page-two'));
      assert.equal((pageTwo.match(/<button\b[^>]*class="poster-card"/g) ?? []).length,
        7, 'the final Discover page contains only the remaining titles');
      const detail = await dump(`${base}/#/title/4158`, join(dir, 'detail'), 'detail');
      assert.match(detail, /Request film/);
      assert.match(detail, /Pale Cocoon/);
      assert.match(detail, /A quiet archive and a lost world/);
      assert.match(detail, /Catalogue details/);
      assert.match(detail, /class="detail-main"/,
        'title synopsis and aliases share a compact column beside the facts');
      assert.match(detail, /Back to Discover/);
      assert.doesNotMatch(detail, /Recheck unknown entries in background/);
      assert.match(detail, /Episode and Special options/);
      assert.doesNotMatch(detail, /Choose a season or installment/);
      const originalTitleDetail = await dump(`${base}/#/title/99999`,
        join(dir, 'original-title-detail'));
      assert.match(originalTitleDetail,
        /class="detail-title"[^>]*>Chainsaw Man: Reze-hen<\/h1>/,
        'English titles off keeps the AniDB main title on an opened title');
      assert.doesNotMatch(originalTitleDetail,
        /class="detail-title"[^>]*>Chainsaw Man the Movie: Reze Arc<\/h1>/);
      const seriesDetail = await dump(`${base}/#/title/42`,
        join(dir, 'series-detail'));
      assert.match(seriesDetail, /Choose seasons/);

      assert.doesNotMatch(seriesDetail, /Check season availability/);
      assert.match(seriesDetail, /Check selected episode/);
      assert.doesNotMatch(seriesDetail, /Detailed availability recheck/);
      assert.doesNotMatch(seriesDetail, /Recheck unknown entries in background/);
      assert.match(seriesDetail, /class="season-request-row"/);
      assert.match(seriesDetail, /Watch future episodes/);
      const upcomingDetail = await dump(`${base}/#/title/19742`,
        join(dir, 'upcoming-detail'));
      assert.match(upcomingDetail, /Next scheduled episode: 41 · 2026-11-20/);
      assert.match(upcomingDetail, /40 of 40 aired regular episodes verified playable in Plex/);
      assert.match(upcomingDetail, /4 upcoming episodes are scheduled; they are not missing downloads/);
      assert.match(upcomingDetail, /Episode 44 · Upcoming · scheduled 2026-11-20 · title not published yet/);
      assert.match(upcomingDetail, /Future episodes already monitored/);
      assert.match(upcomingDetail, /Find other installments/);
      assert.doesNotMatch(upcomingDetail, /Request another installment/);
      assert.match(upcomingDetail,
        /class="primary season-already-monitored"[^>]*disabled[^>]*>Future episodes already monitored<\/button>/);
      assert.match(upcomingDetail,
        /class="text-link request-receipt-link"[^>]*hidden[^>]*>View in My Requests/);
      const partialSeason = await dump(`${base}/#/title/96`,
        join(dir, 'partial-season'));
      assert.match(partialSeason, /1 of 4 regular episodes verified playable in Plex/);
      assert.doesNotMatch(partialSeason, /Check season availability/);
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
        /Available · 4\/4/);
      assert.match(completePaginated, /Show more episodes/,
        'episode details remain optional when complete-season proof is already saved');
      assert.doesNotMatch(completePaginated, /Checking the complete episode list/);
      const incompletePaginated = await dump(`${base}/#/title/98`,
        join(dir, 'incomplete-paginated'));
      assert.match(incompletePaginated, /3 of 4 regular episodes verified playable in Plex/);
      assert.match(incompletePaginated, /Partial · 3\/4/);
      const longComplete = await dump(`${base}/#/title/97`,
        join(dir, 'long-complete'));
      assert.match(longComplete,
        /Available · [0-9]+\/[0-9]+/);
      const throttledDetail = await dump(`${base}/#/title/19847`,
        join(dir, 'throttled-detail'));
      assert.match(throttledDetail, /A new anime description/);
      assert.match(throttledDetail, /Episode details are temporarily unavailable/);
      assert.match(throttledDetail, /Try again/);
      assert.match(throttledDetail, /Request series/);
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
      assert.match(alternateFilm, /Already available · 1 verified main film entry playable in Plex/);
      assert.match(alternateFilm, /Choose one film entry/);
      assert.match(alternateFilm, /Playable in Plex; episode card not linked to this episode/);
      assert.match(alternateFilm, /Request selected film entry/);
      assert.match(alternateFilm, /<button class="primary" disabled="">Already available<\/button>/);
      assert.match(alternateFilm, /Choose the film version or part/);
      const specialOnlySeries = await dump(`${base}/#/title/9`,
        join(dir, 'special-only-series'));
      assert.match(specialOnlySeries,
        /regular-season availability is not confirmed yet; Specials are separate/i);
      assert.doesNotMatch(specialOnlySeries, /1 episode verified playable/);
      const filmExtrasOnly = await dump(`${base}/#/title/8`,
        join(dir, 'film-extras-only'));
      assert.match(filmExtrasOnly,
        /a main film entry is not confirmed on this page/i);
      assert.doesNotMatch(filmExtrasOnly, /1 film entry verified playable/);
      const requests = await dump(`${base}/#/requests`, join(dir, 'requests'));
      assert.match(requests, /Pale Cocoon/);
      assert.match(requests, /class="request-next-air">Next: Episode 2 · 2026-11-29/);
      const englishRequests = await dump(`${base}/?english=1#/requests`,
        join(dir, 'english-requests'));
      assert.match(englishRequests, /<strong[^>]*>The Pale Cocoon<\/strong>/);
      assert.match(englishRequests, /<strong[^>]*>FX Magical Girl Kurumi<\/strong>/);
      assert.match(requests, /FX Senshi Kurumi-chan/);
      assert.match(requests, /Checking catalogue release dates/);
      assert.match(requests, /Requested by Owner/);
      assert.match(requests, /id="more-preparations" type="button">Show older preparations/);
      assert.match(requests, /Cancel request/);
      assert.match(requests, /A title needing help(?:(?!class="request-row")[\s\S])*Cancellation is unavailable once release processing starts/);
      assert.match(requests, /All anime requests/);
      assert.match(requests, /Requested by Owner/);
      assert.match(requests, /class="request-stage">Requested<\/strong>/);
      assert.match(requests, /No download is confirmed in progress/);
      assert.match(requests, /data-request-group="attention">(?:(?!<\/section>)[\s\S])*A title needing help/);
      assert.match(requests, /data-request-group="active">(?:(?!<\/section>)[\s\S])*Pale Cocoon/);
      assert.match(requests, /<details[^>]*data-request-group="completed"[^>]*><summary[^>]*>Completed<\/summary>/);
      assert.match(requests, /<details[^>]*data-request-group="cancelled"[^>]*><summary[^>]*>Cancelled<\/summary>/);
      assert.match(requests, /data-request-group="completed"(?:(?!<\/details>)[\s\S])*The Garden of Words/);
      assert.match(requests, /data-request-group="cancelled"(?:(?!<\/details>)[\s\S])*A cancelled request/);
      assert.doesNotMatch(requests, /data-request-group="completed"(?:(?!<\/details>)[\s\S])*A cancelled request/);
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
