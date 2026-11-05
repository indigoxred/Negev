# Alternate-card direct status implementation plan

> **For agentic workers:** Execute this small plan inline with test-driven development.

**Goal:** Preserve the existing playable alternate-card explanation when a direct public Plex check refreshes an episode's Available status.

**Architecture:** Carry the observer's `alternate_card` presentation alongside the direct queue's exact file/card proof. Default existing rows to an unspecified presentation, migrate without withdrawing their availability, and pass the saved presentation to the episode display composer. Availability and acquisition decisions do not change.

**Tech stack:** Node.js, SQLite, `node:test`.

**Spec:** Owner's 6 November approval of the rare correct-show, same-file playable rule; existing `observeKnownCardAvailability` and `episodeDisplayAvailability` behavior.

## Tasks

- [x] Add failing direct-queue tests for alternate-card persistence, malformed presentation, old-schema migration and card invalidation.
- [x] Add a failing display test: a direct Available proof with `alternate_card` keeps the note; a direct exact proof does not.
- [x] Add a nullable presentation column to the direct queue, preserve it through the worker, expose it in `getStatus`, and pass it through the existing display composition.
- [x] Verify: 29 direct/display tests and 25 service integration tests passed; the browser shell test passed with local loopback access outside the Windows sandbox. Review confirms no availability or acquisition decision changed.
