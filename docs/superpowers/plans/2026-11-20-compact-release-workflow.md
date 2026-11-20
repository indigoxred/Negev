# Compact release workflow implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task by task.

**Goal:** Implement the user's compact Seerr-like Auto-Pick/Manual Pick flow, default BD/1080p+ and audio filters, and a working Airing group preference.
**Architecture:** Keep the existing durable selection and guarded acquisition pipeline. Replace verbose release cards with compact rows and expandable evidence. Save a checked future-group preference with the exact manual selection; apply it to new Airing episodes through a durable two-hour deadline using the existing acquisition scheduler.
**Tech Stack:** Existing Node.js, SQLite, Fastify and browser JavaScript. No new application, dependency, matcher or media scan.
**Spec:** User feedback and screenshots of20November after items13–15 live verification; earlier approved acquisition item16 supplies the two-hour group-fallback semantics.

## Global constraints
- Title page → Request → submenu with prominent Auto-Pick and Manual Pick actions; preserve season/film selection and cancellation.
- Manual list keeps group, size, seeds, quality and advertised audio visible. Full torrent title remains a compact identifier; file/registration evidence stays expandable.
- Default quality is BD OR1080p-and-higher, including BD names without a resolution. Other quality filters may expose older lower-resolution releases. Do not silently alter Auto's normal quality policy.
- Japanese is the default audio filter, with dual-audio and English-dub choices. Explicit manual selection is authoritative; requested language/UHD exceptions are scoped to that saved manual choice, not global acquisition.
- The preference checkbox appears only for metadata-confirmed Airing series. It saves a parsed group for this installment, not an exact torrent to reuse for another episode.
- Prefer the selected group on new future episodes only. At the first suitable nonpreferred alternative, retain one durable two-hour deadline. Hourly RSS may wake earlier; the scheduler must execute expiry without another feed event. Later alternatives cannot reset the deadline. Historical catch-up and completed seasons do not wait.
- At expiry, search again and take a suitable available release. Preserve a verified fallback for bounded provider failure recovery. Completion of existing downloads remains independent.
- Genuine new RSS proof remains after item18 for tomorrow; no synthetic acceptance claim.

## Review focus
- Default BD/1080+ includes BD with absent resolution and does not hide high-resolution BD.
- English-dub/manual UHD permission cannot escape into unrelated Auto requests.
- Closed menus, multi-season flow and film requests cannot accidentally submit or create duplicates.
- Preferred group availability, failed final search, restart and no-new-RSS expiry all progress without indefinite waits.
- An unrelated missing episode must keep progressing while a different episode waits for its preferred group.

### 1. Compact rows and filters
- [ ] Write failing pure filter/group/metadata tests and real-browser compact/filter tests.
- [ ] Add bounded server filtering over combined search prefixes and concise visible metadata; retain expandable evidence and exact receipts.
- [ ] Explicit manual policy is saved and rechecked without changing global defaults.

### 2. Request submenu
- [ ] Replace the extra review/dropdown step with Auto-Pick and Manual Pick actions in the existing series popup.
- [ ] Put film request choices in the same popup flow.
- [ ] Verify both modes, cancellation, partial/available seasons and batch continuity in the browser.

### 3. Airing group preference
- [ ] Persist group plus initial target set with selected release; validate Airing state server-side.
- [ ] Add durable per-episode alternative/deadline journal and scheduler retry deadline.
- [ ] Prefer suitable group matches within resolution/peer tiers; bound the wait to two hours and preserve independent missing work.
- [ ] Test restart, alternate ordering, deadline without RSS, provider failure at expiry and no wait for historical/completed work.

### 4. Verification and release
- [ ] Fresh-context review and appropriate complete tests.
- [ ] Push tested work, pass CI, merge main, deploy only Negev with backup/rollback.
- [ ] Live Browser check of compact layout, filters, request submenu and saved preference controls; clean temporary resources and repeat the checklist.
