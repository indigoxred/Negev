# Started Request Cutover Hold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator pause old Negev requests with saved torrent attempts before enabling a new acquisition instance, without cancelling requests or changing torrents.

**Architecture:** Extend the existing durable `acquisition_request_suspensions` table to cover a specifically named cutover operation. All four queue selectors must exclude suspended requests. The operation is private and callable only while acquisition is stopped; it is not an HTTP or user-facing cancellation action. Existing `resumeSuspended` re-enables queue selection. It does not stop an already running qBittorrent transfer.

**Tech Stack:** Node 24, node:sqlite, existing acquisition queue modules and node:test.

**Spec:** `outputs/Negev-Combined-Cutover-Plan-20261105.md` review-instance acquisition gate.

## Global Constraints

- Preserve all request, attempt, start, completion, handoff, and media records.
- Never treat a queue hold as a qBittorrent pause or cancellation.
- Do not enable acquisition on the public review instance during this work.
- Keep the current `suspendUnstarted` precondition intact.

## Review Focus

- A held request with no attempt stays invisible to the request queue.
- A held request with a due retry cannot start a new torrent.
- A held request with an already started torrent cannot enter completion or publish.
- Another request still advances through each queue.
- Reopening the SQLite queues retains the hold; explicit resume restores eligibility.

## Task 1: Durable started-request hold

**Files:** `src/acquisition/acquisition-ledger.mjs`, `src/acquisition/acquisition-request-queue.mjs`, `test/acquisition-request-queue.test.mjs`.

- [x] Add a failing test for a started request: the old unstarted-only method rejects it, the new cutover hold saves it, the request queue skips it after reopen, and resume restores selection.
- [x] Create the existing suspension table during acquisition-ledger initialization and add the private started-request cutover method using the existing table and transaction. A second red-green test rejects an unfinished request claim, and the same transaction checks unfinished start, completion and publish claims.
- [x] Run the focused test and confirm no request/attempt row changed.

## Task 2: Guard each downstream queue

**Files:** `src/acquisition/start-queue.mjs`, `src/acquisition/completion-queue.mjs`, `src/acquisition/handoff-publish-queue.mjs`, their corresponding tests.

- [x] Add one failing queue-selection test for each stage, including another eligible request and restart persistence.
- [x] Add the suspension exclusion to each durable `next` selector. Keep the existing reconciliation, result recording and manual review data unchanged.
- [x] Run the focused queue suites, acquisition ledger, pipeline and user-service suites: 109 passed, zero failed. Independent review found an in-flight claim race; the transaction guard and regression test closed it on re-review.

## Task 3: Cutover rehearsal

**Files:** private test database only; no production image or NAS media.

- [ ] Rehearse pause, stage ticks, restart and resume on a throwaway database with historical attempt shapes.
- [ ] Review the diff and verify queue evidence, no duplicate grab, no request loss and no media operation.
- [ ] Leave the public review instance acquisition disabled until the resulting change passes independent review and a separate guarded deployment.
