// A fresh process isolates browser globals and module initialization per test.
const listeners = [];
const nodes = new Map();
function node(id) {
  if (nodes.has(id)) return nodes.get(id);
  const value = { id, dataset: {}, style: {}, hidden: false, value: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, callback) { listeners.push({ target: id, type, callback }); },
    setAttribute() {}, removeAttribute() {}, append() {}, prepend() {}, replaceChildren() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    reset() {}, focus() {}, close() {}, remove() {}, scrollIntoView() {},
    cloneNode() { return node(`clone-${nodes.size}`); },
    elements: { username: { value: '' }, password: { value: '' }, code: { value: '' } } };
  nodes.set(id, value); return value;
}
globalThis.document = {
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
globalThis.fetch = async () => new Response('{}', { status: 401 });
await import('../../src/web/public/app.js');
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({ listeners: listeners.map(({ target, type }) => `${target}:${type}`),
  signedOut: node('workspace').hidden }));
