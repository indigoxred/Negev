import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareStoppedCandidate } from '../src/acquisition/prepare-stopped-candidate.mjs';

const info = Buffer.from('d6:lengthi1000e4:name11:Example.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae');
const torrent = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
const hash = createHash('sha1').update(info).digest('hex');
const candidate = { guid: 'release-1', indexerId: 3, title: 'Example 01', size: 1000 };
const proxy = 'http://prowlarr.internal:9696/3/download?apikey=syntheticKey&link=abc123&file=Example';
const config = { baseUrl: 'http://prowlarr.internal:9696/', apiKey: 'syntheticKey',
  query: 'Example', candidate, indexerIds: [3] };

test('prepares original bytes, exact hash and stopped staging form without a downloader call', async () => {
  const calls = [];
  const result = await prepareStoppedCandidate({ ...config, fetchImpl: async (url) => {
    calls.push(new URL(url).pathname);
    return calls.length === 1
      ? Response.json([{ ...candidate, protocol: 'torrent', downloadUrl: proxy }])
      : new Response(torrent, { headers: { 'content-type': 'application/x-bittorrent' } });
  } });
  assert.deepEqual(calls, ['/api/v1/search', '/3/download']);
  assert.equal(result.state, 'prepared_stopped');
  assert.equal(result.expected.hash, hash);
  assert.equal(result.expected.category, 'negev');
  assert.equal(result.expected.savePath, `/Downloads/negev/${hash}`);
  assert.equal(result.form.get('savepath'), `/Downloads/negev/${hash}`);
  assert.equal(result.form.get('contentLayout'), 'NoSubfolder');
  assert.deepEqual(result.files, [{ name: 'Example.mkv', size: 1000 }]);
  assert.equal(result.form.get('stopped'), 'true');
  assert.equal(result.form.get('autoTMM'), 'false');
  assert.deepEqual(new Uint8Array(await result.form.get('torrents').arrayBuffer()), new Uint8Array(torrent));
});

test('malformed metainfo remains held before form creation', async () => {
  let calls = 0;
  const result = await prepareStoppedCandidate({ ...config, fetchImpl: async () => {
    calls++;
    return calls === 1
      ? Response.json([{ ...candidate, protocol: 'torrent', downloadUrl: proxy }])
      : new Response(Buffer.from('not-a-torrent'), { headers: { 'content-type': 'application/x-bittorrent' } });
  } });
  assert.deepEqual(result, { state: 'held', reason: 'invalid_torrent_bytes' });
});
