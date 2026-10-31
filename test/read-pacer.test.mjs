import assert from 'node:assert/strict';
import test from 'node:test';
import { makeBytePacer } from '../src/identity/read-pacer.mjs';

test('shares one cumulative byte-rate budget across calls', async () => {
  let time = 0;
  const waits = [];
  const pacer = makeBytePacer({ bytesPerSecond: 1024 * 1024,
    now: () => time, wait: async (delay) => { waits.push(delay); time += delay; } });
  await pacer.afterBytes(1024 * 1024);
  await pacer.afterBytes(512 * 1024);
  assert.deepEqual(waits, [1000, 500]);
});

test('rejects invalid rate and byte counts', async () => {
  assert.throws(() => makeBytePacer({ bytesPerSecond: 0 }), TypeError);
  const pacer = makeBytePacer({ bytesPerSecond: 1024 * 1024 });
  await assert.rejects(() => pacer.afterBytes(0), TypeError);
});
