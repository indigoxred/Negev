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

### Task 3: Opt-in worker composition and recovery

**Files:** Modify `src/web/user-server-config.mjs`, `src/web/user-service.mjs`, `src/web/user-server.mjs`; add a focused integration test.

**Interfaces:** Compose existing request, start, completion and publish queues in order. Keep the runtime disabled by default until Task 2 and mount checks pass. Drain active work on shutdown and reconcile uncertain claims on startup.

- [ ] Write a real-SQLite synthetic request-to-publish test with a failed first target and a successful later target.
- [ ] Implement opt-in composition and test that disabled startup issues no indexer, qBittorrent or media reads.
- [ ] Verify restart does not repeat torrent POST or watched-folder rename.
- [ ] Run full local and Linux CI, then prepare a measured NAS preflight and rollback before deployment.
