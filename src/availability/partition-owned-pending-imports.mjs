import { evaluateHandoffEvidence } from
  '../acquisition/handoff-evidence.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const ownedPrefix = /^negev-([1-9][0-9]*)-([0-9a-f]{16})$/;
const relative = (value) => typeof value === 'string' &&
  value.length > 0 && value.length <= 4_096 &&
  !value.startsWith('/') && !value.includes('\\') &&
  !/[\x00-\x1f\x7f]/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');
const folderRelative = (value) => typeof value === 'string' &&
  value.startsWith('/') && !value.startsWith('//') ? value.slice(1) : value;

// Only a previously verified, durably published Negev batch with exact
// Shoko ED2K and Import locations can be attributed to another target.
// Manual, partially published or ambiguous files stay in the baseline and
// continue to hold. This is attribution, not proof of Shoko import or Plex.
export function partitionOwnedPendingImports({ diskFiles, shokoPage,
  managedFolderId, getHandoff, target } = {}) {
  if (!Array.isArray(diskFiles) || diskFiles.length > 256 ||
      !Array.isArray(shokoPage?.List) || shokoPage.List.length > 256 ||
      shokoPage.Total !== shokoPage.List.length ||
      !validId(managedFolderId) || typeof getHandoff !== 'function' ||
      !validId(target?.anidbId) || !Array.isArray(target.episodeIds) ||
      target.episodeIds.length < 1 || target.episodeIds.length > 50 ||
      target.episodeIds.some((id) => !validId(id))) {
    throw new TypeError('Invalid pending Import attribution');
  }
  const groups = new Map();
  for (const file of diskFiles) {
    if (!relative(file?.relativePath) || !Number.isSafeInteger(file.size) ||
        file.size < 0) return held('import_inventory_unverified');
    const prefix = file.relativePath.split('/')[0];
    if (!ownedPrefix.test(prefix)) continue;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(file);
  }
  if (groups.size > 16) return held('pending_batch_budget_exceeded');
  const excludedPaths = new Set();
  const excludedIds = new Set();
  const unrelatedPendingKeys = [];
  let unrelatedPending = 0;
  for (const [prefix, files] of groups) {
    const [, rawId, shortDigest] = ownedPrefix.exec(prefix);
    const attemptId = Number(rawId);
    if (!validId(attemptId)) return held('pending_handoff_unverified');
    let handoff;
    try { handoff = getHandoff(attemptId); }
    catch { return held('pending_handoff_unverified'); }
    const manifest = handoff?.manifest;
    const evidence = evaluateHandoffEvidence({ anidbId: manifest?.anidbId,
      torrentHash: manifest?.torrentHash, files: manifest?.videos,
      subtitles: manifest?.subtitles });
    if (handoff?.status !== 'published_observed' ||
        handoff.publishName !== prefix ||
        handoff.evidenceDigest !== evidence.digest ||
        shortDigest !== evidence.digest?.slice(0, 16) ||
        evidence.state !== 'valid') return held('pending_handoff_unverified');
    const expected = [...evidence.manifest.videos,
      ...evidence.manifest.subtitles];
    const actual = new Map(files.map((file) => [file.relativePath, file]));
    if (actual.size !== expected.length || files.length !== expected.length ||
        expected.some((file) => actual.get(`${prefix}/${file.name}`)?.size !==
          file.size)) return held('pending_handoff_tree_changed');
    const rows = new Map();
    for (const file of evidence.manifest.videos) {
      const expectedPath = `${prefix}/${file.name}`;
      const matches = shokoPage.List.filter((row) =>
        row?.Locations?.some((location) =>
          location?.ManagedFolderID === managedFolderId &&
          folderRelative(location.RelativePath) === expectedPath));
      if (matches.length !== 1) return held('pending_shoko_identity_unverified');
      const row = matches[0];
      if (!validId(row.ID) || rows.has(row.ID) ||
          row.Size !== file.size || !Array.isArray(row.SeriesIDs) ||
          row.SeriesIDs.length !== 0 || !Array.isArray(row.Hashes) ||
          !row.Hashes.some((hash) => hash?.Type === 'ED2K' &&
            hash.Value === file.ed2k) ||
          !Array.isArray(row.Locations) || row.Locations.length !== 1 ||
          row.Locations[0].IsAccessible !== true) {
        return held('pending_shoko_identity_unverified');
      }
      rows.set(row.ID, expectedPath);
    }
    if (shokoPage.List.some((row) => row?.Locations?.some((location) =>
      location?.ManagedFolderID === managedFolderId &&
      typeof location.RelativePath === 'string' &&
      folderRelative(location.RelativePath).startsWith(`${prefix}/`) &&
      !rows.has(row.ID)))) return held('pending_shoko_identity_unverified');
    if (manifest.anidbId === target.anidbId &&
        manifest.videos.some((file) => file.episodeIds.some((id) =>
          target.episodeIds.includes(id)))) return held('target_pending_import');
    for (const file of files) excludedPaths.add(file.relativePath);
    for (const id of rows.keys()) excludedIds.add(id);
    for (const path of rows.values()) {
      unrelatedPendingKeys.push(`${managedFolderId}:${path}`);
    }
    unrelatedPending += evidence.manifest.videos.length;
  }
  const List = shokoPage.List.filter((row) => !excludedIds.has(row.ID));
  return { state: 'partitioned',
    diskFiles: diskFiles.filter((file) => !excludedPaths.has(file.relativePath)),
    shokoPage: { Total: List.length, List }, unrelatedPending,
    unrelatedPendingKeys: unrelatedPendingKeys.sort() };
}
