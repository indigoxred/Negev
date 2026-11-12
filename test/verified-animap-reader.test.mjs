import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createVerifiedAniMapReader } from
  '../src/acquisition/verified-animap-reader.mjs';

const nowMs = Date.parse('2026-11-12T00:00:00Z');
const map = { version: 2, generated_at: '2026-11-11T00:00:00Z',
  anime: [{ anidb_id: 11, tvdb_id: 100 }] };
const body = JSON.stringify(map);
const digest = createHash('sha256').update(body).digest('hex');

test('reads a checksum-verified fresh AniMap release once per cache window', async () => {
  let calls = 0;
  const reader = createVerifiedAniMapReader({ now: () => nowMs,
    fetchImpl: async (url) => {
      calls++;
      return new Response(String(url).endsWith('.sha256')
        ? `${digest}  animap.json\n` : body);
    } });
  assert.deepEqual(await reader.read(), map);
  assert.deepEqual(await reader.read(), map);
  assert.equal(calls, 2);
});

test('a mismatched digest or stale release fails closed', async () => {
  const badDigest = createVerifiedAniMapReader({ now: () => nowMs,
    fetchImpl: async (url) => new Response(String(url).endsWith('.sha256')
      ? `${'0'.repeat(64)}  animap.json\n` : body) });
  await assert.rejects(badDigest.read());
  const staleBody = JSON.stringify({ ...map, generated_at: '2026-10-01T00:00:00Z' });
  const staleDigest = createHash('sha256').update(staleBody).digest('hex');
  const stale = createVerifiedAniMapReader({ now: () => nowMs,
    fetchImpl: async (url) => new Response(String(url).endsWith('.sha256')
      ? `${staleDigest}  animap.json\n` : staleBody) });
  await assert.rejects(stale.read());
});
