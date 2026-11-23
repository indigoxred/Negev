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

test('same-ID season aliases reject season-one packs and file coordinates for a year-labelled sequel', () => {
  const input={anidbId:18562,requestedTitle:'Kusuriya no Hitorigoto (2025)',
    requestedAliases:['Kusuriya no Hitorigoto 2nd Season','The Apothecary Diaries S2'],
    related:{state:'related_titles',anidbId:18562,items:[{anidbId:17460,title:'Kusuriya no Hitorigoto',relation:'Prequel'}]}};
  for(const [releaseTitle,fileNames]of [
    ['[EMBER] The Apothecary Diaries (2023) (Season 1) [BDRip] [1080p Dual Audio HEVC]',['Kusuriya no Hitorigoto - 01.mkv']],
    ['[Group] The Apothecary Diaries S02 (1080p)',['The Apothecary Diaries S01E01.mkv']],
  ])assert.deepEqual(checkRelatedInstallment({...input,releaseTitle,fileNames}),{state:'held',reason:'related_installment_mismatch'});
  for(const [releaseTitle,fileNames]of [
    ['[kikuri] Kusuriya no Hitorigoto 2nd Season (BD 1080p) | The Apothecary Diaries S02',['Kusuriya no Hitorigoto S02E01.mkv']],
    ['[Group] Kusuriya no Hitorigoto (25-48) [1080p]',['Kusuriya no Hitorigoto - 25.mkv']],
  ])assert.deepEqual(checkRelatedInstallment({...input,releaseTitle,fileNames}),{state:'related_title_clear'});
});

test('ambiguous aliases and prequel relations alone do not invent requested season numbers',()=>{
  const input={anidbId:468,requestedTitle:'Quiet Country Cafe',related:{state:'related_titles',anidbId:468,items:[{anidbId:424,title:'Yokohama Kaidashi Kikou',relation:'Prequel'}]},releaseTitle:'Quiet Country Cafe S01',fileNames:['Quiet Country Cafe S01E01.mkv']};
  assert.deepEqual(checkRelatedInstallment(input),{state:'related_title_clear'});
  assert.deepEqual(checkRelatedInstallment({...input,requestedAliases:['Quiet Country Cafe S2','Quiet Country Cafe S3']}),{state:'related_title_clear'});
});

test('common season annotation layouts cannot bypass explicit same-ID season evidence',()=>{
  const input={anidbId:468,requestedTitle:'Example (2025)',requestedAliases:['Example 2nd Season','Example S2'],related:{state:'related_titles',anidbId:468,items:[{anidbId:424,title:'Example',relation:'Prequel'}]},fileNames:['Example - 01.mkv']};
  for(const tag of ['(S01)','[S01]','Season 01','1st Season','Season I'])assert.deepEqual(checkRelatedInstallment({...input,releaseTitle:`Example ${tag} [1080p]`}),{state:'held',reason:'related_installment_mismatch'},tag);
  assert.deepEqual(checkRelatedInstallment({...input,requestedTitle:'Example Season 2',requestedAliases:['Example S3'],releaseTitle:'Example S03',fileNames:['Example S03E01.mkv']}),{state:'held',reason:'related_installment_mismatch'});
});

test('ordinal season title followed by an episode is not parsed again as a different season',()=>{
  const input={anidbId:18562,requestedTitle:'Kusuriya no Hitorigoto (2025)',requestedAliases:['Kusuriya no Hitorigoto 2nd Season','The Apothecary Diaries S2'],related:{state:'related_titles',anidbId:18562,items:[{anidbId:17870,title:'Kusuriya no Hitorigoto',relation:'Prequel'}]},releaseTitle:'[kikuri] Kusuriya no Hitorigoto 2nd Season (BD 1080p) | The Apothecary Diaries S02',fileNames:['Kusuriya no Hitorigoto 2nd Season - 01 (BD 1080p) [kikuri].mkv']};
  assert.deepEqual(checkRelatedInstallment(input),{state:'related_title_clear'});
});

test('explicit season coordinates keep underscore and bracket delimiters',()=>{
  const input={anidbId:468,requestedTitle:'Example Season 2',related:{state:'related_titles',anidbId:468,items:[{anidbId:424,title:'Example',relation:'Prequel'}]}};
  for(const file of ['Example_S03E01_1080p.mkv','Example_S01E01_1080p.mkv','Example.S01_1080p','Example_Season_01_1080p','Example_1st_Season_1080p'])assert.deepEqual(checkRelatedInstallment({...input,releaseTitle:file,fileNames:[file]}),{state:'held',reason:'related_installment_mismatch'},file);
  assert.deepEqual(checkRelatedInstallment({...input,releaseTitle:'Example_S02E01_1080p.mkv',fileNames:['Example_S02E01_1080p.mkv']}),{state:'related_title_clear'});
});

test('trusted textual season titles do not reinterpret following episode numbers',()=>{
 const cases=[['Example Season 2','Example Second Season'],['Example Final Season','Example Season 4'],['Example Season 2','Example Spring Season'],['Example Season 2','Example 2nd Season Final Season']];
 for(const [requestedTitle,alias]of cases){
  const title=requestedTitle.includes('Final')?requestedTitle:alias;
  const input={anidbId:468,requestedTitle,requestedAliases:[alias],related:{state:'related_titles',anidbId:468,items:[{anidbId:424,title:'Example',relation:'Prequel'}]}};
  for(const file of [`${title} - 01.mkv`,`${title.replaceAll(' ','_')}_-_02.mkv`,`${title}.03.mkv`])assert.deepEqual(checkRelatedInstallment({...input,releaseTitle:alias+' [1080p] [Batch]',fileNames:[file]}),{state:'related_title_clear'},file);
  for(const tag of ['S01E01','Season 01','1st Season'])assert.deepEqual(checkRelatedInstallment({...input,releaseTitle:alias+' [1080p] [Batch]',fileNames:[`${title} ${tag} - 01.mkv`]}),{state:'held',reason:'related_installment_mismatch'},tag);
 }
});

test('a literal title ending Season remains distinct from an explicit season annotation',()=>{
 const input={anidbId:468,requestedTitle:'A Life in Another Season',related:{state:'related_titles',anidbId:468,items:[{anidbId:424,title:'A Life in Another Season Again',relation:'Sequel'}]}};
 assert.deepEqual(checkRelatedInstallment({...input,releaseTitle:'A Life in Another Season [1080p]',fileNames:['A Life in Another Season - 03.mkv']}),{state:'related_title_clear'});
 assert.deepEqual(checkRelatedInstallment({...input,releaseTitle:'A Life in Another Season S02',fileNames:['A Life in Another Season S02E03.mkv']}),{state:'held',reason:'related_installment_mismatch'});
});

test('trusted text never hides conflicting season coordinates inside aliases or release groups',()=>{
 const input={anidbId:468,requestedTitle:'Example Season 2',requestedAliases:['Example Second Season','Example S03 Final Season'],related:{state:'related_titles',anidbId:468,items:[{anidbId:424,title:'Example',relation:'Prequel'}]}};
 for(const file of ['Example S03 Final Season - 01.mkv','[Example Second Season] Example Season 01 - 01.mkv','Other Second Season - 01.mkv'])assert.deepEqual(checkRelatedInstallment({...input,releaseTitle:'Example Season 2 [Batch]',fileNames:[file]}),{state:'held',reason:'related_installment_mismatch'},file);
});

for(const ending of [' (2025)',' [2025]',' 2025'])for(const word of ['Second','Final','Spring'])test(`trusted ${word} Season${ending} protects following episode coordinates only`,()=>{
 const input={anidbId:42,requestedTitle:'Example Season 2',requestedAliases:['Example '+word+' Season'+ending],related:{state:'related_titles',anidbId:42,items:[{anidbId:41,title:'Example',relation:'Prequel'}]},releaseTitle:'Example Season 2 [1080p]'};
 assert.equal(checkRelatedInstallment({...input,fileNames:['Example '+word+' Season - 01.mkv','Example '+word+' Season - 02.mkv']}).state,'related_title_clear');
 for(const tag of ['S01E01','Season 1','1st Season','S03E01'])assert.equal(checkRelatedInstallment({...input,fileNames:['Example '+word+' Season '+tag+' - 01.mkv']}).reason,'related_installment_mismatch');
 assert.equal(checkRelatedInstallment({...input,fileNames:['Other '+word+' Season - 01.mkv']}).state,'held');
});
