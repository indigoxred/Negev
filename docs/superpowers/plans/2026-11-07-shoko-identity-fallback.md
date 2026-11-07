# Shoko Identity Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the anime request-to-public-Plex path when a correct download lacks an exact AniDB file registration.

**Architecture:** Keep the existing exact AniDB path. Add a separately journaled provisional path that preserves byte identity, lets Shoko hash and attempt recognition, and uses a guarded supported release link only after independent evidence agrees. Reconcile success from the actual public Plex file.

**Tech Stack:** Node.js ESM, SQLite ledgers, Shoko v3 API, Plex API, node:test.

**Spec:** `docs/identity-fallback.md`

## Global Constraints

- Do not replace a download on Shoko 204 alone.
- Do not overwrite Shoko's existing release or move/delete public media.
- Keep acquisition scoped to the isolated pilot until genuine arrival and recovery gates pass.
- Bound API reads and file hashing to prevent another NAS load spike.
- Keep secrets, hashes and private paths out of public logs and repository fixtures.

## Review Focus

- Late Shoko recognition after an initial unrecognized observation.
- A conflicting Shoko release appearing between observation and attempted link.
- Same filename with different bytes or torrent manifest.
- Multi-file or multi-episode ambiguity.
- Plex showing a different physical file or wrong show after Shoko import.

---

### Task 1: Observe Shoko's exact imported file

**Files:** Create `src/identity/shoko-imported-file.mjs`; test `test/shoko-imported-file.test.mjs`.

**Interfaces:** `readShokoImportedFile({baseUrl, apiKey, ed2k, size, fetchImpl, timeoutMs})` returns `not_imported`, `imported_unrecognized`, `imported_recognized`, or `unavailable`, with only validated file ID, hash, size, release and cross-reference fields.

- [x] Write tests for 404, no release, correct release, conflicting release, malformed response and transport failure.
- [x] Run them and observe failure.
- [x] Implement a bounded GET to `/api/v3/File/Hash/ED2K?hash=...&size=...&include=XRefs,ReleaseInfo`.
- [x] Run focused tests and commit the read-only module.

### Task 2: Journal a provisional handoff separately

**Files:** Modify the staged-batch verifier, handoff evidence and ledgers; add corresponding focused tests.

**Interfaces:** A versioned manifest records the request target, torrent identity, hashes, exact selected file tree, evidence grade and handoff state. The exact-release manifest remains valid.

- [ ] Test that 204 can prepare a provisional batch with independent episode evidence, while wrong identity or ambiguity holds.
- [ ] Test crash recovery and replay without duplicate publication.
- [ ] Implement the versioned manifest and private preparation.
- [ ] Verify exact-release behavior remains unchanged.

### Task 3: Publish, observe and link through Shoko

**Files:** Modify handoff publication and import observation; create a guarded Shoko ReleaseInfo client; add integration tests.

- [ ] Test byte and mount rechecks before provisional publication.
- [ ] Test Shoko's late automatic match, absent release, and conflicting release.
- [ ] Test re-read immediately before any supported User link and refuse an occupied release.
- [ ] Test that one unambiguous episode can link and multi-episode cases hold.
- [ ] Implement the guarded path and exercise it against an isolated Shoko instance.

### Task 4: Public proof and pilot gate

**Files:** Modify request progress and pilot configuration; add series/movie/Airing integration tests.

- [ ] Require the same Shoko file in the correct public Plex show before Available/completed.
- [ ] Prove retries do not duplicate grabs and later requests advance past a hold.
- [ ] Verify the existing held Airing download without replacement; then run a bounded genuine series and movie arrival.
- [ ] Review performance, backup and rollback before any production cutover.
