import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectStagedMediaTracks } from
  '../src/acquisition/inspect-staged-media-tracks.mjs';

const tracks = [
  { '@type': 'Video', Height: '1080' },
  { '@type': 'Audio', Language: 'ja' },
  { '@type': 'Text', Language: 'en', Title: 'Full English Subtitles' },
];
const fakeAnalyzer = (result = tracks) => async () => ({
  analyzeData: async (_size, readChunk) => {
    assert.equal((await readChunk(4, 0)).length, 4);
    return { media: { track: result } };
  },
  close: () => {},
});

test('checks actual tracks from a bounded staged file without moving it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(100));
    const result = await inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name: 'episode.mkv', size: 100 }],
      createAnalyzer: fakeAnalyzer() });
    assert.deepEqual(result, { state: 'accepted', files: [{
      name: 'episode.mkv', audio: 'japanese', resolution: 1080 }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects missing Japanese track and keeps the file intact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(100));
    const result = await inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name: 'episode.mkv', size: 100 }],
      createAnalyzer: fakeAnalyzer([
        tracks[0], { '@type': 'Audio', Language: 'en' }, tracks[2],
      ]) });
    assert.equal(result.state, 'rejected');
    assert.equal(result.reason, 'japanese_audio_missing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parses a larger header within a bounded second pass', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(6 * 1024 * 1024));
    let passes = 0;
    const result = await inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name: 'episode.mkv', size: 6 * 1024 * 1024 }],
      createAnalyzer: async () => {
        passes++;
        return { analyzeData: async (_size, readChunk) => {
          let read = 0;
          while (read < 6 * 1024 * 1024) {
            const chunk = await readChunk(1024 * 1024, read);
            if (chunk.length === 0) break;
            read += chunk.length;
          }
          return { media: { track: read >= 5 * 1024 * 1024 ? tracks :
            [tracks[0], { '@type': 'Audio', Language: 'en' }] } };
        }, close: () => {} };
      } });
    assert.equal(passes, 2);
    assert.equal(result.state, 'accepted');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uses a bounded larger pass for measured subtitle coverage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(24 * 1024 * 1024));
    const result = await inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name: 'episode.mkv', size: 24 * 1024 * 1024 }],
      createAnalyzer: async () => ({
        analyzeData: async (_size, readChunk) => {
          let read = 0;
          while (read < 24 * 1024 * 1024) {
            const chunk = await readChunk(1024 * 1024, read);
            if (chunk.length === 0) break;
            read += chunk.length;
          }
          return { media: { track: read >= 24 * 1024 * 1024 ? [
            { ...tracks[0], Duration: 1442 }, tracks[1],
            { '@type': 'Audio', Language: 'en' },
            { '@type': 'Text', Language: 'en', Title: 'English',
              Default: 'Yes', Forced: 'No', Duration: 1436,
              ElementCount: 352 },
          ] : [tracks[0], tracks[1]] } };
        }, close: () => {},
      }) });
    assert.equal(result.state, 'accepted');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not discard a file when the read budget leaves tracks uncertain', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(40 * 1024 * 1024));
    const result = await inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name: 'episode.mkv', size: 40 * 1024 * 1024 }],
      createAnalyzer: async () => ({
        analyzeData: async (_size, readChunk) => {
          for (let i = 0; i < 40; i++) {
            if ((await readChunk(1024 * 1024, i * 1024 * 1024)).length === 0) break;
          }
          return { media: { track: [tracks[0], tracks[1]] } };
        }, close: () => {},
      }) });
    assert.equal(result.state, 'unverified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('accepts a same-episode English SRT beside Japanese video', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(100));
    const subtitle = Array.from({ length: 30 }, (_, i) =>
      `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> ` +
      `00:00:${String(i + 1).padStart(2, '0')},000\n` +
      'Hello, we should go home now.\n\n').join('');
    await writeFile(path.join(root, 'episode.en.srt'), subtitle);
    const result = await inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name: 'episode.mkv', size: 100 }],
      subtitles: [{ name: 'episode.en.srt', size: Buffer.byteLength(subtitle) }],
      createAnalyzer: fakeAnalyzer([tracks[0], tracks[1]]) });
    assert.equal(result.state, 'accepted');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an English sidecar with only two signs does not prove dialogue coverage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(100));
    const subtitle = '1\n00:00:01,000 --> 00:00:03,000\n' +
      'Welcome home to the village!\n\n' +
      '2\n00:00:04,000 --> 00:00:06,000\n' +
      'Please do not enter this room!\n';
    await writeFile(path.join(root, 'episode.en.srt'), subtitle);
    const result = await inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name: 'episode.mkv', size: 100 }],
      subtitles: [{ name: 'episode.en.srt', size: Buffer.byteLength(subtitle) }],
      createAnalyzer: fakeAnalyzer([tracks[0], tracks[1]]) });
    assert.equal(result.state, 'unverified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unlabeled adjacent subtitle is preserved when its language is uncertain', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(100));
    await writeFile(path.join(root, 'episode.ass'), '[Events]\nDialogue: 0,0:00:01.00');
    const result = await inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name: 'episode.mkv', size: 100 }],
      subtitles: [{ name: 'episode.ass', size: 31 }],
      createAnalyzer: fakeAnalyzer([tracks[0], tracks[1]]) });
    assert.equal(result.state, 'unverified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses symlinks and path escapes before reading any media', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-tracks-'));
  try {
    await writeFile(path.join(root, 'episode.mkv'), Buffer.alloc(100));
    const inspect = (name) => inspectStagedMediaTracks({ stagingRoot: root,
      files: [{ name, size: 100 }],
      createAnalyzer: async () => { throw Error('must not read'); } });
    try {
      await symlink(path.join(root, 'episode.mkv'), path.join(root, 'link.mkv'));
      assert.equal((await inspect('link.mkv')).state, 'unverified');
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
    }
    assert.equal((await inspect('../episode.mkv')).state, 'unverified');
  } finally { await rm(root, { recursive: true, force: true }); }
});
