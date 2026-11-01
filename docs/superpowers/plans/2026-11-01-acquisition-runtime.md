# Acquisition Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. The owner asked for continued work without questions while away.

**Goal:** Turn saved anime requests into a recoverable, guarded acquisition and import service for series and movies.

**Architecture:** Keep the current request, acquisition, start, completion, and handoff journals as the only action state. Compose their workers behind an explicit disabled-by-default runtime setting. First add a read-only target probe that reports Shoko, import-activity, and public Plex observations without converting Unknown into absence. A separate installed-service gate must establish a trustworthy missing-target policy before torrent submission can be enabled.

**Tech Stack:** Node.js 24, SQLite, Fastify, Docker, Shoko v3 API, Plex API, qBittorrent WebUI API.

**Spec:** `outputs/Negev-Feasibility-and-Build-Plan-20261031.md` in the parent workspace.

## Global Constraints

- Both AniDB series and movies are in scope; Airing watches future regular episodes, Completed is one-time acquisition.
- A release's exact video bytes must match AniDB's registered file ID, ED2K, size, anime, episode set and coverage before Shoko Import.
- Shoko's unrecognized or in-progress hashing must hold that target without stopping later requests.
- No production service, public library, media, credential or recovery asset changes during source work.
- Never infer Plex absence from an empty positive-only index or a single card query.

## Review Focus

- Shoko returns 404 for an unowned episode: report local absence as unconfirmed, never automatic download permission.
- Shoko returns a local file without a public Plex card: hold as awaiting Plex, not absent.
- Shoko import queue or unrecognized files are nonzero: hold that target while later requests advance.
- **Open design gate (1 November):** The current `readShokoImportActivity` is a global folder/queue check. A genuinely unrecognized Import file makes every first-time `collectFirstTimeUncertain` call hold, even though the request cursor itself advances. Before enabling acquisition, supply a target-scoped way to attribute unresolved imports or an explicitly reviewed uncertainty policy that lets unrelated targets proceed; do not describe the existing global hold as satisfying this requirement.
- A Shoko AniDB release-preview HTTP 204 cannot classify a pending file as unrelated: the installed provider can return 204 while banned. A stable filename, age, or quiet queue likewise cannot establish its target. The admin-only Import diagnostic now reports a bounded reason such as `unrecognized_import_video` without a path or implied acquisition authorization, so the exact hold can be distinguished from ordinary queue activity. The target-scoped decision remains open.
- A source-only attribution candidate can remove a pending **Negev-owned** file from one target's Import baseline only when its unique publish name, durable `published_observed` handoff, complete manifest tree, Shoko Import location, size and ED2K all agree and the manifest names a different AniDB target. Manual or ambiguous files still hold. The target-scoped feed candidate now compares every pending event key with those independently verified Import paths before and after the 120-second window and after the final Shoko/Plex checks. An unchanged generation, inventory fingerprint, queue and pending-only debt are required. Earlier reconciliation debt or a feed gap still holds. This remains source-only until a genuine event and unrecognized file are checked on the installed Shoko; acquisition stays disabled.
- The installed folder-scoped Shoko response exposes `Hashes` (including ED2K), `Locations` and `SeriesIDs` on recognized file rows, so the candidate's field contract has one live positive shape check. A future unrecognized row and genuine event still need installed proof. Paths used for this check remain internal and are omitted from saved request evidence.
- Provider outage or stale evidence: keep the saved request and retry without sending a torrent twice.
- Restart after an uncertain qBittorrent POST or watched-folder rename: reconcile the journal before any further action.

### Task 1: Read-only acquisition presence probe

**Files:** Create `src/acquisition/probe-target-presence.mjs`; test in `test/probe-target-presence.test.mjs`.

**Interfaces:** `probeTargetPresence({ anidbId, episodeIds, kind, readShokoEpisode, readPublicTarget, readImportActivity, now })` returns `{state:'probe', observedAtMs, targets:[{episodeId,state,reason}]}` or a held reason. No returned state is a missing-target authorization.

- [x] Write synthetic tests for the probe's mixed targets, import activity, provider failure, conflicting observations and bounds.
- [x] Run the tests and confirm the new probe is missing.
- [x] Implement bounded, sequential, read-only observations; never transform 404 or Unknown into a complete acquisition snapshot.
- [x] Run the focused and full Node suites, then commit and publish after reviewing the diff for private data.

### Task 2: Installed authority and missing-target gate

**Files:** Extend the probe only after narrow live checks prove Shoko episode/queue shapes, public Plex section agents and every relevant mount; modify `src/acquisition/confirm-missing-targets.mjs` and its tests.

**Interfaces:** Produce a fresh missing-target decision with explicit provenance, including an import-activity fence and a repeat check immediately before qBittorrent start. Hold on any unrecognized, incomplete or conflicting result.

- [ ] Record read-only installed responses and verify the configured Anime libraries are solely Shoko-backed for this purpose.
- [ ] Write failing first-time-title and concurrent-import tests using those shapes.
- [ ] Implement the verified policy; keep unknown paths held.
- [ ] Run an isolated arrival/withdrawal exercise before allowing the new decision to authorize a stopped torrent.

The Task 1 probe is also exposed through an authenticated, admin-only, two-per-minute diagnostic for at most ten saved request targets. It returns only state and reason; no file paths, IDs or credentials. This read-only route is not a missing-target gate and has not been run against installed services.

Source-only Task 2 increment: `collectFirstTimeAbsence` composes an exact Shoko unimported observation, an explicitly complete public Plex snapshot and two matching, target-scoped Import fence observations. It holds on a positive-only or incomplete Plex result, a wrong first fence, changed Import fingerprint, stale observation or provider outage. It has no installed provider callbacks or acquisition authority yet. The current Import activity reader intentionally returns `quiet_observed`, so it cannot satisfy this collector's `settled` requirement.

The folder-scoped Import activity reader can optionally return an opaque inventory fingerprint and observation time to private callers. The 120-second quiet-window helper requires matching fingerprints, so a changed watched folder holds even if an event feed misses that change. A connected Shoko feed adapter and target-scoped pending-path candidate are now wired in source, but a genuine event still needs installed proof. This is only an explicitly uncertain first-acquisition observation; no complete public Plex absence reader is wired, and it cannot satisfy the strict `settled` fence above.

Installed 1 November follow-up: a read-only v0.0.13 rehearsal completed the actual `collectFirstTimeUncertain` source path for unowned Pale Cocoon episode 44932. Shoko returned `unimported_targets`; public Anime 102 returned `health_only`; a connected Shoko feed and matching Import fingerprints yielded `quiet_window_observed` over 120 seconds, with the old qBittorrent sidecar state unchanged on exact pre/post GETs. The result remains explicitly **uncertain**, with no torrent action. Plex SQLite confirms sections 102/103 currently use only Shoko Relay VFS roots and the Shoko agent, but that configuration does not prove every retained Plex card is live or exclude other public libraries. The full first-time missing-target gate and genuine arrival are still open.

Source follow-up: first-time uncertain collection now requires a fresh, exact source-policy match from Plex's sections-list response before accepting the public health probe. The opt-in `NEGEV_PLEX_SOURCE_POLICY` pins each configured section's type, agent, scanner and roots; missing policy, changed source, malformed response or outage holds. The same `sourceVerified` evidence is required again at the saved stopped-torrent start gate. This still cannot prove an individual title absent, and no installed acquisition runtime or download was enabled. The 774-test local suite passed (756 pass, 18 environment skips) after this source change.

The event consumer now tracks a generation for each file event or feed state change. A completed recent-file catch-up may clear an ordinary resolved arrival only if it began at that generation and its durable queue has no pending work. Feed gaps, invalid events, overflow, failed refreshes and deletions retain a stronger full-reconciliation flag. There is no installed caller yet that proves a complete full reconciliation or exposes this state to the acquisition quiet-window helper; these source guards must not be interpreted as live download permission.

### Task 3: Opt-in worker composition and recovery

**Files:** Modify `src/web/user-server-config.mjs`, `src/web/user-service.mjs`, `src/web/user-server.mjs`; add a focused integration test.

**Interfaces:** Compose existing request, start, completion and publish queues in order. Keep the runtime disabled by default until Task 2 and mount checks pass. Drain active work on shutdown and reconcile uncertain claims on startup.

- [x] Write a real-SQLite synthetic request-to-publish test with a held first request and a successful later target, including restart with no repeated stage action.
- [ ] Implement opt-in composition and test that disabled startup issues no indexer, qBittorrent or media reads.
- [ ] Verify restart does not repeat torrent POST or watched-folder rename.
- [ ] Run full local and Linux CI, then prepare a measured NAS preflight and rollback before deployment.

Source preparation: `openAcquisitionPipeline` now owns the four durable queues, requires restart reconciliation before explicit ticks, lets later requests advance past an interrupted claim, and drains active work on close. A separate source-only clock visits the four stages sequentially after reconciliation, with one minute between ticks and shutdown draining the current stage. Neither module has server integration, provider credentials or download authority; the guarded processors and Task 2 remain required.

Recovery review now pages through every interrupted claim in all four queues instead of marking initialization complete after the first 20. The synthetic real-SQLite chain tests a held request followed by a later request through journalled stopped, start, completion, and publish states; it uses no actual torrent, file verification, or watched folder. The installed missing-target and mount gates remain required before runtime wiring or activation.

Source-only mount-witness candidate: a separate Negev process may hold the Docker socket and answer only `GET /v1/mounts` on a private Unix socket. It inspects only configured qBittorrent, Shoko and Plex containers, strips the Docker response to running IDs and mount fields, limits response sizes and request frequency, and refuses other paths or methods. The account-facing service may read only that Unix socket; it must never mount the raw Docker socket. This candidate is not wired to acquisition, has no installed sidecar, and cannot authorize a torrent without fresh host realpath, public-library and Import evidence. A Linux test and an isolated installed rehearsal are required before using it; the Docker-socket process remains a privileged component requiring explicit deployment review.
