# Stopped Acquisition Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the existing preflight, fresh missing-target reservation, and stopped qBittorrent submission gates for one explicitly selected release and episode subset.

**Architecture:** One server-side coordinator accepts a saved exact request, selected Prowlarr candidate, and explicit 1–50 episode subset. It prepares bytes, checks fresh Shoko/Plex absence, reserves the subset in SQLite, and invokes the existing one-send stopped submitter. It does not start a torrent, import media, infer candidate episode numbers, or mark availability.

**Tech Stack:** Node 24, existing Fastify/SQLite modules, node:test.

**Spec:** `outputs/Negev-Feasibility-and-Build-Plan-20261031.md` (private workspace, not part of this public repository).

## Global Constraints

- Keep production services and media unchanged.
- Every promoted video later requires exact AniDB file registration; preflight is not that proof.
- Hold on stale or incomplete availability, unsafe mount evidence, or uncertain qBittorrent state.
- No route or scheduled worker is added in this step.

## Review Focus

- Prowlarr unavailable: no target claim or qBittorrent call.
- Existing public episode: no claim or qBittorrent call.
- Stale/unknown observer: no claim or qBittorrent call.
- Unsafe staging mount: no qBittorrent call; reserved attempt remains inspectable for retry after repair.
- Repeated submission after uncertain add: never send a second add.

---

### Task 1: Compose the stopped acquisition gates

**Files:** Create `src/acquisition/submit-missing-candidate.mjs`; test `test/submit-missing-candidate.test.mjs`; update `README.md`.

**Interfaces:** `submitMissingCandidate({request,candidate,episodeIds,readEvidence,publicLibraryIds,ledger,now,prowlarr,qbittorrent})` returns a held decision or the stopped-submission result. `prowlarr` supplies the existing reader's options; `qbittorrent` supplies the existing submitter's options. The coordinator retains no new mutable state.

- [x] Write a real-ledger test with stubbed HTTP endpoints that proves prepare → fresh absence → subset reservation → one stopped add.
- [x] Run it and observe failure for the missing coordinator.
- [x] Implement only the composition needed to pass.
- [x] Add failure tests for Prowlarr, availability, mount, and replay; run targeted then full tests.
- [x] Review diff and publish only after passing verification.

### Task 2: Preserve the provisional file plan across restart

**Files:** Modify `src/acquisition/acquisition-ledger.mjs` and `src/acquisition/submit-missing-candidate.mjs`; test `test/acquisition-ledger.test.mjs` and `test/submit-missing-candidate.test.mjs`; update `README.md`.

**Interfaces:** `recordFilePlan({attemptId,hash,plannedFiles,nowMs})` binds one immutable filename/size/episode plan to an already bound torrent hash. `getFilePlan(attemptId)` returns that plan after restart. The coordinator requires an exact plan for every video in the torrent metainfo before a qBittorrent call.

- [x] Write and run a failing restart/conflict regression for the durable plan.
- [x] Implement its SQLite record and fail-closed validation.
- [x] Write and run a failing coordinator regression for a mismatched filename.
- [x] Require the exact metainfo plan before the stopped submission; confirm the focused tests pass.
- [x] Run the full test suite and review the changed files.
- [ ] Publish and verify Linux CI.
