// A fresh process isolates browser globals and module initialization per test.
const updateMode=process.argv[2]?.startsWith('update-');
let reloads=0;
const intervals=[];
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
    elements: { username: { value: '', focus(){} }, password: { value: '', focus(){} }, code: { value: '', focus(){} } } };
  nodes.set(id, value); return value;
}
globalThis.document = {
  body: node('body'), documentElement: { scrollHeight: 1000 },
  getElementById: node, createElement: tag => node(`created-${tag}-${nodes.size}`),
  querySelector: selector => selector.includes('meta[') ? updateMode?{content:'old-client'}:null : node(selector),
  activeElement:{matches:()=>true},
  querySelectorAll: () => [], hidden: false,
  addEventListener(type, callback) { listeners.push({ target: 'document', type, callback }); },
};
globalThis.window = { scrollY: 0, scrollTo() {},
  addEventListener(type, callback) { listeners.push({ target: 'window', type, callback }); } };
globalThis.location = { hash: '#/discover', origin: 'https://fixture.invalid',
  pathname: '/', search: '', reload() {reloads++} };
if(updateMode)location.hash='#'+(process.argv[2]==='update-reset'?'reset':'invite')+'='+'a'.repeat(64);
globalThis.history = { replaceState() {location.hash='';} };
globalThis.sessionStorage = globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.setInterval = (callback,ms) => {intervals.push({callback,ms});return 1;};
const role = updateMode?null:process.argv[2];
const requests = [];
globalThis.fetch = async url => {
  requests.push(url);
  if(url==='/api/client-revision')return Response.json({revision:process.argv[3]==='stable'?'old-client':'new-client'});
  if (!role) return new Response('{}', { status: 401 });
  const data = url === '/api/session'
    ? { user: { id: 1, username: 'Fixture', role, adultAllowed: true }, csrfToken: 'fixture' }
    : url === '/api/airing/preferences' ? { mode: 'library', trackedAnidbIds: [] }
    : { items: [], nextBeforeId: null, nextAfter: null, genres: [] };
  return Response.json(data);
};
await import('../../src/web/public/app.js');
await new Promise(resolve => setImmediate(resolve));
if(updateMode){node('update-banner').hidden=true;node('register-form').elements.username.value='In progress';await intervals.find(i=>i.callback.name==='refreshClientRevision').callback();}
console.log(JSON.stringify({reloads,bannerHidden:node('update-banner').hidden,hash:location.hash,registerCode:node('register-form').elements.code.value,resetCode:node('reset-form').elements.code.value,username:node('register-form').elements.username.value, listeners: listeners.map(({ target, type }) => `${target}:${type}`),
  signedOut: node('workspace').hidden, adminHidden: node('admin-link').hidden, requests }));
