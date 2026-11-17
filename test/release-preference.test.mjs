import assert from 'node:assert/strict';
import test from 'node:test';
import { assessRelease, compareReleases } from
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

test('prefers BD, 1080p, 720p, and finally 480p for old releases', () => {
  const names = [
    'Show WEB 480p', 'Show WEB 720p', 'Show WEB 1080p',
    'Show BD 720p', 'Show BD 1080p',
  ];
  assert.deepEqual(names.map((title) => item(title)).sort(compareReleases)
    .map((release) => release.title), names.reverse());
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

test('a healthy 720p release outranks a barely seeded BD 1080p release', () => {
  const ordered = [item('Show BD 1080p', 1),
    item('Show WEB 720p', 18)].sort(compareReleases);
  assert.equal(ordered[0].seeders, 18);
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
