# Negev Discovery UI Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Negev's signed-in page into a clear discovery and request flow with truthful Plex status, artwork when an exact cached poster exists, and a separate Airing watch section.

**Architecture:** Keep the AniDB ID as the catalogue key. Reuse Negev's exact public Plex proof ledgers for positive badges and Shoko's image IDs for artwork. The browser receives only bounded, validated display fields; absent evidence stays Unknown. The existing request and acquisition paths remain unchanged.

**Tech Stack:** Node 24, Fastify, SQLite, plain browser JavaScript and CSS.

**Spec:** [Negev discovery UI design](../../ui-overhaul-design.md)

## Global Constraints

- Do not infer availability, artwork, or franchise identity from title text, request history, or an AniDB search hit.
- Do not expose Shoko or Plex credentials or permit arbitrary poster URLs.
- Preserve media, requests, active services, and the current owner preview while code is tested privately.
- Keep series and movies requestable and Specials distinct; retain keyboard and mobile operation.
- Do not present season/popularity browsing from the AniDB title dump; that requires a separate verified metadata source.

## Review Focus

- A missing or expired proof must render neutral, including while the Plex index catches up with a new import.
- A partially owned series must not receive a full-Available badge in search.
- Empty Shoko relations mean links are not cached, not that the franchise has no other title.
- Missing or malformed Shoko image IDs must fall back without a broken image or proxy request to a third-party host.
- Pagination and rapid search/detail switching must not mix results or request sections.

### Task 1: Honest discovery and franchise states

**Files:** `src/web/user-service.mjs`, `src/web/user-app.mjs`, `src/web/public/app.js`, `src/web/public/franchise-explorer.mjs`; focused tests beside existing user app and UI tests.

- [ ] Write a failing test for one exact public proof appearing as `in_library` in a search result, and zero/expired proof staying `unknown`; run it red.
- [ ] Implement a bounded search-result presence projection from existing direct, title-check and file-proof ledgers, with no new Plex network reads; run it green.
- [ ] Write a failing test for a zero-relation franchise response showing an honest `No cached related titles` state rather than a dead action; run it red.
- [ ] Update the browser flow so the action handles empty, loading and service-error states visibly; run it green.

### Task 2: Group requests and enable a bounded title check

**Files:** `src/web/public/index.html`, `src/web/public/app.js`, `src/web/public/style.css`, `src/web/public/request-progress-text.mjs`; focused request UI and route tests.

- [ ] Write a failing behavior test that active `monitorFuture && !watchClosed` requests are separate from one-time history, including pagination.
- [ ] Render `Watching now` and `My requests` sections, with a simple progress line and owner-only details behind Advanced; verify the test.
- [ ] Expose one title-level availability refresh using the existing bounded title-check job when configured; otherwise present saved evidence with a clear `Not checked` state. Do not loop one-episode requests from the browser.
- [ ] Verify authenticated and anonymous behavior, request IDs, keyboard focus and mobile layout.

### Task 3: Exact cached artwork

**Files:** `src/catalogue/shoko-search.mjs`, `src/catalogue/shoko-detail.mjs`, a focused image proxy in `src/web`, `src/web/public/app.js`, `src/web/public/style.css`; source parser, route and UI tests.

- [ ] Write failing tests for valid/missing/malformed Shoko poster IDs and image response type/size bounds.
- [ ] Return a validated poster UID only when Shoko reports it Available for the same AniDB title; add a same-origin bounded image route that authenticates to Shoko server-side and caches safely.
- [ ] Render poster cards and detail artwork with an intentional fallback, semantic text and lazy loading; verify tests and one live cached poster.

### Task 4: Discovery layout and acceptance

**Files:** `src/web/public/index.html`, `src/web/public/app.js`, `src/web/public/style.css`; existing UI tests plus manual live review.

- [ ] Make Discover the first view, with obvious Search, Watching and My Requests navigation. Give results a responsive card grid and a single primary action in details.
- [ ] Run focused and full tests, audit the diff and credentials, then publish a versioned candidate.
- [ ] Validate the candidate as the owner on desktop/mobile widths: search, artwork fallback, franchise positive/empty, series/movie requests, partial/available/unknown badges, monitoring and request history. Keep old candidate for rollback until accepted.

### Future slice: seasonal and historical browse

Select a maintained, license-compatible anime metadata feed carrying exact AniDB IDs and real season/date/rank fields. Design and test its stale/ambiguous mapping behavior before adding current-season and popularity browse. This is a separate delivery gate, not a fake sort over the AniDB title list.
