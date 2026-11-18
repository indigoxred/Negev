import assert from 'node:assert/strict';
import test from 'node:test';
import { trustedReleaseQueries, trustedTargetedQueries } from
  '../src/acquisition/trusted-release-queries.mjs';

test('a long same-ID title keeps its distinctive main title for release search', () => {
  const longTitle = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu: ' +
    'Youzumi to Party Tsuihou Sareta Ore wa, Kawaii Support Yousei to ' +
    'Issho ni Toritateta Maryoku o Unyou Shite Saikyou o Mezasu';
  const english = 'Magic Repo Man: Dumped by My Party, ' +
    "I'll Cash In with a Cute Support Fairy to Become the Strongest!";
  const shortTitle = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
  assert.deepEqual(trustedReleaseQueries(longTitle, [english]),
    [shortTitle, english]);
  assert.deepEqual(trustedTargetedQueries(longTitle, [english], 1),
    [`${shortTitle} 01`, `${english} 01`]);
});

test('an arbitrary long title without a distinctive named prefix stays unusable', () => {
  assert.deepEqual(trustedReleaseQueries('L'.repeat(121)), []);
  assert.deepEqual(trustedReleaseQueries(`X: ${'L'.repeat(121)}`), []);
});
