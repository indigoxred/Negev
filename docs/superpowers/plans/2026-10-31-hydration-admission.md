# Catalogue Hydration Admission Plan

**Goal:** Allow a future Negev detail page to request Shoko's supported one-ID AniDB metadata refresh without issuing duplicate or unbounded calls.

**Scope:** A pure admission decision only. No database, web route, scheduler, background worker, credentials, or live Shoko call is added in this slice.

**Policy:** A title must first be known in the AniDB title cache and its detail GET must return `detail_pending`. A future durable coordinator must serialize refresh claims across all workers. The default admission policy allows at most one active refresh, at least 60 seconds between global submissions, no repeat submission for the same title within 24 hours, and at most 30 submissions per rolling 24 hours. A Shoko outage or invalid catalogue identity never triggers a refresh. These are conservative Negev limits, not AniDB's published limits.

**Tests:** Given persisted timestamps and counts, prove new admission, same-title cooldown, global spacing, active-job hold, daily budget, clock skew, and non-pending or unavailable detail. The decision must return a reason and next eligible time where possible. Repeated reads are pure and cannot themselves call Shoko.

**Before operational wiring:** Implement an atomic durable claim/lease and crash recovery; cap the poll loop; observe Shoko's ban/queue status; test concurrent requests and restart; keep detail state pending until the installed GET returns valid exact episode IDs. A 200/queued refresh response alone never authorizes a request.

## Next private slice: durable reservation

Use Node 24's built-in SQLite only for an isolated ledger prototype. The module accepts a caller-owned database path; no server path or production connection is embedded. In a `BEGIN IMMEDIATE` transaction, read the recent submission history and active reservations, apply `planHydration`, and insert a reservation before any possible Shoko call. A reservation survives restart and cannot turn into a second submission just because the worker died. Expose only reserve, inspect, and close operations; do not add a Shoko caller yet. Test two connections to one temporary database, restart, lease expiry, daily counts, and a completed detail observation. The `node:sqlite` API is still a Node 24 release candidate, so review that dependency before production packaging.

- [x] Test reservations through two connections, restart, lease expiry, daily budget, and exact completion evidence.
- [x] Implement the isolated SQLite reservation ledger with no network caller.
- [ ] Run the full suite and Linux CI, then review the public diff for private data.
