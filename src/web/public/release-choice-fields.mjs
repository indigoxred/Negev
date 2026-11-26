// Advertised hints only. These do not establish the downloaded tracks or
// AniDB registration; those facts remain separate from release selection.
export const DEFAULT_RELEASE_FILTERS = Object.freeze({ quality: 'bd1080', audio: 'japanese_dual' });
export function validReleaseFilters(value) {
  return value && ['bd1080','1080','720','bd','all'].includes(value.quality) &&
    ['japanese','japanese_dual','dual','english'].includes(value.audio) &&
    (value.packsOnly === undefined || typeof value.packsOnly === 'boolean');
}
// Advertised title coverage is separate from metainfo-checked episode coverage.
export function releaseCoverageHint(title = '') {
  title = typeof title === 'string' ? title.replaceAll('_',' ') : '';
  const ranges=[...title.matchAll(/(?:^|[ ._(-])(?:S\d{1,2})?E?(\d{1,4})(?:v\d+)?\s*[-–]\s*(?:S\d{1,2})?E?(\d{1,4})(?:v\d+)?(?=$|[ ._\[\]()])/gi)];
  if(ranges.some(m=>!/\bSeason\s*$/i.test(title.slice(0,m.index))&&Number(m[1])>0&&Number(m[2])>Number(m[1])&&Number(m[2])<=9999&&
    !(Number(m[1])>=1900&&Number(m[2])<=2100)))return {kind:'advertised_pack'};
  const coordinate=/(?:^|[ ._-])S\d{1,2}[ ._-]*E(\d{1,4})(?:v\d+)?(?=$|[ ._\[\]()])/i.exec(title)?.[1]??
    /(?:^|[ ._-])E(?:pisode[ ._-]*)?(\d{1,4})(?:v\d+)?(?=$|[ ._\[\]()])/i.exec(title)?.[1]??
    /\s[-–]\s(\d{1,4})(?:v\d+)?(?=$|[ ._\[\]()])/i.exec(title)?.[1];
  if(coordinate&&Number(coordinate)>0)return {kind:'single_episode',episodeNumber:Number(coordinate)};
  return /\b(?:complete(?:[ ._-]*season)?|season[ ._-]*\d{1,2}|batch|s\d{1,2})\b/i.test(title)
    ? {kind:'advertised_pack'} : {kind:'unknown'};
}

export function releaseFacts(title = '') {
  const qualityTitle = title.replaceAll('_', ' ');
  const source = /\b(?:BD(?:rip|remux)?|Blu[ ._-]?ray)\b/i.test(qualityTitle) ? 'BD' :
    /\bDVD(?:rip)?\b/i.test(qualityTitle) ? 'DVD' : /\bWEB(?:[ ._-]?DL|rip)?\b/i.test(qualityTitle) ? 'WEB' : null;
  const namedResolution = /\b(?:2160p?|4k|UHD)\b|3840x2160/i.test(qualityTitle) ? 2160 :
    /\b1080p?\b|1920x1080/i.test(qualityTitle) ? 1080 : /\b720p?\b|1280x720/i.test(qualityTitle) ? 720 :
      /\b(?:480|576)p?\b|(?:640|720)x480/i.test(qualityTitle) ? 480 : null;
  const numeric = Number(/\b(\d{3,4})p\b/i.exec(qualityTitle)?.[1] ?? /\b\d{3,4}x(\d{3,4})\b/i.exec(qualityTitle)?.[1] ?? 0);
  const resolution = Math.max(namedResolution ?? 0,numeric >= 240 && numeric <= 4320 ? numeric : 0) || null;
  const languageTitle = title.replaceAll('_', ' ');
  const dual = /\b(?:dual[ ._-]*audio|multi[ ._-]*audio|dual)\b/i.test(languageTitle);
  const english = /\b(?:english|eng)[ ._-]*(?:dub(?:bed)?|audio)\b|\b(?:dub(?:bed)?|audio)[ ._-]*in[ ._-]+(?:english|eng)\b|\bdub[ ._-]*only\b/i.test(languageTitle);
  const otherLanguage = '(?:russian|rus|french|german|spanish|italian|portuguese|hindi|tamil|telugu|ukrainian|korean|chinese)';
  const annotationTitle=languageTitle.replace(/^\s*\[[^\]\r\n]{1,120}\]\s*(?=\S)/u,'');
  const languageAnnotation = new RegExp('(?:\\(|\\[)\\s*'+otherLanguage+'\\s*(?:\\)|\\])','i').test(annotationTitle);
  const other = languageAnnotation && !dual || new RegExp('\\b'+otherLanguage+'[ ._-]*(?:dub(?:bed)?|audio)\\b|\\b(?:dub(?:bed)?|audio)[ ._-]*in[ ._-]+'+otherLanguage+'\\b','i').test(languageTitle);
  const explicitJapanese = /\b(?:japanese|jpn)[ ._-]*(?:audio|dub(?:bed)?)\b|\b(?:audio|dub(?:bed)?)[ ._-]*in[ ._-]+(?:japanese|jpn)\b/i.test(languageTitle);
  const audio = other && !explicitJapanese ? 'other' :
    (dual || english && explicitJapanese) ? 'dual' : english ? 'english' : explicitJapanese ? 'japanese' : 'unknown';
  const bracket = [...title.matchAll(/\[([^\]]{1,80})\]/g)].map(m => m[1].trim()).find(value =>
    !/^[a-f0-9]{8}$/i.test(value) &&
    !/^(?:\d{3,4}p|BD|Blu[ ._-]?ray|DVD|WEB|HEVC|AVC|AV1|x26[45]|H[ .]?26[45]|AAC|FLAC|OPUS|AC3|DTS|dual|multi|eng(?:lish)?|jpn|japanese|subs?|[0-9]+bit)(?:\b|[ ._-])/i.test(value));
  const suffix = /-([A-Za-z][A-Za-z0-9._]{1,59})(?=\s*(?:\(|$))/.exec(title)?.[1];
  const group = bracket ?? suffix ?? null;
  return { source, resolution, group, audio,
    audioLabel: audio === 'dual' ? 'JP+EN*' : audio === 'english' ? 'EN dub*' :
      audio === 'japanese' ? 'JP*' : audio === 'other' ? 'Other*' : 'Not specified' };
}
// Shared explicit-language policy. Missing tags and burned-in subtitles remain
// unknown hints, not a reason to reject an otherwise suitable release.
// Only an explicit subtitle-language exclusion is negative evidence. A
// foreign track alongside English, multi-subs or absent tags is not an exclusion.
function subtitleLanguageDeclarations(title) {
  title=title.normalize('NFKD').replace(/\p{M}/gu,'');
  const languages=new Set('english eng en japanese jpn jap ja german deutsch deu ger de french francais fra fre fr spanish espanol spa esp es russian rus ru italian ita it portuguese por pt hindi hin tamil tam telugu tel ukrainian ukr korean kor ko chinese chi zho zh polish pol pl arabic ara ar'.split(' '));
  const modifiers=new Set('sdh cc closed captions hearing impaired full forced signs songs'.split(' '));
  // Capture the complete field, including unknown languages/modifiers. A
  // recognised suffix after an unknown list member cannot prove exclusion.
  const before=/([^\[\]\r\n:;()]+?)[ ._-]+(?:subs?|subtitles?)\b([ ._-]+only\b)?/gi;
  const after=/\b(only[ ._-]+)?(?:subs?|subtitles?)[ ._:-]+([^\[\]\r\n:;()]+?)(?:[ ._-]+(only)\b|(?=$|[\[\]\r\n:;()]))/gi;
  const fields=[...title.matchAll(before)].map(m=>({text:m[1],complete:m.index>0&&'[('.includes(title[m.index-1]),only:Boolean(m[2])||/^\s*only\b/i.test(m[1])}));
  fields.push(...[...title.matchAll(after)].map(m=>({text:m[2],complete:true,only:Boolean(m[1]||m[3])})));
  let includesEnglish=false,excludesEnglish=false;
  for(const field of fields){
    const units=field.text.replace(/[._-]/g,' ').split(/\s*(?:[/,+&]|\band\b)\s*/i);
    let known=true,english=false,hasLanguage=false;
    for(const [i,unit] of units.entries()){
      let words=unit.toLowerCase().match(/[a-z]+/g)??[];
      if(i===0){
        // Unbracketed titles can precede a declaration. Audio is a separate
        // field: English audio must never imply English subtitles.
        const audio=Math.max(words.lastIndexOf('audio'),words.lastIndexOf('dub'),words.lastIndexOf('dubbed'));
        if(audio>=0)words=words.slice(audio+1);
        const only=words.lastIndexOf('only');
        if(only>=0&&languages.has(words[only+1]))field.only=true;
        words=words.filter(w=>w!=='only');
        const start=words.findIndex(w=>languages.has(w));
        if(start>=0&&!field.complete)words=words.slice(start);
      }
      if(!words.length){known=false;continue;}
      for(const word of words){
        if(languages.has(word)){hasLanguage=true;if(['english','eng','en'].includes(word))english=true;}
        else if(!modifiers.has(word)&&word!=='only')known=false;
      }
    }
    includesEnglish ||= english;
    excludesEnglish ||= field.only&&hasLanguage&&known&&!english;
  }
  return {excludesEnglish,includesEnglish};
}
export function releaseLanguageSuitability(title, { allowEnglishDub = false } = {}) {
  title = (typeof title === 'string' ? title : '').replaceAll('_', ' ');
  const facts = releaseFacts(title);
  const subtitles=subtitleLanguageDeclarations(title);
  const noEnglish = subtitles.excludesEnglish || /\b(?:no[ ._-]*(?:(?:eng|english)[ ._-]*)?(?:subs?|subtitles?)|unsubbed|raw[ ._-]*only)\b/i.test(title) ||
    /\bsub[ ._-]*french\b/i.test(title) && !subtitles.includesEnglish && !/\b(?:eng(?:lish)?[ ._-]*subs?|multi[ ._-]*subs?)\b/i.test(title);
  const reason = noEnglish ? 'no_english_subtitles' : facts.audio === 'other'
    ? 'incompatible_audio' : facts.audio === 'english' && !allowEnglishDub ? 'english_dub_only' : null;
  return { eligible: reason === null, reason, audio: facts.audio };
}
export function matchesReleaseFilters(candidate, filters = DEFAULT_RELEASE_FILTERS) {
  if (!validReleaseFilters(filters)) return false;
  const facts = releaseFacts(candidate?.title);
  const quality = filters.quality === 'all' ||
    filters.quality === 'bd' && facts.source === 'BD' ||
    filters.quality === 'bd1080' && (facts.source === 'BD' || facts.resolution >= 1080) ||
    filters.quality === '1080' && facts.resolution >= 1080 ||
    filters.quality === '720' && facts.resolution >= 720;
  const audio = filters.audio === 'english' ? facts.audio === 'english' :
    filters.audio === 'dual' ? facts.audio === 'dual' :
      filters.audio === 'japanese_dual' ? ['japanese','unknown','dual'].includes(facts.audio) :
        ['japanese','unknown'].includes(facts.audio);
  return quality && audio && releaseLanguageSuitability(candidate?.title ?? '',
    { allowEnglishDub: filters.audio === 'english' }).eligible;
}
