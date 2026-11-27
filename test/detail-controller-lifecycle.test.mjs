import assert from 'node:assert/strict';
import test from 'node:test';
import { createDetailController } from '../src/web/public/detail-controller.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Node {
  constructor(tag, text, cls) { Object.assign(this, { tag, textContent: text, cls, children: [], dataset: {}, listeners: {} }); const classes = new Set((cls ?? '').split(' ')); this.classList = { add: value => classes.add(value), contains: value => classes.has(value), toggle(value) { if (classes.has(value)) { classes.delete(value); return false; } classes.add(value); return true; } }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains(node) { return this.children.includes(node); }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
function fixture() {
  const panel = new Node('section'), reads = new Map(), nodes = [];
  const state = { user: null, showAdult: true, searchItems: new Map(), detailHydrationQueued: new Set() };
  const controller = createDetailController({ state, byId: () => panel, displayCache: new Map(),
    element: (...args) => { const node = new Node(...args); nodes.push(node); return node; }, posterImage: () => new Node('img'),
    titleLabel: item => new Node('h1', item.title), makeTrackButton: () => new Node('button'),
    pendingTitleAction: () => null, updateTrackControls() {}, requestAnimationFrame() {},
    setTimeout, clearTimeout, applyAdultVisibility() {},
    api: url => { const read = deferred(); reads.set(url, read); return read.promise; } });
  return { controller, panel, reads, state, nodes };
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

