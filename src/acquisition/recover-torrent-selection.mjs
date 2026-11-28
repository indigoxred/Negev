import { cancelResponseBody, readBoundedBytes } from '../http/bounded-response.mjs';
import { MAX_TORRENT_METAINFO_BYTES } from './torrent-metainfo-limits.mjs';
import { inspectTorrentMetainfo } from './inspect-torrent-metainfo.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { qbittorrentSessionCookie } from './qbittorrent-session-cookie.mjs';

const held = reason => ({ state: 'held', reason });

// Upgrade path for an older stopped add without a descriptor journal. Export
// only the already-owned hash; never infer a descriptor from observed names.
export async function recoverTorrentSelection({ acquisitions, attemptId, expected,
  plan, qbittorrent, fetchImpl }) {
  const url = new URL('/api/v2/torrents/export', qbittorrent.baseUrl);
  url.searchParams.set('hash', expected.hash);
  let metadata;
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Cookie: qbittorrentSessionCookie(qbittorrent.sessionId) },
      signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) {
      await cancelResponseBody(response);
      return held(response.status === 403 ? 'provider_http_403' : 'provider_unavailable');
    }
    metadata = inspectTorrentMetainfo({ bytes: await readBoundedBytes(response, MAX_TORRENT_METAINFO_BYTES) });
  } catch { return held('provider_unavailable'); }
  if (metadata.state !== 'metainfo_checked' || metadata.hash !== expected.hash.toLowerCase()) {
    return held('torrent_conflict');
  }
  if (metadata.files.some(file => !['video', 'subtitle', 'passive'].includes(torrentFileKind(file.name)))) {
    return held('unsafe_file');
  }
  const byName = new Map(metadata.files.map(file => [file.name, file]));
  if (!plan?.length || plan.some(file => byName.get(file.name)?.size !== file.size)) return held('file_plan_mismatch');
  const plannedNames = new Set(plan.map(file => file.name));
  return { state: 'selection_recovered', files: metadata.files,
    excludedFileNames: metadata.files.filter(file => torrentFileKind(file.name) === 'video' &&
      !plannedNames.has(file.name)).map(file => file.name) };
}
