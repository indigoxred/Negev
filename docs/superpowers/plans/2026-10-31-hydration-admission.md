# Catalogue Hydration Admission Plan

**Goal:** Allow a future Negev detail page to request Shoko's supported one-ID AniDB metadata refresh without issuing duplicate or unbounded calls.

**Scope:** A pure admission decision only. No database, web route, scheduler, background worker, credentials, or live Shoko call is added in this slice.

**Policy:** A title must first be known in the AniDB title cache and its detail GET must return `detail_pending`. A future durable coordinator must serialize refresh claims across all workers. The default admission policy allows at most one active refresh, at least 60 seconds between global submissions, no repeat submission for the same title within 24 hours, and at most 30 submissions per rolling 24 hours. A Shoko outage or invalid catalogue identity never triggers a refresh. These are conservative Negev limits, not AniDB's published limits.

**Tests:** Given persisted timestamps and counts, prove new admission, same-title cooldown, global spacing, active-job hold, daily budget, clock skew, and non-pending or unavailable detail. The decision must return a reason and next eligible time where possible. Repeated reads are pure and cannot themselves call Shoko.

**Before operational wiring:** Implement an atomic durable claim/lease and crash recovery; cap the poll loop; observe Shoko's ban/queue status; test concurrent requests and restart; keep detail state pending until the installed GET returns valid exact episode IDs. A 200/queued refresh response alone never authorizes a request.
