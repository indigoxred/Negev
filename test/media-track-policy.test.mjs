import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateMediaTracks } from
  '../src/acquisition/media-track-policy.mjs';

const video = { '@type': 'Video', Width: 1920, Height: 1080 };
const japanese = { '@type': 'Audio', Language: 'ja-JP', Title: 'Japanese' };
const englishAudio = { '@type': 'Audio', Language: 'en', Title: 'English Dub' };
const englishSubs = { '@type': 'Text', Language: 'en-US',
  Title: 'English (Full Subtitle)' };

test('accepts Japanese audio with full English subtitles', () => {
  assert.deepEqual(evaluateMediaTracks([video, japanese, englishSubs]),
    { state: 'accepted', audio: 'japanese', resolution: 1080 });
  assert.deepEqual(evaluateMediaTracks([video, japanese, englishAudio,
    englishSubs]), { state: 'accepted', audio: 'dual', resolution: 1080 });
});

test('rejects English dub only and signs-only subtitles', () => {
  assert.equal(evaluateMediaTracks([video, englishAudio,
    englishSubs]).reason, 'japanese_audio_missing');
  assert.equal(evaluateMediaTracks([video, japanese, { '@type': 'Text',
    Language: 'en', Title: 'English Signs' }]).reason,
  'english_full_subtitles_missing');
});

test('accepts full dialogue and signs while excluding signs-only or forced', () => {
  assert.equal(evaluateMediaTracks([video, japanese, { '@type': 'Text',
    Language: 'en', Title: 'Dialogue & Signs [TSPlease]' }]).state,
  'accepted');
  assert.equal(evaluateMediaTracks([video, japanese, { '@type': 'Text',
    Language: 'en', Title: 'Signs Only [TSPlease]' }]).state,
  'rejected');
});

test('does not assume untagged transport streams meet the language rule', () => {
  assert.equal(evaluateMediaTracks([video, { '@type': 'Audio',
    Format: 'AAC' }]).reason, 'audio_language_unverified');
  assert.equal(evaluateMediaTracks([video, { '@type': 'Audio',
    Format: 'AAC' }]).state, 'rejected');
  assert.equal(evaluateMediaTracks([video, japanese]).reason,
    'english_full_subtitles_missing');
});

test('requires a supported real video resolution', () => {
  assert.equal(evaluateMediaTracks([{ ...video, Height: 2160 }, japanese,
    englishSubs]).reason, 'outside_quality_profile');
  assert.equal(evaluateMediaTracks([{ ...video, Height: 480 }, japanese,
    englishSubs]).state, 'accepted');
});

test('an unforced English subtitle track is enough without scanning every cue', () => {
  assert.deepEqual(evaluateMediaTracks([
    { '@type': 'Video', Height: '1080' },
    { '@type': 'Audio', Language: 'ja' },
    { '@type': 'Audio', Language: 'en' },
    { '@type': 'Text', Language: 'en', Default: 'No', Forced: 'No' },
  ]), { state: 'accepted', audio: 'dual', resolution: 1080 });
});

test('accepts an identified nondefault English track with Japanese-only audio', () => {
  assert.deepEqual(evaluateMediaTracks([
    video, japanese,
    { '@type': 'Text', Language: 'pt', Title: 'World Fansub',
      Default: 'Yes', Forced: 'No' },
    { '@type': 'Text', Language: 'en', Title: 'Chihiro',
      Default: 'No', Forced: 'No' },
  ]), { state: 'accepted', audio: 'japanese', resolution: 1080 });
  assert.equal(evaluateMediaTracks([
    video, japanese, englishAudio,
    { '@type': 'Text', Language: 'en', Title: 'English',
      Default: 'No', Forced: 'No' },
  ]).state, 'accepted');
  assert.equal(evaluateMediaTracks([
    video, japanese,
    { '@type': 'Text', Language: 'pt', Title: 'Full',
      Default: 'Yes', Forced: 'No' },
    { '@type': 'Text', Language: 'en', Title: 'English Signs',
      Default: 'No', Forced: 'No' },
  ]).state, 'rejected');
});

test('accepts a plain English track when measured dialogue spans the episode', () => {
  assert.deepEqual(evaluateMediaTracks([
    { ...video, Duration: 1442 }, japanese, englishAudio,
    { '@type': 'Text', Language: 'en', Title: 'English',
      Default: 'Yes', Forced: 'No', Duration: 1436,
      ElementCount: 352 },
  ]), { state: 'accepted', audio: 'dual', resolution: 1080 });
});

test('explicit signs, songs and forced English tracks are still insufficient', () => {
  for (const title of ['English [Signs]', 'English Songs',
    'English Full Signs', 'Forced English']) {
    assert.equal(evaluateMediaTracks([
      video, japanese, englishAudio,
      { '@type': 'Text', Language: 'en', Title: title,
        Default: 'No', Forced: 'No' },
    ]).state, 'rejected');
  }
  assert.equal(evaluateMediaTracks([
    video, japanese, englishAudio,
    { '@type': 'Text', Language: 'en', Title: 'English',
      Default: 'No', Forced: 'Yes' },
  ]).state, 'rejected');
});

test('a verified adjacent English subtitle can satisfy an otherwise suitable file', () => {
  assert.equal(evaluateMediaTracks([
    { '@type': 'Video', Height: '720' },
    { '@type': 'Audio', Language: 'ja' },
  ], { externalEnglishSubtitle: true }).state, 'accepted');
});

