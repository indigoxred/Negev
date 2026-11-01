# File-centric availability backfill implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Negev revisit every linked Shoko file at a measured pace and publish only fresh, exact public Plex file proofs, including files imported without a Negev request.

**Architecture:** The existing Shoko inventory and Plex card index remain independent, durable positive-only hints. A new per-file cursor cycles through linked Shoko hints; an exact Shoko file read plus exact public Plex card and same-file witness alone may create a proof. A separate proof ledger and invalidation path prevent the short-lived request-priority queue from limiting broad coverage.

**Tech Stack:** Node 24, built-in `node:sqlite`, existing Shoko and Plex readers, Node test runner.

**Spec:** `README.md` (Shoko inventory and direct availability sections) and the private workspace `outputs/Negev-Broad-Availability-Design-20261101.md`. The published repository must contain no private NAS evidence.

## Global constraints

- Keep acquisition disabled and unchanged until separate genuine-arrival and missing-target gates pass.
- Unknown or an incomplete index never becomes Missing or Available.
- Every Available proof identifies the exact AniDB episode, fresh Shoko file, public Plex card/Part, and same readable physical file.
- Do not use the 30-minute direct request queue as the broad backfill store.
- A bounded tick must advance past an unproved file and revisit it on a later pass; crashes cannot skip a file.
- Preserve credentials and media paths privately; tests use synthetic paths and files.
- Measure a narrow installed tick before changing the live diagnostic scheduler or proof lifetime.

## Review focus

- Restart during a claimed file: retry it, do not skip it. Task 1 test.
- Shoko hint removed or changed: withdraw proofs for that file and queue recheck. Task 3 test.
- Plex card/Part removed or changed: withdraw only affected proofs. Task 3 test.
- Old proof beyond its configured lifetime: label previously verified, not currently Available. Task 2 test.
- Incomplete public-card index, provider outage, or candidate budget: retain Unknown and advance the paced cursor. Task 5 test.
- A file linked to more episodes than one exact-check budget: persist an episode offset and eventually visit every pair. Task 4 test.

---

### Task 1: Durable bounded file cursor

**Files:** Create `src/availability/file-backfill-cursor.mjs`; test `test/file-backfill-cursor.test.mjs`.

**Interfaces:** `openFileBackfillCursor(dbPath)` returns `claim({ inventory, nowMs, limit })`, `record({ claim, outcomes, nowMs })`, `close()`. `inventory.listFileHintIds({afterFileId,limit})` supplies up to ten sorted linked file IDs. A claim records the selected IDs before work; only a matching recorded receipt advances the cursor. On restart, an unresolved claim is returned again. A full page advances `afterFileId`; an empty page wraps to zero and increments the pass. `limit` is 1–10. Outcome contains one result state per claimed ID and never stores media paths.

- [x] Write tests for page progression, wrap, restart retry, stale receipt, invalid IDs and cursor immutability after a failed record.
- [x] Run `node --test test/file-backfill-cursor.test.mjs` and verify the new tests fail for the missing interface.
- [x] Implement only the cursor and transactional receipt checks.
- [x] Run focused tests, then the full `node --test` suite; commit the passing increment.

### Task 2: Exact-proof ledger and status reader

**Files:** Create `src/availability/file-proof-ledger.mjs`; test `test/file-proof-ledger.test.mjs`.

**Interfaces:** `openFileProofLedger(dbPath,{positiveLifetimeMs,now})` accepts only validated `observe({anidbId,episodeId,proof,checkedMs})` from an internal exact observer. `getCurrent({anidbId,episodeId})` distinguishes current `available`, `previously_available`, and `unknown`; no negative status is stored. Proof fields are `fileId,libraryId,ratingKey,partId`. A proof can have multiple public copies; an episode stays current if at least one is valid. The lifetime is explicit and conservative until measured withdrawal latency supports a broader setting.

- [x] Write tests for exact field validation, restart persistence, multiple playable copies, expiry and older receipts.
- [x] Run focused tests red; implement the ledger; run focused and full suite; commit.

### Task 3: Narrow proof withdrawal

**Files:** Modify `src/availability/shoko-inventory-worker.mjs` and `src/availability/plex-card-index.mjs`; add `src/availability/file-proof-invalidator.mjs`; test `test/file-proof-invalidator.test.mjs`.

**Interfaces:** Transactional `invalidateFile(fileId,observedMs)` and `invalidateCard(libraryId,ratingKey,observedMs)` withdraw only linked proof rows, preserving request IDs and unrelated copies. Existing file-change and card-change receipts call these methods only when their source observation is newer than the saved proof. Invalid/incomplete scans cannot invalidate. A later exact recheck may restore the positive.

- [x] Write tests for Shoko unlink, card/Part removal, unrelated copy preservation, stale receipt rejection, and restart.
- [x] Run red; implement hooks; run focused and full suite; commit.

### Task 4: Multi-episode continuation

**Files:** Modify `src/availability/file-backfill-cursor.mjs` and `src/availability/shoko-file-candidate.mjs`; extend their focused tests.

**Interfaces:** A one-file claim carries a `pairOffset` and candidate fingerprint. A `partial` outcome atomically replaces that claim with a new receipt for the same file and a strictly larger offset, instead of advancing to the next file. The fingerprint covers Shoko file update identity, release identity and the exact ordered AniDB episode pairs; a changed fingerprint resets processing to pair zero. A complete/Unknown/held outcome advances normally. The worker may claim only one file while continuation is active, keeping a fixed per-tick read budget without starving later pairs.

- [ ] Write failing tests for a 12-episode file with a ten-pair tick, restart after the partial receipt, stale receipt rejection and changed-file reset.
- [ ] Implement the narrow cursor extension and candidate update identity; run focused and full suite; commit.

### Task 5: Bounded source worker and UI read composition

**Files:** Create `src/availability/file-backfill-worker.mjs` and `src/availability/file-backfill-scheduler.mjs`; modify `src/web/user-service.mjs`, `src/web/user-server-config.mjs`, `src/web/user-server.mjs`; add focused tests.

**Interfaces:** An opt-in worker claims at most ten IDs, re-reads each Shoko file, calls existing exact `observeFileCandidate` for each linked episode within a shared card/probe budget, records valid proofs and Unknown outcomes, then advances the cursor. A single timer runs only after both independent inventories are enabled, with no overlapping tick. The catalogue status reader combines fresh direct checks with fresh file proofs; unverified items remain unlabelled. Request-time acquisition still performs an independent live presence check.

- [ ] Write tests for direct-Shoko-import positive, incomplete index Unknown, shared budget, multi-episode continuation, retry after restart, expiry, acquisition isolation and opt-in parsing.
- [ ] Run red; implement worker and wiring in small commits; run focused and full suite plus Linux CI.
- [ ] Rehearse one isolated NAS tick with acquisition off, resource limits and private temporary SQLite; record timings, counts, index coverage and service load without printing paths or tokens.
- [ ] Do not enable an installed broad scheduler until the load and rollback gates pass. A synthetic green suite is not operational proof.
