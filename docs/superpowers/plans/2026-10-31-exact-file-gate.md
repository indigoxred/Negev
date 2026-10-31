# Exact File Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Negev decide whether a completed video is the exact AniDB registered release requested, without exposing it to Shoko Import or Plex.

**Architecture:** A streaming ED2K module hashes local bytes. A separate pure evaluator checks Shoko's AniDB release-preview response against the hash, size, anime ID and exact episode IDs. The network adapter and file handoff are later tasks; this first slice cannot import anything.

**Tech Stack:** Node.js 24 built-in test runner and filesystem APIs, no runtime dependencies.

**Spec:** The product boundaries in `README.md`; the fuller feasibility and build plan remains private in the owner's Media Overhaul workspace.

## Global Constraints

- Every accepted video must have an exact AniDB file registration and requested anime/episode identity.
- A failure, incomplete response or wrong identity never authorizes import.
- No production settings, downloads, media, or credentials are touched by these tests.

## Review Focus

- Wrong anime with a matching hash is rejected.
- Missing or extra episode cross-references are rejected.
- A malformed file URI or mismatched ED2K/size is held.
- A file that changes during hashing is rejected.
- A no-match response is held; an integration error is never misreported as an AniDB no-match.

---

### Task 1: Streaming ED2K

**Files:** `src/identity/ed2k.mjs`, `test/ed2k.test.mjs`

- [x] Bring the private, previously red/green-tested ED2K module and vectors into this clean checkout.
- [x] Run the four vectors and inspect the output.
- [x] Preserve the independent real-file Shoko comparison in the private workspace only.

### Task 2: Pure AniDB preview evaluation

**Files:** `src/identity/evaluate-preview.mjs`, `test/evaluate-preview.test.mjs`

- [x] Write tests for matching identity, wrong anime, missing/extra episodes, hash/size mismatch, malformed URI, and unavailable response.
- [x] Run tests and observe the expected failure.
- [x] Implement only the pure decision logic, returning an explicit accepted/held/rejected state and reason.
- [x] Run the full local test suite and inspect output.

### Task 3: Reviewable repository base

**Files:** `package.json`, `README.md`

- [x] Document the current slice and its limitations without claiming a working downloader or availability service.
- [x] Verify the public tree contains no credentials, private evidence or media.
- [x] Commit locally after tests pass. The owner supplied the Negev repository and authorized proceeding; the initial public tree was published and verified.

### Task 4: Read-only Shoko adapter

**Files:** `src/identity/shoko-preview.mjs`, `test/shoko-preview.test.mjs`

- [x] Write a failing test for the installed provider preview URL, header-only credential, 200 JSON, 204 ambiguity, and transport failure.
- [x] Implement a GET-only adapter with injected fetch and a bounded timeout.
- [x] Run the full local test suite. Do not use a live credential or change Shoko.
