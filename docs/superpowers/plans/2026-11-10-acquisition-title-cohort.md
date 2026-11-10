# Acquisition title cohort implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restrict an opt-in Negev acquisition worker to exact assigned AniDB titles during the measured Sonarr handover.

**Architecture:** Parse a bounded, nonempty AniDB ID list at account-server startup. Pass the immutable IDs through runtime composition to the durable request queue, where selection remains atomic and noncohort requests stay untouched.

**Tech Stack:** Node.js 24, node:sqlite, Docker.

**Spec:** `docs/superpowers/specs/2026-11-10-acquisition-title-cohort.md`

## Global Constraints

- No media or existing request deletion.
- No Sonarr, Seerr, Shoko, Plex or qBittorrent setting change in this source task.
- A missing or malformed configured cohort must never widen acquisition.

## Review Focus

- Empty or duplicate IDs, whitespace and oversized lists.
- Cursor wrap and restart with noncohort requests.
- Downstream work for previously started attempts.
- Disabled-runtime configuration rejection.
- No claim that this completes the migration of Sonarr's 99 watches.

## Task 1: Test and implement exact cohort selection

- [ ] Add a failing queue test with two eligible titles and an exact allowed set.
- [ ] Verify the test fails for the missing cohort interface.
- [ ] Add the minimal immutable queue predicate and verify focused tests pass.

## Task 2: Test and wire startup configuration

- [ ] Add failing configuration tests for valid, empty, duplicate and malformed lists.
- [ ] Verify they fail for the missing option.
- [ ] Pass validated IDs through account server, runtime and pipeline to the queue.
- [ ] Verify focused and full tests, diff check and independent review.

## Task 3: Prepare measured release and installed gate

- [ ] Publish a pinned version only after CI passes.
- [ ] Verify exact non-Sonarr cohort and backups before runtime activation.
- [ ] Stop the old worker, enable the new worker and check request/attempt/handoff counts, health, and no duplicate grabs.
- [ ] Keep Sonarr's monitored cohort and rollback until its replacement is proven.
