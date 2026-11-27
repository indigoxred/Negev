import { createBrowseController } from '../../src/web/public/browse-controller.mjs';
import { createResponseEpoch } from '../../src/web/public/response-epoch.mjs';

export function createBrowseFixture(overrides = {}) {
  const nodes = new Map();
  const element = (tag = 'div', text = '') => ({ tag, textContent: text, dataset: {}, value: '',
    children: [], classList: { add() {}, remove() {}, toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {}, setAttribute() {}, remove() {}, after() {},
    querySelector() { return null; }, querySelectorAll() { return []; } });
  const byId = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const deps = { byId, element, state: { user: { id: 1 }, libraryLoaded: false,
    libraryAfter: null, searchItems: new Map() }, sessionResponses: createResponseEpoch(),
    airingResponses: createResponseEpoch(), airingSeasonResponses: createResponseEpoch(),
    libraryResponses: createResponseEpoch(), seasonalResponses: createResponseEpoch(),
    genreSelections: { airing: new Set(), season: new Set() },
    api: () => new Promise(() => {}), location: { hash: '#/library' },
    window: { scrollY: 0, innerHeight: 900 }, document: { createDocumentFragment: () => element() },
    ...overrides };
  return { controller: createBrowseController(deps), deps, nodes, byId };
}
