const language = (track) => typeof track?.Language === 'string' ?
  track.Language.trim().toLowerCase() : '';
const isJapanese = (track) => /^(?:ja|jpn)(?:-|$)/.test(language(track));
const isEnglish = (track) => /^(?:en|eng)(?:-|$)/.test(language(track));
const height = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
};
const measuredFullSubtitle = (track, video) => {
  const videoSeconds = Number(video.Duration);
  const subtitleSeconds = Number(track.Duration);
  const lines = Number(track.ElementCount);
  return Number.isFinite(videoSeconds) && videoSeconds >= 120 &&
    Number.isFinite(subtitleSeconds) &&
    subtitleSeconds >= videoSeconds * 0.8 &&
    Number.isSafeInteger(lines) &&
    lines >= Math.max(12, Math.ceil(videoSeconds * 0.07));
};

// Only embedded, language-tagged full subtitles count here. A release name,
// fansub group, untagged stream, or English signs track is not proof.
export function evaluateMediaTracks(tracks, { externalEnglishSubtitle = false } = {}) {
  if (!Array.isArray(tracks) || tracks.length < 2 ||
      tracks.some((track) => !track || typeof track !== 'object')) {
    return { state: 'unverified', reason: 'tracks_unavailable' };
  }
  const videos = tracks.filter((track) => track['@type'] === 'Video');
  const audios = tracks.filter((track) => track['@type'] === 'Audio');
  const subtitles = tracks.filter((track) => track['@type'] === 'Text');
  if (videos.length !== 1 || audios.length < 1) {
    return { state: 'unverified', reason: 'tracks_unavailable' };
  }
  const resolution = height(videos[0].Height);
  if (!resolution) return { state: 'rejected', reason: 'resolution_unavailable' };
  if (resolution > 1080 || resolution < 400) {
    return { state: 'rejected', reason: 'outside_quality_profile' };
  }
  if (!audios.some(isJapanese)) {
    return audios.every((track) => !language(track)) ?
      { state: 'rejected', reason: 'audio_language_unverified' } :
      { state: 'rejected', reason: 'japanese_audio_missing' };
  }
  const fullEnglish = externalEnglishSubtitle || subtitles.some((track) => {
    if (!isEnglish(track)) return false;
    const title = String(track.Title ?? '');
    if (/\b(?:commentary|forced|dubtitle)\b/i.test(title)) return false;
    if (/\b(?:dialogue|full|complete|subtitles?)\b/i.test(title)) return true;
    if (/\b(?:signs?|songs?)\b/i.test(title)) return false;
    if (measuredFullSubtitle(track, videos[0])) return true;
    // A Japanese-only release can default to another language while its
    // identified, unforced English translation remains a valid selection.
    // Keep anonymous secondary tracks and dual-audio signs uncertain.
    return track.Forced !== 'Yes' && (
      (track.Default === 'Yes' && audios.every(isJapanese)) ||
      (audios.every(isJapanese) && title.trim().length > 0 &&
        subtitles.some((other) => other !== track &&
          !isEnglish(other) && other.Default === 'Yes')) ||
      (track.Default === 'Yes' && subtitles.some((other) =>
        other !== track && isEnglish(other) && other.Forced === 'Yes')));
  });
  if (!fullEnglish) {
    return subtitles.some((track) => isEnglish(track) &&
      !/\b(?:signs?|songs?|forced|dubtitle)\b/i.test(String(track.Title ?? '')))
      ? { state: 'unverified', reason: 'subtitle_coverage_unverified' }
      : { state: 'rejected', reason: 'english_full_subtitles_missing' };
  }
  return { state: 'accepted',
    audio: audios.some(isEnglish) ? 'dual' : 'japanese', resolution };
}
