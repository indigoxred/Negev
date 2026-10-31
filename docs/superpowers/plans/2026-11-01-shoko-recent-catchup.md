# Shoko Recent-Import Catch-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover Shoko file imports missed while Negev's event feed is disconnected, without repeatedly paging the entire inventory on ordinary arrivals.

**Architecture:** Read a few Shoko pages ordered by descending import time and file ID, stopping at a durable exact watermark. Journal newly seen IDs before moving the watermark, then recheck each ID through Negev's existing targeted file reader and availability queue. Keep the slower inventory audit for late recognition of old files; recent imports alone cannot cover that case.

**Tech Stack:** Node.js 24, SQLite, Shoko v3 API.

**Spec:** `../../../../../outputs/Negev-Feasibility-and-Build-Plan-20261031.md` and the installed read-only response recorded in `../../../../../outputs/Nagisa-Catalogue-Availability-Private-20261012.md` (parent workspace paths).

## Global Constraints

- Both anime series and movies, including direct qBittorrent-to-Shoko imports, remain in scope.
- Never infer file deletion, target absence or request fulfilment from a recent-file scan.
- No production change, media move, download or token publication during source work.
- A caught-up watermark must never advance before all returned IDs are durably queued.
- A changed page total, changed first page, malformed timestamp, order violation or exceeded page budget holds the cursor.

## Review Focus

- Several files may have the same import timestamp; file ID breaks the tie without skipping any.
- An import between page reads can shift an offset; changed total or first page holds the batch.
- A gap larger than the page budget must not silently discard older imports.
- A restart after journal write but before watermark write may replay IDs; deduplicate without losing them.
- Old files recognized late need a separate audit or targeted event; this catch-up must not claim complete catalogue coverage.

### Task 1: Bounded recent-file reader

**Files:** Create `src/availability/shoko-recent-catchup.mjs` and `test/shoko-recent-catchup.test.mjs`.

**Interfaces:** `readShokoRecentPage({baseUrl,apiKey,page,pageSize,fetchImpl,timeoutMs})` returns `{state:'page',page,total,items:[{fileId,importedNs}]}` or `{state:'unavailable'}`. `scanShokoRecentSince({readPage,since,pageSize,maxPages})` returns `{state:'complete',fileIds,newest}` only after sorted, stable pages and a repeat first-page check; otherwise a held reason. `since` and `newest` are `{importedNs,fileId}` with decimal nanoseconds stored as a string.

- [x] Write failing tests for a two-page catch-up, equal-time tie, changed total/head, malformed timezone and exceeded page budget.
- [x] Run the focused tests and confirm they fail for missing reader behavior.
- [x] Implement a bounded parser and scanner using `sortOrder=-ImportedAt,-FileID`, `include=ImportLimbo`, at most five 100-file pages plus one first-page recheck.
- [x] Run focused and full suites, review the diff for secrets, commit and publish.

### Task 2: Durable queue-before-cursor recovery

**Files:** Create a SQLite-backed catch-up ledger and focused tests under `src/availability` and `test`.

**Interfaces:** A first-run baseline is explicit and immutable. `recordBatch` atomically inserts exact file IDs into a deduplicated pending queue and then saves the newest cursor in one transaction; a failed transaction preserves the old cursor. `drainOne` calls the existing targeted Shoko file-ID path and leaves failed IDs pending.

- [x] Write failing tests for restart, duplicate replay, failed transaction, backlog overflow and no initial cursor.
- [x] Implement the ledger without writing Shoko or Plex.
- [ ] Run focused and full suites, commit and publish.

### Task 3: Opt-in supervisor and installed gate

**Files:** Modify the account service and server wiring; add a focused integration test.

**Interfaces:** A disconnected feed schedules bounded catch-up after reconnect, with no overlap with an active page read. Disabled startup performs no recent-file request. Existing inventory remains off until its sustained cost is measured.

- [ ] Write failing disabled-start and reconnect tests with a saved watermark and changed Shoko head.
- [ ] Wire only after Task 2 recovery and a narrow installed read-only contract check; keep all acquisition actions disabled.
- [ ] Verify a real direct import, restart/reconnect and public Plex status before enabling on the NAS.
