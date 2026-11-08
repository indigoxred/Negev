# Cold title requests

A signed-in user can save an installment request while exact episode metadata is being prepared. It appears immediately as **Preparing episodes**, survives restart, can be cancelled, and later becomes a normal Negev request without another click.

A pending intent has no episode targets and is never eligible for acquisition. Resolution reuses Negev's exact detail, release-state, adult-access and public-availability checks. A fully available title ends as **Already in library** without a grab. Unknown evidence stays unknown. The browser never invents episode IDs or file identity. Provider outages retry automatically at a bounded pace (at most once per ten minutes per title after backoff) because late AniDB and Shoko metadata may arrive much later. Permanent rejection stays visible.

Cancellation succeeds while the intent is pending and guarantees the worker will not submit it later. Once a worker claims it, the UI shows that finalization is in progress and does not offer cancellation of that preparation. A created normal request follows the normal request cancellation policy.

Acceptance requires restart and idempotency tests, cancellation and adult restrictions, both Airing and Completed resolution, source outage/recovery, no-target acquisition guard, request history, and an isolated cold title that saves intent within five seconds. Public review acquisition stays disabled during these tests.
