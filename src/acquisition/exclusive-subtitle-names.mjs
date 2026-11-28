import path from 'node:path';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

// Exclude only sidecars associated with removed videos and no retained video.
// Keep the existing exact-directory rule; ambiguous associations stay selected.
export function exclusiveSubtitleNames(files, excludedVideos, retainedVideos) {
  const stem = name => name.slice(0, -path.posix.extname(name).length);
  const associated = (subtitle, video) => stem(subtitle) === stem(video) ||
    stem(subtitle).startsWith(stem(video) + '.');
  return files.filter(file => torrentFileKind(file.name) === 'subtitle' &&
    excludedVideos.some(video => associated(file.name, video)) &&
    !retainedVideos.some(video => associated(file.name, video))).map(file => file.name);
}
