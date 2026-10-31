# Negev

Negev is an early, self-hosted anime request and acquisition prototype. Its private diagnostic can search AniDB titles through Shoko and record exact requests in a **held** state. It cannot acquire, import, or report live availability yet and is not an end-user request site.

The gate calculates a completed video's ED2K hash, calls Shoko's read-only AniDB release-preview endpoint, and evaluates the response against its exact file size, AniDB file registration, anime ID, and requested episode IDs. An uncertain or incorrect result does not authorize import. In particular, Shoko's HTTP 204 response is inconclusive because its provider can also return 204 during an AniDB ban. The adapter is tested with fake responses only; it has not been connected to a live Negev service.

Run `pnpm install --frozen-lockfile` and `node --test` using Node.js 24. Tests use synthetic responses and make no live server calls.

## Intended boundaries

- Series and movies are independently requestable installments grouped by franchise.
- Every video accepted for import must match an AniDB-registered file and the requested anime/episode identity.
- Airing requests can monitor future episodes; completed requests are one-time acquisitions.
- Shoko and public Plex remain the authorities for final imported identity and playback availability.
- Direct Shoko imports must update availability without creating a Negev request.
- Negev must not expose incomplete downloads to Shoko or Plex.

The staging path guard checks regular video files inside an app-owned directory, rejects path escapes and symlinks, then performs the read-only identity check. A separate pure qBittorrent v5 evaluator checks torrent ownership, completion, selected files, and the staging save path. It holds an entire pack if any selected video is unfinished or an unexpected file is selected. These pieces are not yet wired to a live qBittorrent session and do not move a file.

A private Fastify service searches Shoko's AniDB title cache and reads cached AniDB episode detail. An unowned title with no detail row stays **details pending**. The explicit detail-load action requires a recent successful search hit, reads bounded episode pages, reserves a durable SQLite claim, and submits at most one metadata refresh. Catalogue GETs remain read-only. A refresh response never proves detail is complete, and uncertain submissions remain held.

A pure request-intent planner selects exact AniDB episodes from complete detail. Airing whole-installment requests mark future regular episodes for monitoring; Completed requests are one-time; explicit Specials do not add the rest of the installment. A private request route now combines complete Shoko detail, date-based release-state inference, the planner, and a durable ledger. It rejects client-supplied requester/status fields and holds restricted, unknown, or incomplete titles. Its single test requester is **not** an end-user account system, and nothing consumes the saved requests for acquisition yet.

The SQLite request ledger preserves exact intent across restarts. A submission key makes retries idempotent without preventing a later request for the same scope. Its schema keeps separate user histories while sharing exact AniDB episode targets. Every record remains held for availability evidence. The ledgers use Node 24's release-candidate `node:sqlite` API, which needs production review.

A pure availability evaluator accepts normalized, complete Shoko and Plex observations. It counts an episode Available only when an exact AniDB anime/episode file has a readable media part in an allowed **public** Plex library. A Shoko-only file waits for Plex; a private/test Plex part does not count; observer outages become Unknown. The Shoko-to-Plex storage-key adapter and live observation are **not implemented**, so this evaluator cannot yet report production availability.

The Dockerfile runs only the **private diagnostic**. Startup requires `NEGEV_PRIVATE_TEST=1`, a Shoko URL/key, a test bearer token of at least 16 characters, and `NEGEV_DATA_DIR`. It binds loopback inside the container by default; all-interface binding additionally requires `NEGEV_EXPOSE_PRIVATE_TEST=1`. It has a held-request route but no end-user accounts or download route; do not expose it to other users or treat it as a Negev release. GitHub CI builds and smoke-tests the image with synthetic environment values and no network access; it does not publish or deploy the image.

A pure release-state helper infers Airing, Completed, Upcoming or Unknown from AniDB start/end dates and regular episode dates. Its result is labelled **inferred** because AniDB cannot reliably distinguish a hiatus or cancellation from an ongoing release. The private held-request route uses it, but the installed Shoko API date fields still need a read-only check. No future-episode worker runs yet.

The end-user web app, real accounts, indexer/qBittorrent control, Shoko handoff, and live Plex observation are **not implemented**. No production service has been changed for this repository.

Do not commit credentials, NAS configuration, database copies, logs, operational evidence, or media to this public project.

