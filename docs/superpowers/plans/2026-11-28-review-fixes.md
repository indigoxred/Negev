# Reviewed workflow fixes implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task. Test and independently review every batch before merging to main.

**Goal:** Resolve the checked review findings in the user's approved order without weakening acquisition safety.

**Architecture:** Retain the durable request/attempt journals and one-send boundaries. Repair the transitions that strand legitimate work; keep uncertain observations distinct from positive ownership or identity conflicts. Keep each batch independently testable and merge only after tests and fresh review pass.

**Tech stack:** Node.js 24, SQLite, Fastify, browser ES modules, existing pnpm dependencies.

**Spec:** User-approved checked review and to-do list, recorded in `outputs/Negev-v336-Reviews-Checked-To-Do.txt` outside this checkout; original reviews are attached to the chat. Starting revision: `7712c94` (v0.0.336).

## Global constraints

- Preserve exact torrent/hash/file/episode identity, current account access, storage and ownership checks, manual choices, quality rules and preferred groups.
- Never resend uncertain add/start/delete operations. Never infer absence from a provider failure.
- Preserve full saved request scope, completed history, durable claims and restart safety.
- Keep the separately deferred multipart-hardlink condition out of scope. Keep installed rescan qualification open until actual evidence exists.
- Use failing regression tests before production changes; keep normal seasons and Airing controls passing.
- Review and test each batch before merging to main; do not leave completed work unpushed.

## Review focus

- Provider outage versus positive conflicting ownership: retries must never grant download permission.
- Partial packs and combined videos: never split a physical file or silently change a saved manual torrent.
- Replays and crashes around selection/add/start/delete: journal state must precede external effects and recover without duplicate sends.
- Account disable/cancellation/permission changes during awaited work: recheck current access at the effect boundary.
- Legacy databases and large libraries: additive, bounded, restart-safe transitions with retained history.

## Batch 1 — Acquisition blockers (C01–C03, N01)

1. [ ] N01: test real first-time collectors, durable start queue, repeated outages and reopen. Preserve transient provenance in `collect-unimported-targets.mjs` / `collect-target-scoped-uncertain.mjs`, classify retry reasons in `stage-hold-policy.mjs`, and revive only matching legacy transient holds. Positive imported/conflicting observations remain held. Tests: collector tests, `start-queue.test.mjs`, integrated season acceptance.
2. [ ] C02: test full absolute pack versus selected-subset replay and a usable alternative. Revalidate using the complete independently checked file context in `acquisition-request-processor.mjs`; keep the final metainfo/ancestry boundary in `submit-missing-candidate.mjs`. Do not trust a preview offset alone. Preserve cached previews and explicit manual selections.
3. [ ] C03: test accepted stopped add with unapplied exclusions, lost acknowledgement after applied exclusions, foreign/changed manifests, reopen and one add/start. Persist the exact checked selection before dispatch in the acquisition ledger; restore exclusions only after exact owned, pristine stopped-torrent and complete metainfo verification. Files: acquisition ledger, stopped submit, recorded start, manifest observer, new regression tests.
4. [ ] C01: test ownership gained before add and after add/before start, with the remaining episodes acquired. Shrink only a positively verified remaining physical-file selection; retain full request scope and journal the change before priority writes. Never split combined files; retain current missing-target and final start checks. Test ordinary season sizes/ownership patterns and Airing controls.
5. [ ] Run targeted safety suites, complete unit suite, Linux browser/CI checks, and fresh whole-branch review. Fix important findings and repeat affected checks before merging.

## Remaining batches — Execute in the approved order

2. [ ] Recovery: uncertain operator removals; renamed publications, alternate locations, first-read proof invalidation and multipart proof attribution; supported legacy publish replay. Reproduce each condition first.
3. [ ] Operations: generic exception responses, ordered shutdown after failures, recent scanner initialization/status and orphan retirement, pure-move retirement CLI.
4. [ ] Artwork and guidance: small icon assets, cold-request compression cost, accurate legacy/pure-move mount examples.
5. [ ] Account/request lifecycle: paused-watch sponsorship with one effective owner, settled refusals on deletion, cancelled preparation replay and legacy promotion receipts.
6. [ ] Member workflows: chooser continuation/capabilities, preview lifecycle, mixed Auto reviews, signed-out update preservation, invitation pagination, safe history and tracked-title display facts.
7. [ ] Performance: actual invalidation indexes and optional metadata outside history's access-decision critical path.
8. [ ] Cleanup/polish: subtitle sidecars, single folder normalization, preparation/source labels, title tabs, cancellation interaction, missing artwork, measured asset loading and proven-unused code/dependency cleanup. Keep compatibility evidence and all safety checks.

Each remaining batch gets concrete file/interface/test details in the execution ledger after its failures are reproduced. Do not implement speculative cleanup solely from a static count.
