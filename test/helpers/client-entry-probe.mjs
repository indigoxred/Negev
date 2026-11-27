// A fresh process isolates browser globals and module initialization per test.
const listeners = [];
const nodes = new Map();
function node(id) {
  if (nodes.has(id)) return nodes.get(id);
  const value = { id, dataset: {}, style: {}, hidden: false, value: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, callback) { listeners.push({ target: id, type, callback }); },
    setAttribute() {}, removeAttribute() {}, append() {}, prepend() {}, replaceChildren() {},
    querySelectorAll() { return []; }, querySelector(selector) { return selector === 'span' ? node(`${id}-span`) : null; },
    reset() {}, focus() {}, close() {}, remove() {}, scrollIntoView() {},
    cloneNode() { return node(`clone-${nodes.size}`); },
    elements: { username: { value: '' }, password: { value: '' }, code: { value: '' } } };
  nodes.set(id, value); return value;
}
globalThis.document = {
  body: node('body'), documentElement: { scrollHeight: 1000 },
  getElementById: node, createElement: tag => node(`created-${tag}-${nodes.size}`),
  querySelector: selector => selector.includes('meta[') ? null : node(selector),
  querySelectorAll: () => [], hidden: false,
  addEventListener(type, callback) { listeners.push({ target: 'document', type, callback }); },
};
globalThis.window = { scrollY: 0, scrollTo() {},
  addEventListener(type, callback) { listeners.push({ target: 'window', type, callback }); } };
globalThis.location = { hash: '#/discover', origin: 'https://fixture.invalid',
  pathname: '/', search: '', reload() {} };
globalThis.history = { replaceState() {} };
globalThis.sessionStorage = globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.setInterval = () => 1;
const role = process.argv[2];
const requests = [];
globalThis.fetch = async url => {
  requests.push(url);
  if (!role) return new Response('{}', { status: 401 });
  const data = url === '/api/session'
    ? { user: { id: 1, username: 'Fixture', role, adultAllowed: true }, csrfToken: 'fixture' }
    : url === '/api/airing/preferences' ? { mode: 'library', trackedAnidbIds: [] }
    : { items: [], nextBeforeId: null, nextAfter: null, genres: [] };
  return Response.json(data);
};
await import('../../src/web/public/app.js');
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({ listeners: listeners.map(({ target, type }) => `${target}:${type}`),
  signedOut: node('workspace').hidden, adminHidden: node('admin-link').hidden, requests }));
