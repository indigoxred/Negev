# Request Activity Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let members distinguish active, completed, attention, and Airing-watch requests without mistaking one page for their full history.

**Architecture:** Keep the existing owner-scoped, paginated `/api/requests` contract. Group the loaded history rows by their evidence-based presentation group in the consumer UI; retain the existing separate Watching page and older-page cursor. Do not infer transfer progress from these groups.

**Tech Stack:** Vanilla JavaScript, Node 24 tests, Chromium browser fixture.

**Spec:** Approved Negev consumer WebUI brief, sections 5.5 and 6.

## Global Constraints

- Do not disclose another account's requests or raw downloader data.
- Keep pagination visible and preserve cards when appending older pages.
- Status labels must reflect existing evidence, never an inferred live transfer or ETA.
- Do not add a new framework or service.

## Review Focus

- A request with an owner-review state goes into Needs attention even when some Plex content exists.
- An old fulfilled request with stale playback proof remains Completed earlier, never Ready to watch.
- Appending an older page into an existing group does not duplicate cards or discard the cursor.
- Account switches clear rows and reject late responses from the prior account.
- Empty first page has a useful message; an empty loaded category never implies all history was searched.

---

### Task 1: Group loaded history rows

**Files:** Modify `src/web/public/app.js`, `src/web/public/index.html`, `src/web/public/consumer.css`; test `test/browser-consumer-shell.test.mjs`.

**Interfaces:** Consume `requestPresentation(...).group` (`active`, `completed`, `attention`, `watching`); produce ordered Needs attention, Active, Completed sections under `#request-list`.

- [x] Add a browser fixture with one request in each history group and assert the correct title under each visible heading.
- [x] Run the browser test and observe the missing headings.
- [x] Add ordered group sections without changing the server API or request ownership.
- [x] Run the browser test and the existing request presentation tests.
- [x] Commit the focused change.

### Task 2: Preserve pagination and account recovery

**Files:** Modify `src/web/public/app.js` if needed; test `test/browser-consumer-recovery.test.mjs`.

**Interfaces:** Consume the existing `nextBeforeId` cursor; append older rows to an existing group while preserving the session response epoch.

- [x] Add a browser case that loads a second history page, switches tabs, and checks rows and the older-page control.
- [x] Run it and observe any failure. The append path already passed; the added sign-out and held-Watching cases exposed two separate failures.
- [x] Correct the sign-out response boundary and load history independently of a pending Watching read.
- [x] Run both isolated browser tests and the full Linux Node suite; commit. GitHub Test run 42144662988 passed on the reviewed source head.

Ruling: A pending Watching read must not delay the History view. The two owner-scoped GETs now run concurrently; if this is wrong, the cost is one extra simultaneous read on route entry, within the existing two-request bound.

Final review found that awaiting both reads still delayed the owner review panel and sign-in completion. A browser regression failed with Watching held, then passed after both request reads and the owner review started independently. The same bounded reads and response-epoch checks remain.
