import path from 'node:path';
import { matchesStagingSavePath } from './staging-save-path.mjs';

const STOPPED_STATES = new Set(['stoppedDL', 'pausedDL']);
const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.ts']);
const SUBTITLE = new Set(['.srt', '.ass', '.ssa', '.vtt']);
const PASSIVE_EXCLUDED = new Set(['.txt', '.nfo', '.md5', '.jpg', '.jpeg', '.png', '.webp']);
const held = (reason) => ({ state: 'held', reason });

function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') ||
      /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
      path.posix.isAbsolute(name)) return false;
  return name.split('/').every((part) => part && part !== '.' && part !== '..' &&
    !part.endsWith('.') && !part.endsWith(' '));
}

// Shared extension and path policy for both the stopped and completed gates.
export function torrentFileKind(name) {
  if (!safeName(name)) return null;
  const extension = path.posix.extname(name).toLowerCase();
  if (VIDEO.has(extension)) return 'video';
  if (SUBTITLE.has(extension)) return 'subtitle';
  if (PASSIVE_EXCLUDED.has(extension)) return 'passive';
  return null;
}

// These are standalone, non-episode opening/ending clips. An explicitly
// requested Special remains a video in the file plan; only an unplanned clip
// may be excluded before qBittorrent starts.
export function isOptionalClip(name) {
  if (torrentFileKind(name) !== 'video') return false;
  const stem = path.posix.basename(name, path.posix.extname(name));
  return /(?:^|[ ._-])NC(?:OP|ED)(?:v\d+)?(?=$|[ ._-])/i.test(stem) &&
    !/[Ss]\d{1,3}[Ee]\d{1,4}|(?:^|[ ._-])[Ee]\d{1,4}(?=$|[ ._-])/i.test(stem);
}

// A pre-download, pure file-list gate. This does not prove AniDB registration
// and does not authorize a qBittorrent start or import by itself.
export function evaluateStoppedManifest({ torrent, files, expected,
  allowSelectedPassive = false, plannedFileNames, saveRoot }) {
  if (!matchesStagingSavePath(expected, { saveRoot }) || expected.category !== 'negev') {
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
  const passive = [];
  const planned = plannedFileNames === undefined ? null : new Set(plannedFileNames);
  if (planned && (planned.size !== plannedFileNames.length ||
      plannedFileNames.some((name) => torrentFileKind(name) !== 'video'))) {
    return held('invalid_file_plan');
  }
  for (const file of files) {
    if (!Number.isSafeInteger(file?.index) || file.index < 0 || indexes.has(file.index) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        ![0, 1, 6, 7].includes(file.priority) || file.progress !== 0) {
      return held('invalid_file_manifest');
    }
    indexes.add(file.index);
    const kind = torrentFileKind(file.name);
    if (!kind || names.has(file.name.toLowerCase())) return held('unsafe_file');
    names.add(file.name.toLowerCase());
    if (file.priority === 0) continue;
    const item = { index: file.index, name: file.name, size: file.size };
    if (kind === 'video' && planned && !planned.has(file.name) && isOptionalClip(file.name)) {
      if (!allowSelectedPassive) return held('unexpected_selected_file');
      passive.push(item);
    } else if (kind === 'video') videos.push(item);
    else if (kind === 'subtitle') subtitles.push(item);
    else if (allowSelectedPassive && kind === 'passive') passive.push(item);
    else return held('unexpected_selected_file');
  }
  if (videos.length === 0) return held('no_selected_video');
  if (passive.length > 0) return { state: 'manifest_needs_exclusions', passive };
  return { state: 'manifest_safe',
    videos: videos.sort((a, b) => a.index - b.index),
    subtitles: subtitles.sort((a, b) => a.index - b.index) };
}
