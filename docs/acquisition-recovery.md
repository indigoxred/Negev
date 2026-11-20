# Acquisition recovery and RSS wake-up

Negev owns release selection, torrent submission and filesystem handoff. Shoko owns file hashing and identification. Plex playback is confirmed separately; an empty queue, a filename prediction or an AniDB cross-reference without a local Shoko episode is not playback proof.

## Published files

Recovery uses the recorded per-file manifest and active target claims, including existing requests. Retired attempts stay excluded. Each pack member has its own persisted Shoko file witness and at most one rescan intent. A pass can dispatch at most four rescans. One ambiguous member cannot prevent independently identified members being reconciled. No recovery rescan deletes or replaces media.

- A provider failure remains retryable and is not classified as an unrecognized file.
- Missing AniDB episode metadata invokes the existing rate-limited title hydrator. It is separate from missing file registration.
- Shoko processing is allowed to finish. Queue activity does not prevent an already recognized file being checked in Plex.
- Explicit Shoko Unrecognized membership is distinct from unknown AniDB registration. Absence from a registration lookup does not prove a bad file.
- Conflicting or ambiguous identity is retained for review. Review is periodically rechecked; elapsed time alone does not turn a provider outage or pending Plex publication into permanent review.
- Success requires the same Shoko file ID for every expected episode and verified Plex availability. A different playable copy cannot complete the recorded file's recovery.

The existing guarded single-file alternate path still requires two quiet observations, explicit Unrecognized membership, a stopped torrent and durable preservation before releasing a claim. Pack members are reconciled in place; a partially imported pack is not moved wholesale to obtain a replacement. Separate Negev and Shoko mount paths are translated through the configured Source path.

## RSS

Installed Prowlarr feeds remain the source of notifications. Initial feed entries are seeded without acquisition wakes. New matching entries record the request, indexer, GUID digest, advertised title, publication time, observation time and whether the acquisition deadline changed. Raw provider URLs and credentials are not recorded in the wake journal. Wake evidence is retained for thirty days.

After a durable feed commit, Negev invalidates that title's search cache and wakes its guarded request worker. A bounded, coalesced metadata refresh of that exact active watch then adds any newly listed aired targets and wakes acquisition again. It does not create another request or choose a release. Restart recovery retains durable deadlines. Failed feed reads retry with bounded provider backoff; normal successful polling remains hourly while airing.

Attempt creation, start intent, completed-file move/publication, Shoko file records and exact Plex proofs provide subsequent stage timestamps. These timestamps are observations, not a claim that torrent download or third-party processing always completes within a fixed duration. A genuinely new RSS-to-Plex arrival remains a live acceptance requirement; synthetic feed tests alone do not meet it.
