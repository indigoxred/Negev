# Durable request intent and shared targets

**Goal:** Persist exact AniDB request intent without dispatching downloads. Several users may request overlapping episodes; each keeps a separate historical request while the episode target is stored once.

**Boundary:** The caller supplies a validated intent from the pure request planner and a trusted internal requester ID. The ledger revalidates shape, stores a canonical episode set and monitor choice in SQLite under `BEGIN IMMEDIATE`, and returns a held state. No delete, completion, retry, indexer or torrent action is exposed.

**Tables:** User request rows, episode target rows keyed by AniDB anime+episode, and request-to-target links. An authenticated submitter supplies one idempotency key per submission: a retry with the same key and exact scope reuses the request, while a later new key may create another historical request for the same scope. A different requester gets a distinct request row linked to the same targets. Overlapping scopes share target rows. Release-state classification is snapshotted in the intent, so a later metadata change cannot silently widen an old request.

**Tests:** Temporary SQLite databases; exact IDs survive restart, retry with one key is idempotent, reusing a key for a different scope conflicts, a new key can preserve a later request, two users retain separate requests with shared targets, overlap shares only common episode targets, malformed intent is rejected, and two DB connections preserve uniqueness. No live service.
