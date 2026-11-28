# Account 18+ access

The administrator's account permission is enforced by the server. The personal “Show 18+ titles” switch only changes browsing preferences; hiding titles does not cancel requests or revoke an account's permission.

## New work and existing work

- New reservations, stopped-torrent additions and download starts require a fresh server-side title classification. Restricted titles require the current request owner's 18+ permission. Unknown classification holds new work until verification succeeds.
- Classification covers the main title and any retained bonus titles. The final database transaction rechecks the enabled owner and current permission before recording a new send intent.
- Revocation pauses new work without deleting its request, saved choice, target claims or history. Access and metadata holds keep a durable paced retry across restarts. Re-enabling permission makes the work eligible at its next retry; it does not bypass identity, availability, ownership or download checks.
- An already-recorded add/start intent remains one-send. Reconciliation, completion and publishing can finish work already sent. Revocation does not remove files or delete torrents. A definitive rejected send must pass authorization again before a retry.

## Metadata and request controls

- Restricted accounts receive named catalogue results and artwork only for verified all-ages titles. Related titles, browse lists, request/preparation history and owner review follow the same rule. Unknown/restricted history retains a generic label and safe request identity/status/cancellation controls.
- UID artwork needs a server-observed association with a title. An unverified UID after restart stays withheld until normal search observes its identity again.
- Release controls check both the acting account and the saved request's owner. An administrator's role does not bypass either account's 18+ restriction. A permission change during a provider read must be checked again before the result is returned or a selection is committed.
- Account-gated metadata uses `no-store`. The server rechecks the session after asynchronous work and reports the current permission in authenticated response headers.

## Browser updates

The browser synchronizes permissions on relevant API responses and at most once per minute while visible. An unchanged session check preserves typed work. A permission transition invalidates pending responses, cached title metadata and retained cards/details before re-rendering. Re-enabling permission preserves the user's personal hiding preference. Previously seen data cannot be made unseen; this policy prevents further unauthorized metadata responses and new acquisition.

## Verification

Regressions cover revocation during provider reads and downloader preflight, reclassification, unknown metadata, retained bonuses, rejected-send retry, session/account changes, durable retry and restart. Fixtures use disposable state and synthetic providers; they do not change production accounts or start production downloads.
