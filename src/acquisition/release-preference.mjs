import { releaseLanguageSuitability, releaseCoverageHint } from '../web/public/release-choice-fields.mjs';
// Search titles and tracker counts are hints for selection. Missing stream
// tags do not disprove language suitability; Shoko identifies imported files.
const has = (title, expression) => expression.test(title);
export const hasSeasonPackHint = candidate => releaseCoverageHint(candidate?.title).kind === 'advertised_pack';
export const hasSingleEpisodeHint = candidate => releaseCoverageHint(candidate?.title).kind === 'single_episode';

export const hasTargetEpisodeHint = (candidate, number) => {
  if (!Number.isSafeInteger(number) || number < 1 || number > 9999) return false;
  const title = typeof candidate?.title === 'string' ? candidate.title : '';
  const patterns = [
    /(?:^|[ ._-])S(?!0{1,2}E)\d{1,2}E(0*[1-9]\d{0,3})(?:v\d+)?(?=$|[ ._\-[\(])/gi,
    /(?:^|[ ._-])E(0*[1-9]\d{0,3})(?:v\d+)?(?=$|[ ._\-[\(])/gi,
    /\s[-–]\s(0*[1-9]\d{0,3})(?:v\d+)?(?=\s|$|[.\[(])/gi,
  ];
  return patterns.some((pattern) => [...title.matchAll(pattern)]
    .some((match) => Number(match[1]) === number));
};

export function assessRelease(candidate) {
  const title = typeof candidate?.title === 'string' ? candidate.title : '';
  const qualityTitle = title.replaceAll('_', ' ');
  const seeders = Number.isSafeInteger(candidate?.seeders) ?
    candidate.seeders : -1;
  const language = releaseLanguageSuitability(title, {
    allowEnglishDub: candidate?.selectionPolicy?.allowEnglishDub === true });
  const dualAudio = language.audio === 'dual';
  const numericResolution=Number(/\b(\d{3,4})p\b/i.exec(qualityTitle)?.[1]??/\b\d{3,4}x(\d{3,4})\b/i.exec(qualityTitle)?.[1]??0);
  const fourK = has(qualityTitle, /\b(?:2160p?|4k|uhd)\b/i)||numericResolution>=2160;
  const bluray = has(qualityTitle, /\b(?:bd(?:rip|remux)?|blu[ ._-]*ray|bluray)\b/i);
  const allowUhd = candidate?.selectionPolicy?.allowUhd === true;
  const resolution = numericResolution>=240&&numericResolution<=4320?numericResolution:fourK ? 2160 : has(qualityTitle, /\b1080p?\b|1920x1080/i) ? 1080 :
    has(qualityTitle, /\b720p?\b|1280x720/i) ? 720 :
      has(qualityTitle, /\b(?:480|576)p?\b/i) ? 480 : 0;
  const quality = resolution >= 2160 ? (bluray ? 7 : 6) : bluray && resolution >= 1080 ? 5 :
    resolution >= 1080 ? 4 :
      bluray && resolution >= 720 ? 3 :
        resolution >= 720 ? 2 :
          resolution >= 480 ? 1 : 0;
  const subtitleHint = has(title,
    /\b(?:eng(?:lish)?[ ._-]*subs?|multi[ ._-]*subs?|subbed|subsplease|erai[ ._-]*raws)\b/i);
  return {
    eligible: seeders > 0 && language.eligible && (!fourK || allowUhd),
    reason: seeders <= 0 ? 'no_reported_seeders' :
      !language.eligible ? language.reason :
        fourK && !allowUhd ? 'outside_quality_profile' : null,
    quality, resolution, seeders, healthyPeers: seeders >= 3,
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
  if (a.quality !== b.quality) return b.quality - a.quality;
  return Number(b.healthyPeers) - Number(a.healthyPeers);
}

// Recognition and preferred-group ties cannot lower the resolution merely
// because an indexer reports three peers instead of two. Source differences
// remain eligible for the explicit better-release comparison.
export function compareReleaseRecognitionTier(left, right) {
  const a = assessRelease(left), b = assessRelease(right);
  if (a.eligible !== b.eligible) return Number(b.eligible)-Number(a.eligible);
  return b.resolution-a.resolution || Number(b.healthyPeers)-Number(a.healthyPeers);
}

export function compareReleases(left, right, { preferSeasonPack = false } = {}) {
  const a = assessRelease(left);
  const b = assessRelease(right);
  if (a.eligible !== b.eligible) return Number(b.eligible) - Number(a.eligible);
  if (preferSeasonPack) {
    const rank=c=>Number(hasSingleEpisodeHint(c));
    if(rank(left)!==rank(right))return rank(left)-rank(right);
  }
  // An episode-title hint helps retrieval and ties. It cannot authorize a
  // quality downgrade: metainfo still has to prove the requested episode.
  const suitability = compareReleaseSuitability(left, right);
  if (suitability !== 0) return suitability;
  if (left.targetedEpisode !== right.targetedEpisode && !preferSeasonPack) {
    return Number(right.targetedEpisode === true) -
      Number(left.targetedEpisode === true);
  }
  if(left.titleHintMatch!==right.titleHintMatch) {
    const relevance=Number(right.titleHintMatch===true)-Number(left.titleHintMatch===true);
    if(relevance)return relevance;
  }
  // An advertised Batch label cannot lower the quality tier of a potential
  // complete pack. Metainfo still decides actual episode coverage.
  if(preferSeasonPack&&hasSeasonPackHint(left)!==hasSeasonPackHint(right)) {
    return Number(hasSeasonPackHint(right))-Number(hasSeasonPackHint(left));
  }
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
