# Configurable paced Plex indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit a measured faster initial Plex index while retaining strict per-tick and single-flight limits.

**Architecture:** Parse one optional interval in the user-server configuration and pass it to the existing scheduler. Keep all source, page-size and recent-page behavior unchanged.

**Tech Stack:** Node 24, ESM, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-02-paced-plex-index.md`

## Global Constraints

- Default 60,000 ms; accepted explicit range 15,000–300,000 ms.
- Reject the option unless Plex indexing is enabled.
- One page of at most five cards plus at most one due retry per tick; no parallel ticks or acquisition change.
- Do not change the installed NAS container in this plan.

## Review Focus

- Missing value preserves the old pace.
- Bad, zero, fractional and out-of-range values fail configuration.
- Disabled observer with interval fails closed.
- Slow page completion cannot overlap the next tick.
- Recent-page visits keep their existing cadence.

---

### Task 1: Parser and scheduler boundary

- [x] Add failing tests for explicit 15-second scheduler intervals and configuration parsing, including invalid and disabled cases.
- [x] Run only those tests and confirm the expected failures.
- [x] Change the scheduler minimum, parse the optional interval, and pass it from the server composition.
- [x] Run focused and full Node tests; inspect the diff.
- [ ] Commit the private source change without deploying it.
