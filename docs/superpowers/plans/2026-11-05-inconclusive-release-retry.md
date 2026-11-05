# Inconclusive AniDB Release Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeat full-file reads for an inconclusive AniDB lookup while keeping verification and recovery safe.

**Architecture:** Add a consecutive inconclusive counter to the durable completion row. On each recorded result, update its next due time according to the fixed schedule; reset the counter for other outcomes. Claiming an attempt preserves the counter. The existing four-stage pipeline remains unchanged.

**Tech Stack:** Node 24, `node:sqlite`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-05-inconclusive-release-retry.md`

## Global Constraints

- Exact AniDB-registered file verification remains mandatory before Shoko Import.
- No media, torrent, public Plex, Shoko, or production configuration changes in this source-only task.
- Existing completion rows and due times must migrate without data loss.

## Review Focus

- Old rows without a counter must migrate without altering their due time.
- A worker crash after claim must remain excluded for review, not silently requeued.
- An incomplete torrent must retain its five-minute cadence.
- An unrelated hold must retain its 30-minute cadence and reset the inconclusive streak.
- The later daily retry must remain due and fair to other attempts across restarts.

---

### Task 1: Durable backoff for inconclusive file lookup

**Files:**
- Modify: `src/acquisition/completion-queue.mjs`
- Test: `test/completion-queue.test.mjs`

**Interfaces:**
- Consumes: existing `openCompletionQueue(dbPath)` and `recordResult` contract.
- Produces: the same public queue methods; `completion_checks.inconclusive_count` as internal durable state.

- [x] Add a test that claims the same attempt repeatedly and observes 30-minute, 2-hour, 8-hour and 24-hour due times, including close/reopen.
- [x] Run `node --test test/completion-queue.test.mjs`; confirm the new test fails for the expected cadence.
- [x] Add a guarded schema migration and compute the next due time within `recordResult`'s transaction.
- [x] Add tests for reset after a different hold, unchanged incomplete/other delays, and migration of an old table row.
- [ ] Run focused completion queue and scheduler tests on Linux, then the repository test gate once. Local Windows focused tests pass 23/23; the full Windows run has unrelated catalogue-cache and browser-profile failures and is not a green gate.
- [ ] Inspect the diff for media, credential and schema scope; commit source and tests for review.
