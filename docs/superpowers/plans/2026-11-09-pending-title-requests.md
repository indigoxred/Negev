# Pending Title Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save cold catalogue requests promptly and resolve them only after exact episode and availability checks.

**Architecture:** A separate durable preparation ledger stores title intent without targets. A paced worker converts it through the existing request submitter using the original idempotency key. The consumer shows the pending state and never sends it to acquisition.

**Tech Stack:** Node 24, SQLite, Fastify, browser JavaScript.

**Spec:** `docs/specs/pending-title-requests.md`

## Global Constraints

- Keep public review acquisition disabled during testing.
- Preserve requests, media and production services.
- Do not claim availability without recent public Plex proof.
- Do not start acquisition for a pending title or unknown target.

## Review Focus

- Distinct users requesting one cold title retain distinct intents without duplicate grabs.
- Restart and repeated key resolve once; a changed command conflicts.
- Cancellation racing resolution cannot create a later normal request.
- Unknown or restricted adult status cannot bypass account restrictions.
- Provider outage remains visible with bounded retry, not a busy browser loop.

### Task 1: Durable intent ledger

**Files:** Create `src/requests/pending-title-ledger.mjs`; test `test/pending-title-ledger.test.mjs`.

**Interface:** `openPendingTitleLedger(dbPath)` returns `enqueue`, `get`, `claimDue`, `defer`, `finish`, `cancel`, `close`. It shares the SQLite path but has no acquisition targets.

- [x] Write failing restart, idempotency, conflict, cancellation and due-order tests.
- [x] Run the focused test and confirm failure.
- [x] Implement strict transactional operations and rerun the test.
- [x] Commit the independently tested ledger.

### Task 2: Exact resolver

**Files:** Create `src/requests/pending-title-worker.mjs`; test `test/pending-title-worker.test.mjs`.

**Interface:** `runOnce()` processes one due intent. It calls the existing exact submitter with the saved account, title and key, then records the normal request ID, a bounded retry, or a terminal result.

- [x] Write failing Completed, Airing, outage, fully available, restart and cancellation cases.
- [x] Confirm failure, implement without indexer/qBittorrent calls, and rerun.
- [x] Commit.

### Task 3: Authenticated route and history

**Files:** Modify `src/web/user-app.mjs`, `src/web/user-service.mjs`, the service tick loop, and focused route tests.

- [x] Write failing authorization, key-reuse, history and no-target acquisition tests.
- [x] Confirm failure and wire ledger and paced worker.
- [x] Rerun focused checks and commit.

### Task 4: Consumer flow and isolated proof

**Files:** Modify `src/web/public/app.js`, browser tests, and relevant copy/style.

- [x] Write failing cold-title browser and route tests for visible preparation, key reuse and later exact request.
- [x] Confirm failure and implement the consumer flow.
- [x] Rerun focused checks and commit.
- [x] Verify a slow cold title saves inside five seconds in the isolated account-service test with acquisition disabled.
- [ ] Verify restart and resolution in isolated Docker before release or deployment.
