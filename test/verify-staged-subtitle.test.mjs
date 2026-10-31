import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyStagedSubtitle } from '../src/identity/verify-staged-subtitle.mjs';

test('hashes one bounded subtitle inside staging and accounts for paced reads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-subtitle-'));
  try {
    const bytes = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHello\n');
    await writeFile(path.join(root, 'en.srt'), bytes);
    const paced = [];
    const result = await verifyStagedSubtitle({ root, relativePath: 'en.srt',
      readPacer: { afterBytes: async (count) => paced.push(count) } });
    assert.deepEqual(result, { state: 'subtitle_verified', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase() });
    assert.deepEqual(paced, [bytes.length]);
    assert.deepEqual(await verifyStagedSubtitle({ root, relativePath: '../en.srt' }),
      { state: 'held', reason: 'path_outside_staging' });
    assert.deepEqual(await verifyStagedSubtitle({ root, relativePath: 'en.srt',
      maxFileBytes: bytes.length - 1 }), { state: 'held', reason: 'file_over_budget' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
