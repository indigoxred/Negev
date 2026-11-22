import assert from 'node:assert/strict';
import test from 'node:test';
import { trustedReleaseQueries, trustedIdentityTitles, trustedTargetedQueries } from
  '../src/acquisition/trusted-release-queries.mjs';

test('a long same-ID title keeps its distinctive main title for release search', () => {
  const longTitle = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu: ' +
    'Youzumi to Party Tsuihou Sareta Ore wa, Kawaii Support Yousei to ' +
    'Issho ni Toritateta Maryoku o Unyou Shite Saikyou o Mezasu';
  const english = 'Magic Repo Man: Dumped by My Party, ' +
    "I'll Cash In with a Cute Support Fairy to Become the Strongest!";
  const shortTitle = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
  assert.deepEqual(trustedReleaseQueries(longTitle, [english]),
    [shortTitle, 'Kashita Maryoku wa', english, english.replace(':','')]);
  assert.deepEqual(trustedTargetedQueries(longTitle, [english], 1),
    [`${shortTitle} 01`, 'Kashita Maryoku wa 01', `${english} 01`, `${english.replace(':','')} 01`]);
  assert.deepEqual(trustedIdentityTitles(longTitle, [english]),
    [shortTitle, english]);
});

test('an arbitrary repeated long title without a distinctive prefix stays unusable', () => {
  assert.deepEqual(trustedReleaseQueries('L'.repeat(121)), []);
  assert.deepEqual(trustedReleaseQueries(`X: ${'L'.repeat(121)}`), []);
});

test('a long title without a colon gets one bounded retrieval prefix', () => {
  const title = 'The Unusually Long Name of a Faraway Anime ' +
    'and Its Continuing Adventures '.repeat(5);
  assert.deepEqual(trustedReleaseQueries(title, ['Official English Name']),
    ['The Unusually Long', 'Official English Name']);
  assert.deepEqual(trustedIdentityTitles(title, ['Official English Name']),
    ['Official English Name']);
});

test('the extra long-title query does not displace existing same-ID aliases', () => {
  const longTitle = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu: ' +
    'Long subtitle '.repeat(12);
  assert.deepEqual(trustedReleaseQueries(longTitle,
    ['Alternative Japanese', 'Magic Repo Man']), [
    'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu',
    'Kashita Maryoku wa', 'Alternative Japanese', 'Magic Repo Man',
  ]);
});

test('keeps a same-ID romanized synonym and English official title in bounded queries', () => {
  const title = 'The Strongest Dull Prince`s Secret Battle for the Throne';
  const main = 'Saikyou Degarashi Ouji no An`yaku Teii Arasoi: Munou o Enjiru SS Rank Ouji wa Koui Keishou-sen o Kage kara Shihai Suru';
  const synonym = 'Saikyou Degarashi Ouji no Anyaku Teii Arasoi';
  const english = 'The Insipid Prince`s Furtive Grab for the Throne';
  assert.deepEqual(trustedReleaseQueries(title, [main, synonym, english]),
    [title, main, synonym, english]);
  assert.deepEqual(trustedIdentityTitles(title, [main, synonym, english]),
    [title, main, synonym, english]);
  assert.deepEqual(trustedTargetedQueries(title, [main, synonym, english], 1),
    [`${title} 01`, `${synonym} 01`, `${english} 01`]);
});

test('a long title below the provider limit gets a spare bounded retrieval prefix, not identity evidence', () => {
  const title = 'Mezametara Saikyou Soubi to Uchuusen Mochi Datta no de, Ikkodate Mezashite Youhei to Shite Jiyuu ni Ikitai';
  const alias = 'Reborn as a Space Mercenary: I Woke Up Piloting the Strongest Starship!';
  const queries = trustedReleaseQueries(title, [alias]);
  assert.ok(title.length < 120);
  assert.ok(queries.includes('Mezametara Saikyou Soubi'));
  assert.ok(queries.includes(alias));
  assert.ok(queries.length <= 4);
  assert.ok(trustedTargetedQueries(title, [alias], 8).includes('Mezametara Saikyou Soubi 08'));
  assert.ok(!trustedIdentityTitles(title, [alias]).includes('Mezametara Saikyou Soubi'));
});
