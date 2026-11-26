import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRelease, compareReleases, hasSeasonPackHint,
  hasSingleEpisodeHint } from
  '../src/acquisition/release-preference.mjs';

const item = (title, seeders = 12, extra = {}) => ({
  title, seeders, size: 1_000_000_000, indexerId: 5, ...extra,
});

test('rejects zero peers, explicit English dub only, unsubbed, and 4K', () => {
  assert.equal(assessRelease(item('[Group] Show 1080p', 0)).eligible, false);
  assert.equal(assessRelease(item('[Group] Show English Dub 1080p')).eligible, false);
  assert.equal(assessRelease(item('[Group] Show no subtitles 1080p')).eligible, false);
  assert.equal(assessRelease(item('[Group] Show 2160p')).eligible, false);
  assert.equal(assessRelease(item('[Group] Show Dual Audio Eng Sub 1080p')).eligible, true);
});
test('manual audio and UHD exceptions are explicit and do not change automatic defaults',()=>{
 const dub=item('[G] Show English Dub 1080p');const uhd=item('[G] Show BD 2160p');
 assert.equal(assessRelease(dub).eligible,false);assert.equal(assessRelease(uhd).eligible,false);
 assert.equal(assessRelease({...dub,selectionPolicy:{allowEnglishDub:true}}).eligible,true);
 assert.equal(assessRelease({...uhd,selectionPolicy:{allowUhd:true}}).eligible,true);
 assert.equal(assessRelease({...dub,selectionPolicy:{allowUhd:true}}).eligible,false);
});

test('prefers BD and 1080p with 720p and 480p as ordered fallbacks', () => {
  const names = [
    'Show WEB 720p', 'Show BD 720p',
    'Show WEB 1080p', 'Show BD 1080p',
  ];
  assert.deepEqual(names.map((title) => item(title)).sort(compareReleases)
    .map((release) => release.title), names.reverse());
  assert.equal(assessRelease(item('Show WEB 480p', 500)).eligible, true);
});

test('an exact missing-episode 1080p release precedes other episodes', () => {
  const targeted = item('Show - 05 WEB 1080p', 80, { targetedEpisode: true });
  const unrelated = item('Show - 08 WEB 1080p', 900,
    { targetedEpisode: false });
  assert.equal([unrelated, targeted].sort(compareReleases)[0], targeted);
});

test('prefers healthy seeded and trusted Nyaa results within a quality tier', () => {
  const ordered = [
    item('Show WEB 1080p', 1, { trusted: true }),
    item('Show WEB 1080p', 15),
    item('Show WEB 1080p', 10, { trusted: true }),
  ].sort(compareReleases);
  assert.equal(ordered[0].seeders, 10);
  assert.equal(ordered[0].trusted, true);
  assert.equal(ordered[1].seeders, 15);
  assert.equal(ordered[2].seeders, 1);
});

test('a seeded BD1080p stays ahead of720p despite different peer counts', () => {
  const ordered = [item('Show BD 1080p', 1),
    item('Show WEB 720p', 18)].sort(compareReleases);
  assert.equal(ordered[0].title, 'Show BD 1080p');
});

test('a strong 1080p or 720p release outranks a more seeded 480p fallback', () => {
  const releases = [item('Show - 05 WEB 480p', 500,
    { targetedEpisode: true }),
  item('Show - 05 WEB 720p', 18, { targetedEpisode: true }),
  item('Show - 05 WEB 1080p', 15, { targetedEpisode: true })];
  assert.deepEqual(releases.sort(compareReleases).map((entry) => entry.title),
    ['Show - 05 WEB 1080p', 'Show - 05 WEB 720p',
      'Show - 05 WEB 480p']);
});

test('quality wins when both releases have several reported seeders', () => {
  const ordered = [item('Show WEB 480p', 5),
    item('Show BD 1080p', 4)].sort(compareReleases);
  assert.equal(ordered[0].title, 'Show BD 1080p');
});

test('English subtitle title hints are ordering evidence, never proof of tracks', () => {
  const hint = assessRelease(item('[SubsPlease] Show 1080p'));
  assert.equal(hint.eligible, true);
  assert.equal(hint.trackVerified, false);
  assert.equal(hint.subtitleHint, true);
  assert.equal(assessRelease(item('[Mystery] Show 1080p')).eligible, true);
  const ordered = [item('[Mystery] Show 1080p', 100),
    item('[SubsPlease] Show 1080p', 12)].sort(compareReleases);
  assert.equal(ordered[0].title, '[SubsPlease] Show 1080p');
});

test('prefers Japanese-only subtitle release over dual audio within a viable tier', () => {
  const ordered = [item('Show Dual Audio Eng Subs WEB 1080p', 80),
    item('Show Japanese Eng Subs WEB 1080p', 12)].sort(compareReleases);
  assert.equal(ordered[0].title, 'Show Japanese Eng Subs WEB 1080p');
});

test('a completed season prefers a seeded full pack over individual episodes', () => {
  const releases = [
    item('Seisen Cerberus - 09 BD 1080p', 12),
    item('Cerberus Season 1 WEB 720p', 5),
  ];
  assert.equal([...releases].sort((a, b) => compareReleases(a, b,
    { preferSeasonPack: true }))[0].title, 'Cerberus Season 1 WEB 720p');
  assert.equal([...releases].sort((a, b) => compareReleases(a, b,
    { preferSeasonPack: false }))[0].title, 'Seisen Cerberus - 09 BD 1080p');
  const unseededPack = item('Cerberus Season 1 BD 1080p', 0);
  assert.equal([releases[0], unseededPack].sort((a, b) => compareReleases(a, b,
    { preferSeasonPack: true }))[0].title, releases[0].title);
});

test('a spaced episode range remains a pack hint, not a single episode', () => {
  const pack = item('[Group] Example - 01 - 12 (1080p)');
  assert.equal(hasSeasonPackHint(pack), true);
  assert.equal(hasSingleEpisodeHint(pack), false);
  assert.equal(hasSingleEpisodeHint(item('[Group] Example - 01 (1080p)')), true);
});

test('resolution does not drop at the two-versus-three-seeder boundary',()=>{
 for(const high of [item('Show WEB 1080p',2),item('Show BD 1080p',1)]) {
  assert.equal([item('Show WEB 480p',300),item('Show WEB 720p',30),high].sort(compareReleases)[0],high);
 }
 assert.equal(assessRelease(item('Old Show DVD 480p',1)).eligible,true);
});

test('season-labelled single episodes are not packs, while multi-episode ranges remain pack hints',()=>{
 for(const title of ['Show Season 2 S02E07 1080p','Show Season 2 - 07 [BD 1080p]','Show S02 E07 1080p']){
  assert.equal(hasSeasonPackHint(item(title)),false,title);
  assert.equal(hasSingleEpisodeHint(item(title)),true,title);
 }
 for(const title of ['Show S02E01-E12 1080p','Show 13-24 Complete Batch BD 1080p']){
  assert.equal(hasSeasonPackHint(item(title)),true,title);
  assert.equal(hasSingleEpisodeHint(item(title)),false,title);
 }
});

test('quality assessment treats underscores, spaces, dots and hyphens as equivalent separators',()=>{
 for(const [source,resolution,quality] of [['WEB',720,2],['BD',720,3],['WEB',1080,4],['BD',1080,5],['WEB',1440,4],['WEB',2160,6],['BD',2160,7]]){
  const expected=assessRelease(item(`[Actual_Group] Example ${source} ${resolution}p HEVC`,12,{selectionPolicy:{allowUhd:true}}));
  assert.equal(expected.quality,quality);assert.equal(expected.resolution,resolution);
  for(const separator of [' ','_','.','-']){
   const title=`[Actual_Group] Example${separator}${source}${separator}${resolution}p${separator}HEVC`;
   assert.deepEqual(assessRelease(item(title,12,{selectionPolicy:{allowUhd:true}})),expected,title);
  }
 }
});
test('separator parsing preserves explicit UHD policy and quality ranking',()=>{
 for(const separator of [' ','_','.','-']){
  const title=(source,resolution)=>`Example${separator}${source}${separator}${resolution}p${separator}HEVC`;
  const uhd=item(title('WEB',2160)),bd=item(title('BD',1080)),fallback=item(title('BD',720),50);
  assert.equal(assessRelease(uhd).eligible,false,uhd.title);assert.equal(assessRelease(uhd).reason,'outside_quality_profile');
  assert.deepEqual([fallback,uhd,bd].sort(compareReleases),[bd,fallback,uhd]);
  const allowed={...uhd,selectionPolicy:{allowUhd:true}};
  assert.equal(assessRelease(allowed).eligible,true);assert.equal([bd,fallback,allowed].sort(compareReleases)[0],allowed);
 }
});
