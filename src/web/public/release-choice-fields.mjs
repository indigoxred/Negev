// Advertised hints only. These do not establish the downloaded tracks or
// AniDB registration; those facts remain separate from release selection.
export const DEFAULT_RELEASE_FILTERS = Object.freeze({ quality: 'bd1080', audio: 'japanese' });
export function validReleaseFilters(value) {
  return value && ['bd1080','1080','720','bd','all'].includes(value.quality) &&
    ['japanese','japanese_dual','dual','english'].includes(value.audio);
}
export function releaseFacts(title = '') {
  const source = /\b(?:BD(?:rip|remux)?|Blu[ ._-]?ray)\b/i.test(title) ? 'BD' :
    /\bDVD(?:rip)?\b/i.test(title) ? 'DVD' : /\bWEB(?:[ ._-]?DL|rip)?\b/i.test(title) ? 'WEB' : null;
  const namedResolution = /\b(?:2160p?|4k|UHD)\b|3840x2160/i.test(title) ? 2160 :
    /\b1080p?\b|1920x1080/i.test(title) ? 1080 : /\b720p?\b|1280x720/i.test(title) ? 720 :
      /\b(?:480|576)p?\b|(?:640|720)x480/i.test(title) ? 480 : null;
  const numeric = Number(/\b(\d{3,4})p\b/i.exec(title)?.[1] ?? /\b\d{3,4}x(\d{3,4})\b/i.exec(title)?.[1] ?? 0);
  const resolution = Math.max(namedResolution ?? 0,numeric >= 240 && numeric <= 4320 ? numeric : 0) || null;
  const languageTitle = title.replaceAll('_', ' ');
  const dual = /\b(?:dual[ ._-]*audio|multi[ ._-]*audio|dual)\b/i.test(languageTitle);
  const english = /\b(?:english|eng)[ ._-]*(?:dub(?:bed)?|audio)\b|\b(?:dub(?:bed)?|audio)[ ._-]*in[ ._-]+(?:english|eng)\b|\bdub[ ._-]*only\b/i.test(languageTitle);
  const otherLanguage = '(?:russian|rus|french|german|spanish|italian|portuguese|hindi|tamil|telugu|ukrainian|korean|chinese)';
  const other = new RegExp('\\b'+otherLanguage+'[ ._-]*(?:dub(?:bed)?|audio)\\b|\\b(?:dub(?:bed)?|audio)[ ._-]*in[ ._-]+'+otherLanguage+'\\b','i').test(languageTitle);
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
export function releaseLanguageSuitability(title, { allowEnglishDub = false } = {}) {
  title = (typeof title === 'string' ? title : '').replaceAll('_', ' ');
  const facts = releaseFacts(title);
  const noEnglish = /\b(?:no[ ._-]*(?:(?:eng|english)[ ._-]*)?(?:subs?|subtitles?)|unsubbed|raw[ ._-]*only)\b/i.test(title) ||
    /\bsub[ ._-]*french\b/i.test(title) && !/\b(?:eng(?:lish)?[ ._-]*subs?|multi[ ._-]*subs?)\b/i.test(title);
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
