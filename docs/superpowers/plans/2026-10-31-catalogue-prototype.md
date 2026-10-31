# Read-only Catalogue Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove that Negev can search AniDB titles beyond Shoko's local library and present truthful title-only results without enabling premature requests.

**Architecture:** A bounded Shoko v3 search adapter obtains AniDB title-cache hits. A Fastify app factory exposes a read-only search route only to a private test token through `inject()` tests. There is no listener, account system, Docker deployment, downloader, or production change in this slice.

**Tech Stack:** Node.js 24, Fastify 5.12.7, built-in test runner.

**Spec:** Owner-approved Negev boundaries in `README.md`; private installed-interface evidence remains outside this public repository.

## Global Constraints

- A title-only hit is not episode detail, a requestable show, or availability proof.
- No Shoko metadata refresh or series creation is triggered by search.
- API credentials stay in a header, never in a URL, response, log, or repository file.
- No live request or production setting changes in this prototype.

## Review Focus

- Unowned title appears with AniDB ID but remains unrequestable.
- Malformed or non-200 Shoko responses fail closed.
- Long or blank queries do not hit Shoko.
- Unauthenticated route calls do not search.
- A route response never returns the test credential or Shoko endpoint.

---

### Task 1: Shoko AniDB title search adapter

**Files:** `src/catalogue/shoko-search.mjs`, `test/shoko-search.test.mjs`

- [x] Write failing tests for a title-only unowned hit, bounded query, header auth, and malformed response.
- [x] Implement GET-only Shoko search and normalized non-requestable results.
- [x] Run the local tests.

### Task 2: Private Fastify route

**Files:** `src/web/app.mjs`, `test/app.test.mjs`

- [x] Write failing `inject()` tests for health, unauthorized search, valid search, and query validation.
- [x] Implement an app factory with no listener and no write routes.
- [ ] Run the full suite and Linux CI.

### Task 3: Repository hygiene

**Files:** `package.json`, `pnpm-lock.yaml`, `.gitignore`, `README.md`, `.github/workflows/test.yml`

- [x] Pin dependencies, prevent local dependencies or credentials from being committed, and install only in CI.
- [ ] Review the published diff for private data; publish after verification.
