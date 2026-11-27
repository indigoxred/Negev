import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createResponseEpoch } from '../src/web/public/response-epoch.mjs';
import { createAdultSearchVerifier } from '../src/web/public/adult-search-visibility.mjs';
import { hideChineseProduction } from '../src/web/public/chinese-visibility.mjs';

const source = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`) >= 0
    ? source.indexOf(`async function ${name}(`) : source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const display = { state: 'display', anidbId: 42, title: 'Verified title',
  englishTitle: 'Verified English', restricted: false, chineseProduction: true,
  libraryPresence: { state: 'in_library', verifiedEpisodeCount: 2 },
  verifiedLibraryPresence: { state: 'unknown', verifiedEpisodeCount: 0 } };
function fixture(readDisplay = async () => display) {
  const cards = [], rendered = [];
  const placeholder = () => ({ dataset: { adult: 'unknown', anidbId: '42' },
    closest: selector => selector === '#library-search-results' ? {} : null,
    replaceWith(next) { cards[cards.indexOf(this)] = next; } });
  const state = { user: { id: 1 }, showAdult: false, showChinese: true,
    searchToken: 1, searchItems: new Map([[42, { anidbId: 42 }]]) };
  const ctx = vm.createContext({ state, classificationToken: 0,
    sessionResponses: createResponseEpoch(), location: { hash: '#/library?q=example' },
    hideChineseProduction, document: { querySelectorAll: () => cards },
    adultSearchVerifier: createAdultSearchVerifier({ readDisplay,
      pacer: { run: read => read(), defer() {} } }),
    applyAdultVisibility() {}, searchResultCard: (entry, inLibrary) => {
      rendered.push({ entry, inLibrary });
      return { dataset: { adult: String(entry.adult), anidbId: '42' },
        querySelector() { return null; } };
    } });
  vm.runInContext(functionSource('classifySearchCards'), ctx);
  cards.push(placeholder());
  return { ctx, cards, rendered, placeholder };
}

test('ID-only search cards hydrate verified titles, Chinese flags and distinct library proofs', async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; return display; }); await f.ctx.classifySearchCards(1);
  const entry = f.ctx.state.searchItems.get(42);
  assert.equal(entry.title, display.title);
  assert.equal(entry.englishTitle, display.englishTitle);
  assert.equal(entry.chineseProduction, true);
  assert.deepEqual(entry.libraryPresence, display.libraryPresence);
  assert.deepEqual(entry.verifiedLibraryPresence, display.verifiedLibraryPresence);
  assert.equal(f.rendered[0].inLibrary, true);
  f.ctx.state.searchItems.set(42, { anidbId: 42 });
  f.cards.splice(0, f.cards.length, f.placeholder());
  await f.ctx.classifySearchCards(1);
  assert.equal(f.rendered.length, 2, 'repeated ID-only search results also hydrate');
  assert.equal(reads, 2, 'ID-only results refresh mutable display proof');
  assert.equal(f.ctx.state.searchItems.get(42).title, display.title);
});

test('metadata arriving after sign-out cannot populate the next account search', async () => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const f = fixture(() => pending);
  const reading = f.ctx.classifySearchCards(1);
  f.ctx.sessionResponses.invalidate(); f.ctx.state.user = { id: 2 };
  resolve(display); await reading;
  assert.equal(f.rendered.length, 0);
  assert.equal(f.ctx.state.searchItems.get(42).title, undefined);
});

test('ID-only cards do not request posters or build labels before verification', () => {
  let posters = 0, labels = 0;
  const ctx = vm.createContext({ element: tag => ({ tag }),
    markAdult: (node, item, options) => ({ node, item, options }),
    posterImage: () => { posters++; }, titleLabel: () => { labels++; } });
  vm.runInContext(functionSource('searchResultCard'), ctx);
  const result = ctx.searchResultCard({ anidbId: 42 }, false);
  assert.equal(result.node.tag, 'div');
  assert.equal(result.options.hideUnknown, true);
  assert.equal(posters, 0); assert.equal(labels, 0);
});
