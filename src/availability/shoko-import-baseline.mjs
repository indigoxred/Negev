import path from 'node:path';

const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.ts']);
const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validPath = (value) => typeof value === 'string' && value.length > 0 &&
  value.length <= 4_096 && !value.includes('\\') &&
  !/[\0\r\n]/.test(value) && !value.startsWith('/') &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');

// A complete folder-scoped Shoko API page must account for each physical
// video already in Import. This is an observed baseline, not proof that a
// future file cannot arrive or that Shoko's queue has settled.
export function classifyShokoImportBaseline({ diskFiles, shokoPage,
  managedFolderId } = {}) {
  if (!validId(managedFolderId) || !Array.isArray(diskFiles) ||
      diskFiles.length > 256 || !Array.isArray(shokoPage?.List) ||
      !Number.isSafeInteger(shokoPage.Total) || shokoPage.Total < 0 ||
      shokoPage.Total > 256 || shokoPage.List.length !== shokoPage.Total) {
    return held('incomplete_import_baseline');
  }
  const disk = new Map();
  let passiveFiles = 0;
  for (const file of diskFiles) {
    if (!validPath(file?.relativePath) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        disk.has(file.relativePath)) return held('invalid_import_file');
    const extension = path.posix.extname(file.relativePath).toLowerCase();
    if (extension === '.nfo') { passiveFiles++; continue; }
    if (!VIDEO.has(extension)) return held('unrecognized_import_file');
    disk.set(file.relativePath, file.size);
  }
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
      const relativePath = location.RelativePath;
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
