# Workflow verification record

Audit performed on 28 November 2026 against Negev v0.0.334, with corrections released in v0.0.335. Shoko was stable 6.0.0, commit `634dd21`, with Relay 0.24.0. Relay is a prerelease; its effective configuration and existing Plex/VFS identities were checked separately during the server upgrade.

Passing isolated tests, a healthy process and a successful provider response establish different facts. This record keeps those distinctions explicit.

| Boundary | Evidence | Limit |
| --- | --- | --- |
| Session, account access, invitation/reset and request ownership | HTTP ledger tests and controller tests, including actual API-client/session wiring across delayed responses; current service-key permissions checked | Browser fixtures mostly use a controlled HTTP fixture rather than the complete running user service |
| Search, detail, Auto/Manual and watches | Existing HTTP/browser tests and durable Auto queue tests; current catalogue and episode adapters checked against Shoko 6 | A mocked submission result is not a completed torrent transfer |
| Reservation, stopped add, start and reconciliation | Durable intent, uncertain-send, rejected-send, restart, mount and identity regressions; downloader authentication/API version checked live | No fresh swarm transfer was started for this audit |
| Completion, pure move, publication and retirement | File/inode/content and crash-recovery tests; Windows fixture path-casing issue corrected | Synthetic staging fixtures do not prove every installed release or filesystem condition |
| Shoko file updates | Network-isolated clone generated real ignored/restored events; actual SignalR consumer refreshed the exact file and withdrew a seeded queue witness | The queue witness was synthetic, not a claimed Plex playback proof |
| New Shoko intake | Private 2.8 MB copy of known video in an isolated Source folder produced real detected/hashed events. Exact video ID, ED2K, size and location matched; the corrected consumer tracked and resolved the pending path | Shoko reported reuse of existing hashes. This is known-content intake, not proof of first-time unknown-content hashing or a new torrent transfer |
| Bulk omission and feed-gap recovery | Regression tests cover 201 omissions, bounded batches, reopen/replay, proof withdrawal and protection of newer targeted observations | Daily overflow pacing is retained; large removals can take multiple days to drain |
| Inventory and worker progress | Multiple live snapshots; saved recent cursor and advancing inventory passes; historical due rows joined to current attempt eligibility | Persisted queue counts alone do not establish external readiness |
| Plex availability | Fresh exact series and film proofs using a disposable observer database, plus live browser presentation | Existing-media proof is distinct from publication of a genuinely new arrival |
| Exclusive anime acquisition | Live archive checks found zero monitored entries among nine anime Sonarr series and twelve mapped anime Radarr films | Sole-owner configuration is a contract; external monitoring changes need continued operational checks |
| Recovery rescan | Durable one-send/identity/retry tests and separate live Shoko contract checks | Existing journal evidence was nine observed/nine linked/zero dispatched; it does not prove an actual rescan request repaired an unrecognized file |

## Remaining controlled acceptance

A complete new RSS or Manual request through actual torrent transfer, completed-file publication, initially unrecognized-file rescan repair and same-file public Plex availability remains a separate acceptance scenario. It needs disposable downloader/Shoko/Plex state and an authorized registered-video fixture. Do not count mocked stage processors, HTTP rescan acceptance, existing playable copies or the known-content clone test as completion of that scenario.

Retain this gap explicitly until the full scenario has receipts. No production request, download, rescan, retirement, account permission change or media relocation was submitted during this audit. Live provider and ownership checks were read only; file mutations occurred only inside the network-isolated clone.
