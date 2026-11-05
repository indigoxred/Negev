const cover = 'https://cdn.anidb.net/images/main/';
const titles = [
  { id: 9541, title: 'Attack on Titan', kind: 'Series', picture: '221067.jpg', release: 'Completed', availability: 'partial', label: '6 of 12 available', description: 'Humanity lives behind immense walls while a new threat draws three friends into a fight for survival.' },
  { id: 9589, title: 'The Garden of Words', kind: 'Film', picture: '221062.jpg', release: 'Film', availability: 'ready', label: 'Ready to watch', description: 'Two strangers meet on rainy mornings in a garden and find comfort in each other’s company.' },
  { id: 4158, title: 'Pale Cocoon', kind: 'Film', picture: '160916.jpg', release: 'Film', availability: 'unknown', label: 'Not checked', description: 'In a distant future, an archivist uncovers fragments of a world long forgotten.' },
  { id: 69, title: 'One Piece', kind: 'Series', picture: '224210.jpg', release: 'Airing', availability: 'partial', label: '31 episodes available', description: 'A crew sails toward the Grand Line in pursuit of the ultimate treasure.' },
  { id: 11284, title: 'Kowabon', kind: 'Series', picture: '287366.jpg', release: 'Completed', availability: 'partial', label: '5 of 13 available', description: 'Short unsettling stories unfold through a distinctive rotoscope style.' },
  { id: 19847, title: 'FX Senshi Kurumi-chan', kind: 'Series', picture: '329557.jpg', release: 'Airing', availability: 'unknown', label: 'Not checked', description: 'A new adventure is beginning. This description is sample preview text.' },
  { id: 8861, title: 'Campione! Matsurowanu Kamigami to Kamigoroshi no Maou', kind: 'Series', picture: '221942.jpg', release: 'Completed', availability: 'ready', label: 'Ready to watch', description: 'A young man becomes involved in conflicts between gods and their challengers.' },
];
const requests = [
  { id: 'kowabon', titleId: 11284, view: 'active', stage: 'Adding to the library', coverage: '5 of 13 episodes available', note: 'The download finished. The remaining episodes are being checked and imported.' },
  { id: 'attack', titleId: 9541, view: 'active', stage: 'Downloading episode 7', coverage: '6 of 12 episodes available', note: '68% transferred · about 4 minutes for this download only. Checking and import follow.', progress: 68 },
  { id: 'fx', titleId: 19847, view: 'watching', stage: 'Watching for the next episode', coverage: '2 of 6 released episodes available', note: 'New episodes will be checked as they appear.' },
  { id: 'garden', titleId: 9589, view: 'completed', stage: 'Ready to watch', coverage: 'Film available', note: 'Request fulfilled in this preview.' },
  { id: 'pale', titleId: 4158, view: 'attention', stage: 'Needs owner attention', coverage: 'Availability not confirmed', note: 'The owner needs to review this import. No completion estimate is available.' },
];
let formatFilter = 'all';
let requestView = 'active';
let searchQuery = '';
const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const title = (id) => titles.find((item) => item.id === Number(id));
const card = (item) => `<a class="poster-card" href="#/title/${item.id}" aria-label="View ${escapeHtml(item.title)}">
  <span class="poster-frame"><img src="${cover + item.picture}" alt="" loading="lazy"></span>
  <span class="poster-copy"><strong>${escapeHtml(item.title)}</strong><small>${item.kind} · ${item.release}</small>
  <span class="badge ${item.availability}">${escapeHtml(item.label)}</span></span></a>`;
const grid = (items) => items.length
  ? `<div class="poster-grid">${items.map(card).join('')}</div>`
  : '<div class="empty">No matching titles in this visual preview. Try another search or filter.</div>';
const shelf = (heading, note, items, route) => `<section class="section"><div class="section-head"><div><h2>${heading}</h2><p>${note}</p></div>
  <a class="text-link" href="#/${route}">View all →</a></div>${grid(items)}</section>`;
const heading = (eyebrow, name, note) => `<header class="page-head"><div><span class="eyebrow">${eyebrow}</span><h1>${name}</h1><p>${note}</p></div></header>`;
function discover() {
  const results = titles.filter((item) => item.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
    (formatFilter === 'all' || item.kind.toLowerCase() === formatFilter));
  return `${heading('Discover', 'Anime, ready to explore.', 'Find something new, or see what is already on this server.')}
    <section class="spotlight"><img src="${cover}221062.jpg" alt="">
      <div class="spotlight-content"><span class="eyebrow">From the library · Sample</span>
        <h2>The Garden of Words</h2><p>A quiet film for a rainy afternoon. Preview status: ready to watch.</p>
        <a class="button" href="#/title/9589">View this film</a></div></section>
    ${shelf('Explore anime', 'A small sample of the wider catalogue.', titles.slice(0, 6), 'airing')}
    ${shelf('From the library', 'Ready and partly ready examples, including direct imports.',
      titles.filter((item) => item.availability !== 'unknown'), 'library')}
    <section class="section" id="search-results"><div class="section-head"><div><h2>Search the catalogue</h2>
      <p>Sample title matches. Search and format filters work in this preview.</p></div></div>
      <div class="filters" aria-label="Format"><button class="filter" data-format="all" aria-pressed="${formatFilter === 'all'}">All</button>
      <button class="filter" data-format="series" aria-pressed="${formatFilter === 'series'}">Series</button>
      <button class="filter" data-format="film" aria-pressed="${formatFilter === 'film'}">Films</button></div>${grid(results)}</section>`;
}
function cataloguePage(route) {
  const airing = route === 'airing';
  const items = airing
    ? titles.filter((item) => item.release === 'Airing')
    : titles.filter((item) => item.availability !== 'unknown');
  return `${heading(airing ? 'Current releases' : 'On this server',
    airing ? 'Airing anime' : 'Your library',
    airing ? 'Sample release information. Air dates do not promise Plex readiness.'
      : 'Sample available titles, including media imported directly by the owner.')}
    ${grid(items)}`;
}
function requestRow(request) {
  const item = title(request.titleId);
  return `<article class="request-card"><img src="${cover + item.picture}" alt="">
    <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(request.coverage)}</p>
    <p class="stage">${escapeHtml(request.stage)}</p><p class="note">${escapeHtml(request.note)}</p>
    ${request.progress == null ? '' : `<progress class="progress" aria-label="Download transfer" value="${request.progress}" max="100">${request.progress}%</progress>`}</div>
    <a class="text-link" href="#/title/${item.id}">View title →</a></article>`;
}
function requestPage() {
  const tabs = [['active', 'Active'], ['watching', 'Watching'], ['completed', 'Completed'],
    ['attention', 'Needs attention']];
  const visible = requests.filter((request) => request.view === requestView);
  return `${heading('Your activity', 'My requests',
    'See what is happening, what is ready, and what needs help.')}
    <div class="request-tabs" role="tablist" aria-label="Request status">
      ${tabs.map(([key, label]) => `<button role="tab" data-view="${key}" aria-selected="${requestView === key}">${label}</button>`).join('')}</div>
    <div class="request-list">${visible.length ? visible.map(requestRow).join('')
      : '<div class="empty">Nothing in this section yet.</div>'}</div>`;
}
function detailPage(id) {
  const item = title(id);
  if (!item) return heading('Catalogue', 'Title not found', 'Return to Discover and choose another title.');
  const action = item.availability === 'ready' ? 'Play in Plex (preview)'
    : item.availability === 'partial' ? 'Request missing episodes' : 'Request this title';
  return `<a href="#/discover" class="text-link back">← Back to Discover</a>
    <article class="detail"><img src="${cover + item.picture}" alt="">
      <div><span class="eyebrow">${item.kind} · ${item.release}</span>
        <h1>${escapeHtml(item.title)}</h1><p class="fact">Sample title details · AniDB identity ${item.id}</p>
        <p class="description">${escapeHtml(item.description)}</p>
        <div class="coverage ${item.availability}"><b>${escapeHtml(item.label)}</b><span class="fact">Preview availability, not a live Plex check</span></div>
        <div class="button-row"><button class="button" data-preview-action="${item.id}">${action}</button>
          <a class="button secondary" href="#/requests">My requests</a></div>
        <p class="note">Requests and playback are disabled in this isolated visual preview.</p>
        ${item.kind === 'Series' ? `<details><summary>Episodes &amp; Specials</summary><div class="episode">Episode 1 · Sample detail</div>
          <div class="episode">Episode 2 · Sample detail</div>
          <div class="episode">Specials appear separately when known.</div></details>` : ''}</div></article>`;
}
function render() {
  const [route, id] = (location.hash.slice(2) || 'discover').split('/');
  byId('main').innerHTML = route === 'requests' ? requestPage()
    : ['airing', 'library'].includes(route) ? cataloguePage(route)
      : route === 'title' ? detailPage(id) : discover();
  document.querySelectorAll('[data-nav]').forEach((link) =>
    link.setAttribute('aria-current', link.dataset.nav === route ? 'page' : 'false'));
  document.title = `Negev · ${route[0].toUpperCase() + route.slice(1)} · Preview`;
}
document.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-format]');
  if (filter) { formatFilter = filter.dataset.format; render(); return; }
  const tab = event.target.closest('[data-view]');
  if (tab) { requestView = tab.dataset.view; render(); return; }
  const action = event.target.closest('[data-preview-action]');
  if (action) {
    const item = title(action.dataset.previewAction);
    byId('confirm-copy').textContent = item.availability === 'ready'
      ? 'This preview cannot open Plex. No live playback will start.'
      : item.kind === 'Film' ? 'Sample film request. No download will start.'
        : 'Sample regular-episode request. Specials stay separate. No download will start.';
    byId('confirm').showModal();
    byId('cancel').focus();
  }
});
document.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement) event.target.classList.add('missing-art');
}, true);
byId('cancel').addEventListener('click', () => byId('confirm').close());
byId('continue').addEventListener('click', () => {
  byId('confirm').close();
  location.hash = '#/requests';
});
byId('search').addEventListener('input', (event) => {
  searchQuery = event.target.value;
  if (location.hash !== '#/discover') location.hash = '#/discover';
  else render();
  if (searchQuery) byId('search-results')?.scrollIntoView({ block: 'start' });
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
render();
