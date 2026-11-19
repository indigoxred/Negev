# Bounded Shoko rescan for exact Negev imports

**Goal:** Recover a Shoko file job that leaves an exact Negev-imported file unlinked after the Shoko queue settles, without moving, rehashing, replacing, or deleting media.

**Architecture:** Keep this recovery separate from the existing single-file replacement path. Journal one rescan intent per exact published file before calling Shoko's supported targeted Rescan endpoint. Verify the file's accessible Shoko path, size, and ID on two observations while the Shoko queue is idle; then send at most one Rescan and recheck the exact link through Shoko and Plex. A failed or uncertain send stays visible in the journal and does not silently retry.

**Tech stack:** Node 24, `node:sqlite`, Shoko API v3, existing Negev acquisition scheduler.

**Scope:** One bounded automatic Shoko rescan for exact imported files remaining unlinked after the queue settles, with no rehash, replacement, or deletion.

## Global constraints

- Shoko remains the identity authority. Negev never assigns a manual episode link.
- The existing completed pack and its qBittorrent torrent remain intact.
- Bound API work to one file per recovery tick and one rescan per file.
- Unrelated Plex libraries, Shoko jobs, and other requests must continue.
- Persist intent before any API write so a restart cannot send an unbounded duplicate.

## Tasks

### 1. Exact file witness and durable intent

- [x] Add a failing test for a 12-file manifest with two unlinked exact files; only those two qualify after two idle observations.
- [x] Add tests for wrong path, wrong size, changed Shoko ID, active queue, and an already linked file.
- [x] Implement a per-file journal and bounded candidate selection, then run the focused tests.

### 2. Supported Shoko rescan and reconciliation

- [x] Add a failing HTTP client test for `/api/v3/File/{id}/Rescan?priority=true`, including ambiguous or failed responses.
- [x] Implement a single targeted POST, never a rehash or file mutation.
- [x] Add a failing worker test that journals before POST, sends once, and observes the exact Shoko link later.
- [x] Add restart tests proving a dispatched intent cannot send again; confirm unrelated attempts advance.
- [x] Wire the worker into the existing paced acquisition cycle and run focused tests.

### 3. Verification and release

- [x] Run focused and broad local checks, then inspect the diff for scope, credential, and media-safety issues. The full Linux suite remains a release gate because several unchanged filesystem tests fail on Windows.
- [ ] Publish through the existing release process and verify health, zero restarts, and no new qBittorrent 403s.
- [ ] Verify existing Shoko/Plex availability remains unchanged. A live successful import without a new failed Shoko job does not prove the new recovery branch; retain its isolated failure tests as that evidence.
