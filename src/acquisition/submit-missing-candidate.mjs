import { prepareStoppedCandidate } from './prepare-stopped-candidate.mjs';
import { reserveMissingTargets } from './reserve-missing-targets.mjs';
import { submitStoppedCandidate } from './submit-stopped-candidate.mjs';

// Server-side controlled-acquisition boundary. The caller must have chosen
// the release and exact episode subset; a title match alone cannot do that.
// This prepares and submits only a stopped torrent. No bytes enter Shoko here.
export async function submitMissingCandidate({ request, candidate, episodeIds,
  readEvidence, publicLibraryIds, ledger, now = Date.now, prowlarr, qbittorrent }) {
  if (!prowlarr || !qbittorrent || typeof now !== 'function') {
    throw new TypeError('Invalid stopped acquisition configuration');
  }
  const prepared = await prepareStoppedCandidate({ ...prowlarr, candidate });
  if (prepared.state !== 'prepared_stopped') return prepared;
  const reserved = await reserveMissingTargets({ request, candidate, episodeIds,
    readEvidence, publicLibraryIds, ledger, now });
  if (!['reserved', 'existing'].includes(reserved.state)) return reserved;
  return submitStoppedCandidate({ ...qbittorrent, ledger,
    attemptId: reserved.attemptId, candidate, prepared, nowMs: now() });
}
