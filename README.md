# Negev

Negev is a planned, self-hosted anime request and acquisition app. This repository currently contains only the first **read-only identity gate**. It is not yet a request site, downloader, Shoko importer, or availability service.

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

A private Fastify app factory can search Shoko's AniDB title cache and read AniDB episode detail already present in Shoko under a synthetic test token. Every result remains **not requestable** until the remaining identity and availability rules are proved; an unowned title with no detail row stays **details pending**. The isolated detail-load action requires the exact AniDB ID to have appeared in a recent successful search. Its coordinator reads every bounded episode page, checks consistent title and episode identities, reserves a durable SQLite admission claim, and submits at most one metadata refresh. Catalogue GETs remain read-only. A refresh response never proves that detail is complete, and uncertain submissions remain held. One service factory now wires these pieces together and has a synthetic search-to-refresh-to-detail integration test. It does not open a network listener or contain live credentials. The ledger uses Node 24's release-candidate `node:sqlite` API, which needs production review. The end-user web app, live catalogue hydration, downloader control, Shoko handoff, Plex observation, request persistence, and Docker image are **not implemented yet**. No production service has been changed for this repository.

A separate pure request-intent planner can select exact AniDB episodes from complete detail. It distinguishes an Airing installment that monitors future regular episodes from a Completed one-time acquisition, and allows explicit Specials without adding the rest of the installment. It requires a trusted Airing/Completed classification; Negev does not yet obtain that classification from Shoko, expose a request route, or connect this planner to the request ledger.

An isolated SQLite request ledger can now preserve exact user intent across restarts. A submission key makes retries idempotent without preventing a later request for the same scope. Different users retain separate request rows while sharing exact AniDB episode targets. All rows remain held for availability evidence; this is a storage test, not a working request endpoint or download scheduler.

A pure availability evaluator accepts normalized, complete Shoko and Plex observations. It counts an episode Available only when an exact AniDB anime/episode file has a readable media part in an allowed **public** Plex library. A Shoko-only file waits for Plex; a private/test Plex part does not count; observer outages become Unknown. The Shoko-to-Plex storage-key adapter and live observation are **not implemented**, so this evaluator cannot yet report production availability.

A pure release-state helper can infer Airing, Completed, Upcoming or Unknown from AniDB start/end dates and regular episode dates. Its result is labelled **inferred** because AniDB cannot reliably distinguish a hiatus or cancellation from an ongoing release. The installed Shoko API date fields have not yet been sampled for this helper, so it is not connected to request creation or monitoring.

Do not commit credentials, NAS configuration, database copies, logs, operational evidence, or media to this public project.

