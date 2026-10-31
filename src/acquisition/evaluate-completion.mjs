import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const COMPLETE_STATES = new Set(['uploading', 'pausedUP', 'queuedUP', 'stalledUP', 'forcedUP', 'stoppedUP']);
const held = (reason) => ({ state: 'held', reason });

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
  if (torrent.auto_tmm !== false || torrent.force_start !== false) return held('wrong_torrent_owner');
  if (!COMPLETE_STATES.has(torrent.state) || torrent.progress !== 1 || torrent.amount_left !== 0) {
    return held('incomplete');
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > 500) return held('invalid_file_manifest');

  const selected = [];
  const subtitles = [];
  const indexes = new Set();
  const names = new Set();
  for (const file of files) {
    if (!Number.isSafeInteger(file?.index) || file.index < 0 || indexes.has(file.index) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        ![0, 1, 6, 7].includes(file.priority)) return held('invalid_file_manifest');
    indexes.add(file.index);
    const kind = torrentFileKind(file.name);
    if (!kind || names.has(file.name.toLowerCase())) {
      return held(file.priority === 0 ? 'unsafe_file' : 'unsafe_selected_file');
    }
    names.add(file.name.toLowerCase());
    if (file.priority === 0) continue;
    if (kind === 'passive') return held('unsafe_selected_file');
    if (file.progress !== 1 || file.is_seed !== true) return held('incomplete');
    const item = { index: file.index, name: file.name, size: file.size };
    if (kind === 'video') selected.push(item);
    else subtitles.push(item);
  }
  if (selected.length === 0) return held('no_selected_video');
  return { state: 'complete', files: selected.sort((a, b) => a.index - b.index),
    subtitles: subtitles.sort((a, b) => a.index - b.index) };
}
