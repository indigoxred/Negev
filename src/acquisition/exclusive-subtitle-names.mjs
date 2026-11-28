import path from 'node:path';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

// Exclude only sidecars associated with removed videos and no retained video.
// Recognize direct sidecars and Subs/Subtitles directly below that video's directory.
// Ambiguous or unrelated directories stay selected.
export function exclusiveSubtitleNames(files, excludedVideos, retainedVideos) {
  const stem = name => name.slice(0, -path.posix.extname(name).length);
  const associated = (subtitle, video) => {
    const directory=path.posix.dirname(video),subDirectory=path.posix.dirname(subtitle);
    const local=directory===subDirectory?subtitle:
      path.posix.dirname(subDirectory)===directory && /^(?:subs|subtitles)$/i.test(path.posix.basename(subDirectory))
        ? path.posix.join(directory,path.posix.basename(subtitle)) : null;
    return local!==null && (stem(local)===stem(video)||stem(local).startsWith(stem(video)+'.'));
  };
  return files.filter(file => torrentFileKind(file.name) === 'subtitle' &&
    excludedVideos.some(video => associated(file.name, video)) &&
    !retainedVideos.some(video => associated(file.name, video))).map(file => file.name);
}
