import { previewAniDbRelease } from '../identity/shoko-preview.mjs';
import { observeTorrentCompletion } from './qbittorrent-observation.mjs';
import { prepareRecordedHandoff } from './prepare-recorded-handoff.mjs';

// Explicit, one-attempt tick. It binds the durable file plan to qBittorrent's
// completed manifest, then verifies actual bytes with Shoko's AniDB provider.
// Success only means a private holding copy was journaled; it never publishes
// into Shoko Import or claims public Plex availability.
export async function processCompletedAttempt({
  requests, acquisitions, handoffs, attemptId,
  stagingHostPath, holdingRoot, importRoot,
  qbittorrent, shoko, fetchImpl = fetch, shokoFetchImpl = fetchImpl, nowMs,
  readPacer,
  verifyHandoffMounts,
}) {
  if (typeof fetchImpl !== 'function' ||
      typeof shokoFetchImpl !== 'function' ||
      typeof qbittorrent?.baseUrl !== 'string' ||
      typeof qbittorrent?.sessionId !== 'string' ||
      typeof shoko?.baseUrl !== 'string' ||
      typeof shoko?.providerId !== 'string' ||
      typeof shoko?.apiKey !== 'string') {
    throw new TypeError('Invalid completed-attempt providers');
  }
  return prepareRecordedHandoff({
    requests, acquisitions, handoffs, attemptId,
    stagingHostPath, holdingRoot, importRoot, nowMs, readPacer,
    verifyHandoffMounts,
    observe: ({ expected }) => observeTorrentCompletion({
      baseUrl: qbittorrent.baseUrl, sessionId: qbittorrent.sessionId,
      expected, fetchImpl,
    }),
    lookup: ({ ed2k, size }) => previewAniDbRelease({
      baseUrl: shoko.baseUrl, providerId: shoko.providerId,
      apiKey: shoko.apiKey, ed2k, size, fetchImpl: shokoFetchImpl,
    }),
  });
}
