// Search titles and tracker counts are hints for selection. Missing stream
// tags do not disprove language suitability; Shoko identifies imported files.
const has = (title, expression) => expression.test(title);
export const hasSeasonPackHint = (candidate) => {
  const title = typeof candidate?.title === 'string' ? candidate.title : '';
  return /\b(?:complete[ ._-]*season|season[ ._-]*\d{1,2}|batch|s\d{1,2})\b|\b0?1\s*[-–]\s*(?:1[0-9]|[2-9]\d?)\b/i.test(title);
};

// An explicit single-episode coordinate cannot cover a completed season.
// Keep title-only and range-labelled releases eligible for metainfo review:
// some older packs do not advertise "batch" or "season" in their title.
export const hasSingleEpisodeHint = (candidate) => {
  const title = typeof candidate?.title === 'string' ? candidate.title : '';
  if (hasSeasonPackHint(candidate)) return false;
  if (/\bS\d{1,2}E\d{1,3}\s*[-–]\s*(?:S\d{1,2}E)?\d{1,3}\b/i.test(title)) return false;
  return /(?:^|[ ._-])S\d{1,2}E\d{1,3}(?:v\d+)?(?=$|[ ._\-[\(])/i.test(title) ||
    /\s[-–]\s0*[1-9]\d{0,2}(?:v\d+)?(?=\s|$|[.\[(])/i.test(title);
};

export const hasTargetEpisodeHint = (candidate, number) => {
  if (!Number.isSafeInteger(number) || number < 1 || number > 9999) return false;
  const title = typeof candidate?.title === 'string' ? candidate.title : '';
  const patterns = [
    /(?:^|[ ._-])S\d{1,2}E(0*[1-9]\d{0,3})(?:v\d+)?(?=$|[ ._\-[\(])/gi,
    /(?:^|[ ._-])E(0*[1-9]\d{0,3})(?:v\d+)?(?=$|[ ._\-[\(])/gi,
    /\s[-–]\s(0*[1-9]\d{0,3})(?:v\d+)?(?=\s|$|[.\[(])/gi,
  ];
  return patterns.some((pattern) => [...title.matchAll(pattern)]
    .some((match) => Number(match[1]) === number));
};

export function assessRelease(candidate) {
  const title = typeof candidate?.title === 'string' ? candidate.title : '';
  const seeders = Number.isSafeInteger(candidate?.seeders) ?
    candidate.seeders : -1;
  const dualAudio = has(title, /\b(?:dual[ ._-]*audio|multi[ ._-]*audio|dual)\b/i);
  const dubOnly = has(title, /\b(?:english|eng)[ ._-]*dub(?:bed)?\b|\bdub[ ._-]*only\b/i) &&
    !dualAudio;
  const noEnglishSubtitles = has(title,
    /\b(?:no[ ._-]*subtitles?|unsubbed|raw[ ._-]*only|sub[ ._-]*french)\b/i);
  const numericResolution=Number(/\b(\d{3,4})p\b/i.exec(title)?.[1]??/\b\d{3,4}x(\d{3,4})\b/i.exec(title)?.[1]??0);
  const fourK = has(title, /\b(?:2160p?|4k|uhd)\b/i)||numericResolution>=2160;
  const bluray = has(title, /\b(?:bd(?:rip|remux)?|blu[ ._-]*ray|bluray)\b/i);
  const allowDub = candidate?.selectionPolicy?.allowEnglishDub === true;
  const allowUhd = candidate?.selectionPolicy?.allowUhd === true;
  const resolution = numericResolution>=240&&numericResolution<=4320?numericResolution:fourK ? 2160 : has(title, /\b1080p?\b|1920x1080/i) ? 1080 :
    has(title, /\b720p?\b|1280x720/i) ? 720 :
      has(title, /\b(?:480|576)p?\b/i) ? 480 : 0;
  const quality = resolution >= 2160 ? (bluray ? 7 : 6) : bluray && resolution >= 1080 ? 5 :
    resolution >= 1080 ? 4 :
      bluray && resolution >= 720 ? 3 :
        resolution >= 720 ? 2 :
          resolution >= 480 ? 1 : 0;
  const subtitleHint = has(title,
    /\b(?:eng(?:lish)?[ ._-]*subs?|multi[ ._-]*subs?|subbed|subsplease|erai[ ._-]*raws)\b/i);
  return {
    eligible: seeders > 0 && (!dubOnly || allowDub) && !noEnglishSubtitles && (!fourK || allowUhd),
    reason: seeders <= 0 ? 'no_reported_seeders' :
      dubOnly && !allowDub ? 'english_dub_only' :
        noEnglishSubtitles ? 'no_english_subtitles' :
          fourK && !allowUhd ? 'outside_quality_profile' : null,
    quality, seeders, healthyPeers: seeders >= 3,
    trusted: candidate?.trusted === true,
    subtitleHint, dualAudio, trackVerified: false,
  };
}

// Recognition may break a tie in this tier, never reverse it. Keep the same
// viability/quality policy in initial ordering and final preview selection.
export function compareReleaseSuitability(left, right) {
  const a = assessRelease(left);
  const b = assessRelease(right);
  if (a.eligible !== b.eligible) return Number(b.eligible) - Number(a.eligible);
  if (a.healthyPeers !== b.healthyPeers) {
    return Number(b.healthyPeers) - Number(a.healthyPeers);
  }
  return b.quality - a.quality;
}

export function compareReleases(left, right, { preferSeasonPack = false } = {}) {
  const a = assessRelease(left);
  const b = assessRelease(right);
  if (a.eligible !== b.eligible) return Number(b.eligible) - Number(a.eligible);
  if (preferSeasonPack && hasSeasonPackHint(left) !== hasSeasonPackHint(right)) {
    return Number(hasSeasonPackHint(right)) - Number(hasSeasonPackHint(left));
  }
  if (left.targetedEpisode !== right.targetedEpisode && !preferSeasonPack) {
    return Number(right.targetedEpisode === true) -
      Number(left.targetedEpisode === true);
  }
  const suitability = compareReleaseSuitability(left, right);
  if (suitability !== 0) return suitability;
  if (a.trusted !== b.trusted) return Number(b.trusted) - Number(a.trusted);
  if (a.subtitleHint !== b.subtitleHint) {
    return Number(b.subtitleHint) - Number(a.subtitleHint);
  }
  if (a.dualAudio !== b.dualAudio) {
    return Number(a.dualAudio) - Number(b.dualAudio);
  }
  if (a.seeders !== b.seeders) return b.seeders - a.seeders;
  if (left.targetedEpisode !== right.targetedEpisode) {
    return Number(right.targetedEpisode === true) -
      Number(left.targetedEpisode === true);
  }
  return (left.size ?? 0) - (right.size ?? 0);
}
