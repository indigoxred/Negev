import { lstat } from 'node:fs/promises';
import { localPath, validMount } from '../availability/known-card-availability.mjs';
import { cancelResponseBody, readBoundedJson } from '../http/bounded-response.mjs';

// Availability for the same episode can belong to another release. Before
// using a stored Shoko hash, require the inode captured during this torrent's
// pure move. Only metadata/stat calls; never read or hash the media again.
export async function readPreviouslyVerifiedFile({ prior, baseUrl, apiKey,
  shokoMount, signal, fetchImpl = fetch, statImpl = lstat } = {}) {
  if (!prior?.physical || !validMount(shokoMount)) return null;
  try {
    const url = new URL(`/api/v3/File/${prior.fileId}`, baseUrl);
    url.searchParams.set('include', 'AbsolutePaths');
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'error', signal });
    if (response.status !== 200) await cancelResponseBody(response);
    if (response.status !== 200) return null;
    const record = await readBoundedJson(response, 200_000);
    if (record.ID !== prior.fileId || record.Size !== prior.size ||
        !Array.isArray(record.Locations) || record.Locations.length > 20) return null;
    const hashes = Array.isArray(record.Hashes) ? record.Hashes : [];
    const ed2k = hashes.filter((hash) => hash.Type === 'ED2K');
    if (ed2k.length !== 1 || !/^[a-f0-9]{32}$/i.test(ed2k[0].Value)) return null;
    for (const location of record.Locations) {
      if (signal?.aborted) return null;
      if (location.FileID !== record.ID || location.IsAccessible !== true) continue;
      const local = localPath(location.AbsolutePath, shokoMount);
      if (!local) continue;
      let stat;
      try { stat = await statImpl(local, { bigint: true }); } catch { continue; }
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size === BigInt(prior.size) &&
          ['dev', 'ino', 'mtimeNs'].every((key) => String(stat[key]) === prior.physical[key])) {
        return { ed2k: ed2k[0].Value, size: record.Size };
      }
    }
  } catch { /* Inconclusive history must not block a new request. */ }
  return null;
}
