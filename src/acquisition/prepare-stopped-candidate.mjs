import { fetchProwlarrTorrentBytes } from './prowlarr-torrent-bytes.mjs';
import { inspectTorrentMetainfo } from './inspect-torrent-metainfo.mjs';
import { buildStoppedTorrentAddForm } from './qbittorrent-add-form.mjs';

// Server-only preparation. The returned form is never sent here. A future
// dispatcher must first persist one-time intent and verify mount isolation.
export async function prepareStoppedCandidate(options) {
  const retrieved = await fetchProwlarrTorrentBytes(options);
  if (retrieved.state !== 'torrent_bytes') return retrieved;
  const metadata = inspectTorrentMetainfo({ bytes: retrieved.bytes });
  if (metadata.state !== 'metainfo_checked') return metadata;
  const expected = { hash: metadata.hash, category: 'negev', savePath: '/negev-staging' };
  const form = buildStoppedTorrentAddForm({ torrentBytes: retrieved.bytes,
    category: expected.category, savePath: expected.savePath });
  return { state: 'prepared_stopped', expected, version: metadata.version,
    totalBytes: metadata.totalBytes, files: metadata.files, form };
}
