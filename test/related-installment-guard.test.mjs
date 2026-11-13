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
