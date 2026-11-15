import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRelatedInstallment } from '../src/acquisition/related-installment-guard.mjs';

const related = { state: 'related_titles', anidbId: 424, items: [
  { anidbId: 468, title: 'Yokohama Kaidashi Kikou: Quiet Country Cafe',
    relation: 'Sequel' },
] };

test('holds a separately listed sequel before stopped submission', () => {
  assert.deepEqual(checkRelatedInstallment({ anidbId: 424,
    requestedTitle: 'Yokohama Kaidashi Kikou', related,
    releaseTitle: '[RedKite] Yokohama Kaidashi Kikou - Quiet Country Cafe',
    fileNames: ['Yokohama Kaidashi Kikou - Quiet Country Cafe - 01.mkv'] }),
  { state: 'held', reason: 'related_installment_mismatch' });
});

test('holds a related installment named by an AniDB English alias before download', () => {
  assert.deepEqual(checkRelatedInstallment({ anidbId: 461,
    requestedTitle: 'Kanojo to Kanojo no Neko',
    related: { state: 'related_titles', anidbId: 461, items: [
      { anidbId: 11874, title: 'Kanojo to Kanojo no Neko: Everything Flows',
        aliases: ['She and Her Cat: Everything Flows'], relation: 'Sequel' },
    ] },
    releaseTitle: '[Commie] She and Her Cat ~Everything Flows~ - 01',
    fileNames: ['[Commie] She and Her Cat ~Everything Flows~ - 01.mkv'] }),
  { state: 'held', reason: 'related_installment_mismatch' });
});

test('holds a singularized related subtitle from a torrent release', () => {
  assert.deepEqual(checkRelatedInstallment({ anidbId: 461,
    requestedTitle: 'Kanojo to Kanojo no Neko',
    related: { state: 'related_titles', anidbId: 461, items: [
      { anidbId: 11874, title: 'Kanojo to Kanojo no Neko: Everything Flows',
        aliases: ['She and Her Cat: Everything Flows'], relation: 'Sequel' },
    ] },
    releaseTitle: '[Draguila] Kanojo to Kanojo no Neko - Everything Flow - 01',
    fileNames: ['[Draguila] Kanojo to Kanojo no Neko - Everything Flow - 01.mkv'] }),
  { state: 'held', reason: 'related_installment_mismatch' });
});

test('holds season-two coordinates when AniDB lists the sequel separately', () => {
  for (const [requestedTitle, sequelTitle, releaseTitle] of [
    ['Trigun Stampede', 'Trigun Stargaze',
      'TRIGUN.STAMPEDE.S02E12.QUO.VADIS.1080p.CR.WEB-DL.mkv'],
    ['The War Ends the World / Raises the World',
      'Kimi to Boku no Saigo no Senjou Season II',
      '[SubsPlease] Kimi to Boku no Saigo no Senjou S2 - 08 (1080p).mkv'],
  ]) {
    assert.deepEqual(checkRelatedInstallment({ anidbId: 424,
      requestedTitle, related: { state: 'related_titles', anidbId: 424,
        items: [{ anidbId: 468, title: sequelTitle, relation: 'Sequel' }] },
      releaseTitle, fileNames: [releaseTitle] }),
    { state: 'held', reason: 'related_installment_mismatch' });
  }
});

test('keeps a numbered installment eligible when it has a known prequel', () => {
  const releaseTitle = '[SubsPlease] Kimi to Boku no Saigo no Senjou S2 - 08 (1080p).mkv';
  assert.deepEqual(checkRelatedInstallment({ anidbId: 468,
    requestedTitle: 'Kimi to Boku no Saigo no Senjou Season II',
    related: { state: 'related_titles', anidbId: 468,
      items: [{ anidbId: 424, title: 'The War Ends the World / Raises the World',
        relation: 'Prequel' }] }, releaseTitle, fileNames: [releaseTitle] }),
  { state: 'related_title_clear' });
});

test('a requested sequel is not rejected merely because it contains the original title', () => {
  assert.deepEqual(checkRelatedInstallment({ anidbId: 468,
    requestedTitle: 'Yokohama Kaidashi Kikou: Quiet Country Cafe',
    related: { state: 'related_titles', anidbId: 468, items: [
      { anidbId: 424, title: 'Yokohama Kaidashi Kikou', relation: 'Prequel' },
    ] },
    releaseTitle: '[RedKite] Yokohama Kaidashi Kikou - Quiet Country Cafe',
    fileNames: ['Yokohama Kaidashi Kikou - Quiet Country Cafe - 01.mkv'] }),
  { state: 'related_title_clear' });
});

test('unavailable or inconsistent relation evidence holds without a download', () => {
  assert.deepEqual(checkRelatedInstallment({ anidbId: 424,
    requestedTitle: 'Yokohama Kaidashi Kikou', related: { state: 'unavailable' },
    fileNames: ['01.mkv'] }),
  { state: 'held', reason: 'related_title_unavailable' });
  assert.deepEqual(checkRelatedInstallment({ anidbId: 424,
    requestedTitle: 'Yokohama Kaidashi Kikou',
    related: { ...related, anidbId: 999 }, fileNames: ['01.mkv'] }),
  { state: 'held', reason: 'related_title_unavailable' });
});
