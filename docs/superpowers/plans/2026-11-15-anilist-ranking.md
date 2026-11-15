# AniList ranked Browse implementation plan

> **For agentic workers:** Use the existing in-session implementation workflow. Steps use checkboxes for tracking.

**Goal:** Show credible top-rated and popular anime instead of sorting Negev's sparse MAL score cache as though it covered the catalogue.

**Architecture:** Keep AniDB IDs and AniMap's exact MAL-ID mapping for catalogue, requests, matching, and availability. Fetch bounded public AniList top lists for display order and score only. Cache successful results for 12 hours; retain a last-known-good snapshot through short source outages. Never infer a join from title. For entries outside the ranked slice, keep the existing newest ordering and describe that limit in the UI.

**Tech Stack:** Node 24, Fastify, SQLite, AniList GraphQL, browser JavaScript.

**Spec:** Owner's 15 November 2026 request to replace random ranking with a top list like MAL/AniList, and choice of AniList as the immediate source.

## Constraints

- No score may authorize a request, download, match, import, or Plex availability claim.
- Use a small shared server-side cache, never one AniList call per viewer or title.
- Fetch only the bounded top 150 for score and popularity; do not collect the full AniList database.
- Preserve all catalogue sorts other than score and popularity.
- Leave an unmapped AniList title out of the ranked join rather than guessing by title.

## Steps

1. [x] Add a failing source test for one bounded AniList response, exact MAL IDs, cache reuse, outage retention, and malformed-response rejection.
2. [x] Implement the ranking source and persisted snapshot with a bounded response, timeout, and 12-hour refresh.
3. [x] Add a failing catalogue test showing Frieren first despite a sparse unrelated MAL score cache; verify the rest remain in stable newest order.
4. [x] Integrate ranked score/popularity sorts and source-labelled card ratings. Keep request and availability contracts unchanged.
5. [ ] Run focused and Linux browser tests, verify the public ranked first page, then publish a versioned image and guarded deployment with request-count and health checks.
