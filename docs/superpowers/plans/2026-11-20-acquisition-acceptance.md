# Acquisition acceptance and final release plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task by task.

**Goal:** Qualify the existing preferred-group implementation, exercise representative acquisition cases and publish a verified final candidate.
**Architecture:** Keep the existing coordinator, durable journals and stock provider APIs. Audit current Shoko/Plex same-file evidence privately; use isolated exact-pipeline tests for destructive/conflicting/restart scenarios rather than deleting acceptable media.
**Tech Stack:** Existing Node.js24, SQLite, Fastify, Browser fixtures and Docker. No new dependency, matcher or runtime helper.
**Spec:** Owner's acquisition items16–18 and existing compact-release workflow plan.

## Global constraints
- Preserve acceptable files and request histories. No manual identity links, title-specific fixes or hidden request recreation to manufacture success.
- Prefer group only within viable quality/peer tiers. First suitable alternative starts one durable two-hour deadline for the exact new Airing episode; completed seasons and historical catch-up do not wait.
- Existing active/playable fallback targets must not be regrabbed when the preferred group arrives later.
- Audit Japanese audio, English subtitles and quality through cached provider metadata and existing visual evidence; do not revive mandatory whole-video scans or infer burned-in subtitles are absent from missing subtitle tracks.
- Keep live evidence, isolated tests and unobserved natural arrivals distinct. The owner deferred new RSS-to-Plex observation until after this work.
- Public repository contains source, synthetic tests and installation guidance only; private operational evidence, paths, credentials, databases and media stay outside Git.

## Tasks
1. Verify existing deadline, restart, first-observation, expiry-without-RSS and independent-episode tests. Add the late-preferred-arrival duplicate regression across processor restart.
2. Audit all active request targets and retained owned files against fresh exact Shoko associations, source/VFS filesystem identity and public Plex metadata. Probe representative playable parts without reading whole media files.
3. Cover varied desired films, older DVD material, completed packs and Airing releases in private live checks. Exercise fresh submissions, retries, manual choices, prompts, conflicts, subtitles and restart behavior through isolated pipeline and Browser tests; state their limits.
4. Reproduce any status discrepancy in durable-journal tests before changing code. Scope current activity to still-unverified episodes so an older playable handoff cannot claim the next episode is being imported.
5. Pass review and full CI, publish a pinned versioned image, verify exact source/deployment identity and settings/history preservation, then clean only unused owned diagnostic resources.

## Status correction discovered during acceptance
The request summary counted every retained handoff as current import activity. After a new target was appended, old playable episodes could therefore produce an Adding-to-library message despite no download for the new episode. Derive current activity from exact episode IDs that remain unverified, retain immutable history/counts and preserve genuine pending transfers/imports. Do not infer progress by subtracting counts alone.

## Acceptance boundary
Fresh provider metadata and HTTP byte probes prove current availability, not uninterrupted full playback or every future release. Isolated two-hour clock tests prove the scheduling/duplicate rules without fabricating a real RSS event. A genuinely new end-to-end RSS arrival remains a separate acceptance observation.
