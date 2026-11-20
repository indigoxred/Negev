# Release selection implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task by task.

**Goal:** Complete acquisition checklist items 13–15 in the existing request flow.
**Architecture:** Reuse discovery, metainfo preview and guarded acquisition. Persist request mode atomically, pin exact choices and enforce them again in the reservation transaction. Keep the dialog outside polled request cards.
**Tech Stack:** Node.js, SQLite, Fastify and browser JavaScript; no new dependency.
**Spec:** User checklist 13–15 and unattended registration preference, 20 November.

## Global constraints
- Preserve quality/peer tiers, availability guards and completed-season pack preference.
- Prefer acceptable registration correspondence within the strongest tier unattended; never lower quality for recognition. Unknown grey; confirmed green requires verified exact evidence.
- Auto-only better-release prompt expires after five minutes to the registered option. Manual choices never silently substitute.
- Item 12 follows item 18, for a naturally expected release tomorrow.

## Review focus
- Concurrent automatic reservation respects newly entered manual mode.
- Every write checks owner/admin, account and adult permissions.
- Restart, stale revisions and repeated clicks preserve exact choices.
- Mixed-registration packs cannot appear wholly confirmed.
- Future-only titles and provider failures have explicit recoverable outcomes.

### 1. Durable boundary
- [x] Failing SQLite tests: atomic mode, restart, stale revision, reservation race.
- [x] Add release-control persistence and selection-aware processing.
- [x] Run focused and acquisition regressions.

### 2. API
- [x] Failing tests: permissions, provider errors, metadata, proposal expiry.
- [x] Reuse bounded discovery/preflight with server-side receipts and revisions.
- [x] Run API and discovery regressions.

### 3. UI
- [x] Auto search/Search releases in season/film review and saved requests.
- [x] Metadata, coverage, per-file evidence and inspection before selection.
- [x] Browser verification of polling persistence and Auto-only alternatives.

### 4. Release
- [ ] Full tests and fresh-context review; resolve material findings.
- [ ] Push, CI, merge main, deploy Negev alone with rollback.
- [ ] Signed-in live verification and private checklist update.

## Verification and review

- Focused SQLite/API/processor/browser tests pass; Linux full suite passed before the final review fixes. CI is the final full-suite gate.
- Fresh-context review found hash/file reservation race, lost pending manual mode, cross-page quality downgrade, incomplete-search downgrade and lost private ranking fields. Each was corrected with focused regressions.
- Ruling: use 1080p before 720p even when the latter advertises Blu-ray, following the user’s current Airing standard; keep source preference within a resolution tier.
- Exact already-owned choice recovery requires matching request, torrent hash and canonical file plan before returning future episodes to automatic acquisition.
- Manual search pages through at most200 results in50-result pages, with refined queries, deduplication and retryable page failures. Automatic search retains its original50-candidate bound.
