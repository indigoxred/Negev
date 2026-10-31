# Catalogue search proof and complete episode pages

**Goal:** Make the isolated detail-load action accept only AniDB IDs observed in a recent valid search, then read every bounded episode page before accepting detail.

**Search proof:** Keep a short-lived, capacity-limited, in-memory set of AniDB IDs returned by validated catalogue search responses. A restart or expiry fails closed. The Fastify search route records hits only after a successful response; the hydrator consults this registry. It does not infer ownership from a raw numeric ID.

**Pagination:** Read page 1, then follow `nextPage` sequentially with a strict page cap. Require the same AniDB ID, title, kind and total on every page. Reject duplicate episode IDs and pages that stall, repeat, skip or change totals. Only the exact concatenated set with `episodes.length === total` becomes complete. A page limit remains pending, not requestable, and never triggers a metadata refresh.

**Tests:** Use synthetic search and detail adapters, Fastify injection, and temporary SQLite. Cover unseen and expired IDs, bounded registry size, no search side effects on failed results, multi-page detail, inconsistent pages, duplicate episode IDs, and no hydration POST for incomplete pages. No live service or media call.
