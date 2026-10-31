import path from 'node:path';

const COMPLETE_STATES = new Set(['uploading', 'pausedUP', 'queuedUP', 'stalledUP', 'forcedUP', 'stoppedUP']);
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.ts']);
const held = (reason) => ({ state: 'held', reason });

function safeSelectedVideoName(name) {
  if (typeof name !== 'string' || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name)) return false;
  const parts = name.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') &&
    VIDEO_EXTENSIONS.has(path.posix.extname(parts.at(-1)).toLowerCase());
}

// Pure interpretation of qBittorrent v5 info + files responses. This is
// evidence for a later hash check, not authorization to import or delete data.
export function evaluateCompletion({ torrent, files, expected }) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expected?.hash) ||
      typeof expected.category !== 'string' || !expected.category ||
      typeof expected.savePath !== 'string' || !expected.savePath.startsWith('/')) {
    throw new TypeError('Invalid expected qBittorrent ownership');
  }
  if (!torrent || torrent.hash?.toLowerCase() !== expected.hash.toLowerCase() ||
      torrent.category !== expected.category) return held('wrong_torrent_owner');
  if (torrent.save_path !== expected.savePath) return held('wrong_save_path');
  if (!COMPLETE_STATES.has(torrent.state) || torrent.progress !== 1 || torrent.amount_left !== 0) {
    return held('incomplete');
  }
  if (!Array.isArray(files) || files.length === 0) return held('invalid_file_manifest');

  const selected = [];
  const indexes = new Set();
  const names = new Set();
  for (const file of files) {
    if (!Number.isSafeInteger(file?.index) || file.index < 0 || indexes.has(file.index) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isSafeInteger(file.priority) || file.priority < 0) return held('invalid_file_manifest');
    indexes.add(file.index);
    if (file.priority === 0) continue;
    if (!safeSelectedVideoName(file.name) || names.has(file.name) || file.size === 0) return held('unsafe_selected_file');
    names.add(file.name);
    if (file.progress !== 1 || file.is_seed !== true) return held('incomplete');
    selected.push({ index: file.index, name: file.name, size: file.size });
  }
  if (selected.length === 0) return held('no_selected_video');
  return { state: 'complete', files: selected.sort((a, b) => a.index - b.index) };
}
