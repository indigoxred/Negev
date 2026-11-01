import path from 'node:path';

const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.ts']);
const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validPath = (value) => typeof value === 'string' && value.length > 0 &&
  value.length <= 4_096 && !value.includes('\\') &&
  !/[\0\r\n]/.test(value) && !value.startsWith('/') &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');
const folderRelativePath = (value) => typeof value === 'string' &&
  value.startsWith('/') && !value.startsWith('//') ? value.slice(1) : value;
const sidecarHash = (relativePath) => {
  const match = /^\.([0-9a-f]{40}|[0-9a-f]{64})\.parts$/i.exec(relativePath);
  return match?.[1].toLowerCase() ?? null;
};

function inactiveSidecar({ file, evidence, qbitImportSavePath, nowMs }) {
  const relativePath = file.relativePath;
  const hash = sidecarHash(relativePath);
  const torrent = evidence?.torrent;
  return hash !== null && evidence.relativePath === relativePath &&
    typeof qbitImportSavePath === 'string' &&
    qbitImportSavePath.startsWith('/') &&
    path.posix.normalize(qbitImportSavePath) === qbitImportSavePath &&
    Number.isSafeInteger(nowMs) && nowMs >= 0 &&
    Number.isSafeInteger(file.modifiedAtMs) && file.modifiedAtMs >= 0 &&
    Number.isSafeInteger(file.changedAtMs) && file.changedAtMs >= 0 &&
    file.modifiedAtMs <= nowMs - 3_600_000 &&
    file.changedAtMs <= nowMs - 3_600_000 &&
    typeof torrent === 'object' && torrent !== null &&
    typeof torrent.hash === 'string' && torrent.hash.toLowerCase() === hash &&
    torrent.state === 'missingFiles' &&
    torrent.save_path === qbitImportSavePath &&
    typeof torrent.category === 'string' && torrent.category !== 'negev' &&
    torrent.progress === 0 && torrent.dlspeed === 0 &&
    torrent.upspeed === 0 && torrent.force_start === false &&
    Number.isSafeInteger(torrent.last_activity) &&
    torrent.last_activity > 0 &&
    torrent.last_activity <= Math.floor(nowMs / 1_000) - 3_600;
}

// A complete folder-scoped Shoko API page must account for each physical
// video already in Import. This is an observed baseline, not proof that a
// future file cannot arrive or that Shoko's queue has settled.
export function classifyShokoImportBaseline({ diskFiles, shokoPage,
  managedFolderId, sidecarTorrents = [], qbitImportSavePath, nowMs } = {}) {
  if (!validId(managedFolderId) || !Array.isArray(diskFiles) ||
      diskFiles.length > 256 || !Array.isArray(shokoPage?.List) ||
      !Array.isArray(sidecarTorrents) || sidecarTorrents.length > 16 ||
      !Number.isSafeInteger(shokoPage.Total) || shokoPage.Total < 0 ||
      shokoPage.Total > 256 || shokoPage.List.length !== shokoPage.Total) {
    return held('incomplete_import_baseline');
  }
  const disk = new Map();
  let passiveFiles = 0;
  const sidecars = new Map();
  for (const evidence of sidecarTorrents) {
    if (!validPath(evidence?.relativePath) ||
        sidecars.has(evidence.relativePath)) return held('invalid_sidecar_evidence');
    sidecars.set(evidence.relativePath, evidence);
  }
  for (const file of diskFiles) {
    if (!validPath(file?.relativePath) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        disk.has(file.relativePath)) return held('invalid_import_file');
    const extension = path.posix.extname(file.relativePath).toLowerCase();
    if (extension === '.nfo') { passiveFiles++; continue; }
    if (extension === '.parts') {
      const evidence = sidecars.get(file.relativePath);
      if (!inactiveSidecar({ file, evidence,
        qbitImportSavePath, nowMs })) return held('active_or_unknown_sidecar');
      sidecars.delete(file.relativePath);
      passiveFiles++;
      continue;
    }
    if (!VIDEO.has(extension)) return held('unrecognized_import_file');
    disk.set(file.relativePath, file.size);
  }
  if (sidecars.size) return held('unmatched_sidecar_evidence');
  const seenIds = new Set();
  const matched = new Set();
  for (const file of shokoPage.List) {
    if (!validId(file?.ID) || seenIds.has(file.ID) ||
        !Number.isSafeInteger(file.Size) || file.Size < 1 ||
        !Array.isArray(file.SeriesIDs) || file.SeriesIDs.length < 1 ||
        !Array.isArray(file.Locations)) return held('unrecognized_shoko_file');
    seenIds.add(file.ID);
    const locations = file.Locations.filter((location) =>
      location?.ManagedFolderID === managedFolderId);
    if (!locations.length) return held('missing_shoko_location');
    for (const location of locations) {
      const relativePath = folderRelativePath(location.RelativePath);
      if (!validPath(relativePath) || location.IsAccessible !== true ||
          matched.has(relativePath) || disk.get(relativePath) !== file.Size) {
        return held('shoko_location_mismatch');
      }
      matched.add(relativePath);
    }
  }
  if (matched.size !== disk.size) return held('unrecognized_import_video');
  return { state: 'recognized_baseline', matchedVideos: matched.size, passiveFiles };
}
