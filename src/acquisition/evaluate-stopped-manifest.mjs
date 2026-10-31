import path from 'node:path';

const STOPPED_STATES = new Set(['stoppedDL', 'pausedDL']);
const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.ts']);
const SUBTITLE = new Set(['.srt', '.ass', '.ssa', '.vtt']);
const PASSIVE_EXCLUDED = new Set(['.txt', '.nfo', '.jpg', '.jpeg', '.png', '.webp']);
const held = (reason) => ({ state: 'held', reason });

function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') ||
      /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
      path.posix.isAbsolute(name)) return false;
  return name.split('/').every((part) => part && part !== '.' && part !== '..' &&
    !part.endsWith('.') && !part.endsWith(' '));
}

// A pre-download, pure file-list gate. This does not prove AniDB registration
// and does not authorize a qBittorrent start or import by itself.
export function evaluateStoppedManifest({ torrent, files, expected }) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expected?.hash) ||
      expected.category !== 'negev' || expected.savePath !== '/negev-staging') {
    throw new TypeError('Invalid stopped-torrent expectation');
  }
  if (!torrent || torrent.hash?.toLowerCase() !== expected.hash.toLowerCase() ||
      torrent.category !== expected.category) return held('wrong_torrent_owner');
  if (torrent.save_path !== expected.savePath) return held('wrong_save_path');
  if (!STOPPED_STATES.has(torrent.state) || torrent.progress !== 0 || torrent.downloaded !== 0 ||
      torrent.auto_tmm !== false || torrent.force_start !== false) {
    return held('not_pristine_stopped');
  }
  if (!Array.isArray(files) || files.length < 1 || files.length > 500) return held('invalid_file_manifest');

  const indexes = new Set();
  const names = new Set();
  const videos = [];
  const subtitles = [];
  for (const file of files) {
    if (!Number.isSafeInteger(file?.index) || file.index < 0 || indexes.has(file.index) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        ![0, 1, 6, 7].includes(file.priority) || file.progress !== 0) {
      return held('invalid_file_manifest');
    }
    indexes.add(file.index);
    if (!safeName(file.name) || names.has(file.name.toLowerCase())) return held('unsafe_file');
    names.add(file.name.toLowerCase());
    const extension = path.posix.extname(file.name).toLowerCase();
    if (!VIDEO.has(extension) && !SUBTITLE.has(extension) &&
        !PASSIVE_EXCLUDED.has(extension)) return held('unsafe_file');
    if (file.priority === 0) continue;
    const item = { index: file.index, name: file.name, size: file.size };
    if (VIDEO.has(extension)) videos.push(item);
    else if (SUBTITLE.has(extension)) subtitles.push(item);
    else return held('unexpected_selected_file');
  }
  if (videos.length === 0) return held('no_selected_video');
  return { state: 'manifest_safe',
    videos: videos.sort((a, b) => a.index - b.index),
    subtitles: subtitles.sort((a, b) => a.index - b.index) };
}
