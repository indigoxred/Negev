import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchPager } from '../src/web/public/search-pages.mjs';

const item = (id) => ({ anidbId: id, title: `Anime ${id}` });

test('pages a stable catalogue search without duplicating titles', () => {
  const pager = createSearchPager({ state: 'results', page: 1,
    total: 3, items: [item(1), item(2)] });
  assert.equal(pager.nextPage, 2);
  assert.deepEqual(pager.append({ state: 'results', page: 2,
    total: 3, items: [item(3)] }), { state: 'appended', items: [item(3)] });
  assert.equal(pager.nextPage, null);
  assert.deepEqual(pager.items, [item(1), item(2), item(3)]);
});

test('holds changed totals, repeated IDs and empty continuation pages', () => {
  for (const changed of [
    { state: 'results', page: 2, total: 4, items: [item(3)] },
    { state: 'results', page: 2, total: 3, items: [item(1)] },
    { state: 'results', page: 2, total: 3, items: [] },
    { state: 'results', page: 3, total: 3, items: [item(3)] },
  ]) {
    const pager = createSearchPager({ state: 'results', page: 1,
      total: 3, items: [item(1), item(2)] });
    assert.deepEqual(pager.append(changed), { state: 'held' });
    assert.equal(pager.nextPage, 2);
  }
});

test('a fallback source cannot be spliced into a dump search page', () => {
  const pager = createSearchPager({ state: 'results', page: 1,
    total: 3, catalogueSource: 'anidb_dump', items: [item(1), item(2)] });
  assert.deepEqual(pager.append({ state: 'results', page: 2,
    total: 3, catalogueSource: 'shoko_cache', items: [item(3)] }),
  { state: 'held' });
});

test('empty search has no further page', () => {
  const pager = createSearchPager({ state: 'results', page: 1,
    total: 0, items: [] });
  assert.equal(pager.nextPage, null);
});

test('continuations start two screens ahead, once, with a bounded bottom-only lead', async () => {
  const { observeCatalogueContinuation } = await import('../src/web/public/search-pages.mjs');
  assert.equal(typeof observeCatalogueContinuation, 'function');
  for (const [height, margin] of [[844, '0px 0px 1688px 0px'],
    [900, '0px 0px 1800px 0px'], [8000, '0px 0px 2400px 0px']]) {
    let notify;
    let observed;
    let options;
    let disconnected = 0;
    let loads = 0;
    const marker = {};
    class Observer {
      constructor(callback, settings) { notify = callback; options = settings; }
      observe(target) { observed = target; }
      disconnect() { disconnected++; }
    }
    observeCatalogueContinuation(marker, () => { loads++; }, height, Observer);
    assert.equal(observed, marker);
    assert.equal(options.rootMargin, margin);
    notify([{ isIntersecting: false }]);
    assert.equal(loads, 0, 'no page outside the bounded lead');
    notify([{ isIntersecting: true }]);
    notify([{ isIntersecting: true }]);
    assert.equal(loads, 1, 'queued observer callbacks cannot start concurrent copies');
    assert.equal(disconnected, 1);
  }
});

test('discarded continuation observers cannot load after route or filter changes', async () => {
  const { observeCatalogueContinuation } = await import('../src/web/public/search-pages.mjs');
  assert.equal(typeof observeCatalogueContinuation, 'function');
  let notify;
  let loads = 0;
  class Observer {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() {}
  }
  const control = observeCatalogueContinuation({}, () => { loads++; }, 844, Observer);
  control.disconnect();
  notify([{ isIntersecting: true }]);
  assert.equal(loads, 0, 'a queued intersection must not revive an abandoned page');
});

test('successive markers cannot consume the catalogue without further downward scrolling',async()=>{
 const {createCataloguePrefetchBudget}=await import('../src/web/public/search-pages.mjs');
 const budget=createCataloguePrefetchBudget();
 assert.equal(budget.claim(0,800),true);
 for(let page=0;page<30;page++)assert.equal(budget.claim(0,800),false);
 assert.equal(budget.claim(400,800),false,'layout movement without user input grants nothing');
 budget.noteIntent();
 assert.equal(budget.claim(399,800),false);
 assert.equal(budget.claim(400,800),true);
 assert.equal(budget.claim(200,800),false);
 assert.equal(budget.claim(400,800),false);
 budget.reset();assert.equal(budget.claim(0,800),true);
});
test('catalogue reads share one flight, bounded bursts and a rolling minute budget',async()=>{
 const {createCatalogueReadPacer}=await import('../src/web/public/search-pages.mjs');
 let time=0;const seen=[];const pacer=createCatalogueReadPacer({now:()=>time,sleep:async ms=>{time+=ms;}});
 await Promise.all(Array.from({length:13},(_,i)=>pacer.run(async()=>{seen.push(time);return i;})));
 assert.deepEqual(seen.slice(0,4),[0,0,6000,12000]);
 assert.ok(seen.slice(1).every((t,i)=>t-seen[i]<=12000),
   'sustained browsing must not spend a burst then freeze for most of a minute');
 for(let i=0;i<seen.length;i++)assert.ok(seen.filter(t=>t>=seen[i]&&t<seen[i]+60000).length<=10);
 const before=seen.length;await assert.rejects(pacer.run(()=>{seen.push(time);},()=>false));assert.equal(seen.length,before);
});
test('catalogue cooldown honours Retry-After without automatic retrying a failed read',async()=>{
 const {createCatalogueReadPacer}=await import('../src/web/public/search-pages.mjs');let time=0,reads=0;
 const pacer=createCatalogueReadPacer({now:()=>time,sleep:async ms=>{time+=ms;}});
 await assert.rejects(pacer.run(()=>{reads++;pacer.defer('90');throw Error('429');}));
 assert.equal(reads,1);await pacer.run(()=>{reads++;});assert.equal(time,90000);assert.equal(reads,2);
 pacer.defer(new Date(time+120000).toUTCString());await pacer.run(()=>{});assert.ok(time>=210000);
});

test('shared marker grants and scroll listeners stop stationary automatic chains',async()=>{
 const {observeCatalogueContinuation,createCataloguePrefetchBudget}=await import('../src/web/public/search-pages.mjs');
 const budget=createCataloguePrefetchBudget();let y=0,loads=0,notify;const listeners=new Map();
 const events={addEventListener:(event,fn)=>{listeners.set(event,fn);},removeEventListener:(event,fn)=>{if(listeners.get(event)===fn)listeners.delete(event);}};
 class Observer{constructor(fn){notify=fn;}observe(){}disconnect(){}}
 const next=()=>observeCatalogueContinuation({},()=>{loads++;},800,Observer,{budget,events,readScrollY:()=>y});
 next();notify([{isIntersecting:true}]);assert.equal(loads,1);
 const control=next();notify([{isIntersecting:true}]);assert.equal(loads,1);
 y=400;listeners.get('scroll')();assert.equal(loads,1,'programmatic/anchor movement cannot spend another grant');
 listeners.get('wheel')({type:'wheel',isTrusted:false});listeners.get('scroll')();assert.equal(loads,1);
 listeners.get('wheel')({type:'wheel',isTrusted:true});listeners.get('scroll')();assert.equal(loads,2);
 next();notify([{isIntersecting:true}]);assert.equal(loads,2);
 control.disconnect();
});

test('queued obsolete reads and pending flights cannot consume catalogue slots',async()=>{
 const {createCatalogueReadPacer}=await import('../src/web/public/search-pages.mjs');let release,reads=0;
 const pacer=createCatalogueReadPacer();const first=pacer.run(()=>{reads++;return new Promise(resolve=>{release=resolve;});});const second=pacer.run(()=>{reads++;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);release();await Promise.all([first,second]);assert.equal(reads,2);
 let time=0,current=true;const delayed=createCatalogueReadPacer({now:()=>time,sleep:async ms=>{time+=ms;current=false;}});
 await delayed.run(()=>{});await delayed.run(()=>{});await assert.rejects(delayed.run(()=>{throw Error('must not reach network');},()=>current),/superseded/);
});

test('manual page and retry consume their click intent instead of chaining another page',async()=>{
 const {createCataloguePrefetchBudget}=await import('../src/web/public/search-pages.mjs');const budget=createCataloguePrefetchBudget();
 budget.claim(0,800);budget.noteIntent();budget.consume(600);
 assert.equal(budget.claim(1000,800),false,'append anchoring must not spend the manual click again');
 budget.noteIntent();assert.equal(budget.claim(1000,800),true);
 budget.reset();budget.noteIntent();budget.consume(0);assert.equal(budget.claim(800,800),false,'manual loading also consumes the initial warm-up grant');
});
