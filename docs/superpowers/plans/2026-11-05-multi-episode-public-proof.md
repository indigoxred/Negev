# Multi-episode Public Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count a fully linked AniDB episode as playable when its exact file is in the correct public Plex show under another linked episode card, while naming that placement in the episode detail.

**Architecture:** The file candidate reader already verifies every active AniDB cross-reference and Shoko episode identity. Pass only those same-series IDs down the file-centric observer; the known-card join may accept one as an alternate GUID while retaining the existing physical proof and guarded invalidation. Persist a small presentation marker with that proof so the episode detail can show an honest note; exact-card proofs retain their ordinary label. Acquisition already treats a linked Shoko file as present even when public presentation is incomplete.

**Tech Stack:** Node.js, built-in test runner, SQLite evidence ledger.

**Spec:** `docs/superpowers/specs/2026-11-05-multi-episode-public-proof.md`

## Global Constraints

- No title-specific rule, Plex/Shoko write, media move, or acquisition decision from this positive proof.
- Existing exact-card behavior remains the default for direct checks and one-episode files.
- Require correct public show and same physical file for every alternate-card proof.

## Review Focus

- Wrong-show Plex card must remain Unknown even if its file has the same size.
- Wrong-episode card not in this file's Shoko links must remain Unknown.
- A same-size but different physical file must remain Unknown.
- A partial AniDB episode association must not become a positive file candidate.
- Proof invalidation when the Plex card or Shoko link changes must remain intact.

---

### Task 1: Bounded alternate-card proof

**Files:** `src/availability/observe-file-candidate-target.mjs`, `src/availability/known-card-availability.mjs`, `src/availability/file-proof-ledger.mjs`, `src/web/user-service.mjs`, `src/web/user-app.mjs`, `src/web/public/app.js`, and focused tests.

**Interfaces:** The file-centric observer adds validated same-series Shoko episode IDs to its transient Shoko observation. `observeKnownCardAvailability` may match a public episode card with one of those IDs only for a series target and a single-file observation. Such a proof carries `presentation: 'alternate_card'`; the file-proof ledger persists this marker and the episode-detail API renders it as a note.

- [x] Add a failing test with two full Shoko links and one public Plex card, then run it red.
- [x] Add wrong-show, unrelated episode and different-file cases; confirm they remain unverified.
- [x] Implement the narrow identity alternative without changing physical proof.
- [x] Write and pass a failing ledger test for the alternate-card marker and exact-card preference.
- [x] Write and pass focused presentation-helper and API tests for the note; add a browser fixture. The local Windows Edge browser test returned an empty DOM before reaching the fixture, so Linux CI still needs to run it.
- [x] Run focused availability suites and review the diff.
- [x] Verify against the read-only *IS: Infinite Stratos 2* file/card evidence without changing production: a separate Node process in the running container loaded the candidate source via in-memory module URLs, read Shoko file 1557 and public Plex card 473558, and returned `available` with `presentation=alternate_card`, the expected file/part IDs and a card revision. It used a read-only SQLite connection and performed no ledger write.
