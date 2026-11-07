import { createHash } from 'node:crypto';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = { state: 'held', reason: 'invalid_handoff_evidence' };
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// Canonical private manifest for crash recovery. It describes exact bytes and
// provider identities, but does not itself prove those bytes exist on disk.
export function evaluateHandoffEvidence(input, { maxVideoBytes = 64 * 1024 ** 3 } = {}) {
  if (!Number.isSafeInteger(maxVideoBytes) || maxVideoBytes < 1 ||
      maxVideoBytes > 1024 ** 4) throw new TypeError('Invalid handoff byte budget');
  const provisional = input?.identity === 'provisional';
  if (!Number.isSafeInteger(input?.anidbId) || input.anidbId < 1 ||
      (input.identity !== undefined && !provisional) ||
      (input.version !== undefined && input.version !== (provisional ? 2 : 1)) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input.torrentHash) ||
      !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 50 ||
      !Array.isArray(input.subtitles) || input.subtitles.length > 50) return held;
  const names = new Set();
  const fileIds = new Set();
  const episodeIds = new Set();
  const subtitleIndexes = new Set();
  let videoBytes = 0;
  let subtitleBytes = 0;
  const videos = [];
  const subtitles = [];
  for (const file of input.files) {
    if (torrentFileKind(file?.name) !== 'video' || names.has(file.name.toLowerCase()) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        (provisional ? Object.hasOwn(file, 'anidbFileId') :
          !Number.isSafeInteger(file.anidbFileId) || file.anidbFileId < 1 ||
            fileIds.has(file.anidbFileId)) ||
        !/^[0-9A-F]{32}$/.test(file.ed2k) ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length < 1 ||
        file.episodeIds.some((id) => !Number.isSafeInteger(id) || id < 1 ||
          episodeIds.has(id)) ||
        new Set(file.episodeIds).size !== file.episodeIds.length) return held;
    names.add(file.name.toLowerCase());
    if (!provisional) fileIds.add(file.anidbFileId);
    for (const id of file.episodeIds) episodeIds.add(id);
    videoBytes += file.size;
    if (!Number.isSafeInteger(videoBytes) || videoBytes > maxVideoBytes) return held;
    videos.push({ name: file.name, size: file.size, ed2k: file.ed2k,
      ...(!provisional ? { anidbFileId: file.anidbFileId } : {}),
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
  const manifest = { version: provisional ? 2 : 1,
    ...(provisional ? { identity: 'provisional' } : {}),
    torrentHash: input.torrentHash.toLowerCase(),
    anidbId: input.anidbId, videos: videos.sort(byName),
    subtitles: subtitles.sort(byName) };
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { state: 'valid', manifest, digest };
}
