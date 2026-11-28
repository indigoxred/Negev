import assert from 'node:assert/strict';
import test from 'node:test';
import { createDetailController } from '../src/web/public/detail-controller.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Node {
  constructor(tag, text, cls) { Object.assign(this, { tag, textContent: text, cls, children: [], dataset: {}, listeners: {} }); const classes = new Set((cls ?? '').split(' ')); this.classList = { add: value => classes.add(value), contains: value => classes.has(value), toggle(value) { if (classes.has(value)) { classes.delete(value); return false; } classes.add(value); return true; } }; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  querySelector(selector) { return this.children.flatMap(child => [child, ...child.descendants()]).find(node => selector.startsWith('.') && node.classList.contains(selector.slice(1))) ?? null; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  closest() { return null; }
  replaceWith(node) { const parent = this.parentNode; if (parent) { parent.children[parent.children.indexOf(this)] = node; node.parentNode = parent; } }
  insertBefore(node, before) { const index = this.children.indexOf(before); node.parentNode = this; this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  querySelectorAll() { return []; }
  contains(node) { return this.children.includes(node); }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
function fixture() {
  const panel = new Node('section'), reads = new Map(), nodes = [],document={createElement:tag=>new Node(tag),title:'Negev · Title'};
  const state = { user: null, showAdult: true, searchItems: new Map(), detailHydrationQueued: new Set() };
  const controller = createDetailController({ state, byId: () => panel, displayCache: new Map(),
    element: (...args) => { const node = new Node(...args); nodes.push(node); return node; }, posterImage: () => new Node('img'),
    titleLabel: item => new Node('h1', item.title), makeTrackButton: () => new Node('button'),
    pendingTitleAction: () => null, updateTrackControls() {}, requestAnimationFrame() {},
    document,
    setTimeout, clearTimeout, applyAdultVisibility() {},
    api: url => { const read = deferred(); reads.set(url, read); return read.promise; } });
  return { controller, panel, reads, state, nodes,document };
}
test('invalidating detail work prevents both metadata and episode replies from replacing the page', async () => {
  const x = fixture(), pending = x.controller.showDetail({ anidbId: 1, title: 'Old' });
  const snapshot = [...x.panel.children];
  x.controller.invalidate();
  x.reads.get('/api/catalogue/1/display').resolve({ state: 'display', restricted: false, description: 'Late metadata' });
  x.reads.get('/api/catalogue/1').resolve({ restricted: false });
  await pending;
  assert.deepEqual(x.panel.children, snapshot);
  assert.equal(x.state.searchItems.size, 0);
});
for (const kind of ['series', 'movie']) test(`the detail graph builds ${kind} request and episode controls`, async t => {
  const observer = class { observe() {} unobserve() {} disconnect() {} };
  const originals = { IntersectionObserver: globalThis.IntersectionObserver, ResizeObserver: globalThis.ResizeObserver };
  Object.assign(globalThis, { IntersectionObserver: observer, ResizeObserver: observer });
  t.after(() => Object.assign(globalThis, originals));
  const x = fixture(), pending = x.controller.showDetail({ anidbId: 1, title: 'Title' });
  x.reads.get('/api/catalogue/1/display').resolve(null);
  x.reads.get('/api/catalogue/1').resolve({ state: 'details', anidbId: 1, title: 'Title', kind,
    restricted: false, releaseState: 'released', requestsOpen: true, total: 1, page: 1, pageSize: 50, nextPage: null,
    episodes: [{ id: 11, type: 'Episode', number: 1, title: 'Episode 1', availability: 'missing' }] });
  await pending;
  assert.equal(x.nodes.some(node => node.textContent === 'Try again'), false, 'the graph must not fall into detail error recovery');
  assert.ok(x.nodes.some(node => node.cls === 'availability-check'));
  assert.ok(x.nodes.some(node => kind === 'series'
    ? node.cls === 'primary season-request-trigger' : node.textContent === 'Request this installment'));
});
test('detail metadata renders facts and lets the synopsis expand without waiting for episode details', async () => {
  const x = fixture(), pending = x.controller.showDetail({ anidbId: 1, title: 'Title' });
  x.reads.get('/api/catalogue/1/display').resolve({ state: 'display', restricted: false,
    type: 'TV', startYear: 2026, releaseStatus: 'CURRENTLY_AIRING', description: 'Long synopsis '.repeat(30) });
  await new Promise(resolve => setImmediate(resolve));
  const description = x.nodes.find(node => node.cls === 'detail-description');
  assert.ok(description.classList.contains('is-collapsed'));
  assert.ok(x.nodes.some(node => node.cls === 'detail-facts' && node.textContent.includes('2026')));
  const toggle = x.nodes.find(node => node.cls === 'detail-description-toggle');
  toggle.listeners.click();
  assert.equal(description.classList.contains('is-collapsed'), false);
  assert.equal(toggle.textContent, 'Show less');
  x.controller.invalidate();
  x.reads.get('/api/catalogue/1').resolve({});
  await pending;
});
test('a previous title failure cannot replace the newer title or add its retry button', async () => {
  const x = fixture(), old = x.controller.showDetail({ anidbId: 1, title: 'Old' });
  const current = x.controller.showDetail({ anidbId: 2, title: 'Current' });
  const snapshot = [...x.panel.children];
  x.reads.get('/api/catalogue/1/display').resolve(null);
  x.reads.get('/api/catalogue/1').reject(new Error('late failure'));
  await old;
  assert.deepEqual(x.panel.children, snapshot);
  x.controller.invalidate();
  x.reads.get('/api/catalogue/2/display').resolve(null);
  x.reads.get('/api/catalogue/2').resolve({});
  await current;
  assert.deepEqual(x.panel.children, snapshot);
});

test('a current title read names the browser tab and a late old read cannot replace it',async()=>{
 const x=fixture(),old=x.controller.showDetail({anidbId:1,title:'Anime 1'}),current=x.controller.showDetail({anidbId:2,title:'Anime 2'});
 x.reads.get('/api/catalogue/2/display').resolve(null);x.reads.get('/api/catalogue/2').resolve({state:'detail_pending',anidbId:2,title:'Current anime',restricted:false});await current;
 assert.equal(x.document.title,'Negev · Current anime');x.reads.get('/api/catalogue/1/display').resolve(null);x.reads.get('/api/catalogue/1').resolve({state:'detail_pending',anidbId:1,title:'Old anime',restricted:false});await old;
 assert.equal(x.document.title,'Negev · Current anime');x.controller.invalidate();
});
