import { createHash } from 'node:crypto';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = { state: 'held', reason: 'invalid_handoff_evidence' };
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// Canonical private manifest for crash recovery. It describes exact bytes and
// provider identities, but does not itself prove those bytes exist on disk.
export function evaluateHandoffEvidence(input, { maxVideoBytes = 64 * 1024 ** 3 } = {}) {
  if (!Number.isSafeInteger(maxVideoBytes) || maxVideoBytes < 1 ||
      maxVideoBytes > 1024 ** 4) throw new TypeError('Invalid handoff byte budget');
  if (!Number.isSafeInteger(input?.anidbId) || input.anidbId < 1 ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input.torrentHash) ||
      !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 50 ||
      !Array.isArray(input.subtitles) || input.subtitles.length > 50) return held;
  const names = new Set();
  const fileIds = new Set();
  const releaseIds = new Set();
  const hashes = new Set();
  const episodeIds = new Set();
  const subtitleIndexes = new Set();
  let videoBytes = 0;
  let subtitleBytes = 0;
  const videos = [];
  const subtitles = [];
  const version = input.files.some((file) => file?.identitySource !== undefined ||
    file?.releaseId !== undefined) ? 2 : 1;
  for (const file of input.files) {
    const source = version === 1 ? 'anidb' : file?.identitySource;
    const anidbFile = source === 'anidb' &&
      Number.isSafeInteger(file?.anidbFileId) && file.anidbFileId > 0 &&
      file.releaseId === undefined && !fileIds.has(file.anidbFileId);
    const offlineFile = source === 'shoko_offline' &&
      file?.anidbFileId === undefined &&
      file.episodeIds?.length === 1 &&
      file.releaseId === `offline://${input.anidbId}-${file.episodeIds[0]}` &&
      !releaseIds.has(file.releaseId);
    if (torrentFileKind(file?.name) !== 'video' || names.has(file.name.toLowerCase()) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        (version === 2 && !['anidb', 'shoko_offline'].includes(source)) ||
        (!anidbFile && !offlineFile) ||
        !/^[0-9A-F]{32}$/.test(file.ed2k) ||
        (version === 2 && hashes.has(file.ed2k)) ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length < 1 ||
        file.episodeIds.some((id) => !Number.isSafeInteger(id) || id < 1 ||
          episodeIds.has(id)) ||
        new Set(file.episodeIds).size !== file.episodeIds.length) return held;
    names.add(file.name.toLowerCase());
    if (anidbFile) fileIds.add(file.anidbFileId);
    else releaseIds.add(file.releaseId);
    hashes.add(file.ed2k);
    for (const id of file.episodeIds) episodeIds.add(id);
    videoBytes += file.size;
    if (!Number.isSafeInteger(videoBytes) || videoBytes > maxVideoBytes) return held;
    videos.push(version === 1
      ? { name: file.name, size: file.size, ed2k: file.ed2k,
        anidbFileId: file.anidbFileId,
        episodeIds: [...file.episodeIds].sort((a, b) => a - b) }
      : { name: file.name, size: file.size, ed2k: file.ed2k,
        identitySource: source,
        ...(anidbFile ? { anidbFileId: file.anidbFileId }
          : { releaseId: file.releaseId }),
        episodeIds: [...file.episodeIds].sort((a, b) => a - b) });
  }
  for (const file of input.subtitles) {
    if (torrentFileKind(file?.name) !== 'subtitle' || names.has(file.name.toLowerCase()) ||
        !Number.isSafeInteger(file.index) || file.index < 0 ||
        subtitleIndexes.has(file.index) ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 ** 2 ||
        !/^[0-9A-F]{64}$/.test(file.sha256)) return held;
    names.add(file.name.toLowerCase());
    subtitleIndexes.add(file.index);
    subtitleBytes += file.size;
    if (subtitleBytes > 64 * 1024 ** 2) return held;
    subtitles.push({ index: file.index, name: file.name, size: file.size,
      sha256: file.sha256 });
  }
  const manifest = { version, torrentHash: input.torrentHash.toLowerCase(),
    anidbId: input.anidbId, videos: videos.sort(byName),
    subtitles: subtitles.sort(byName) };
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { state: 'valid', manifest, digest };
}
