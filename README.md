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

A private Fastify app factory can search Shoko's AniDB title cache and read AniDB episode detail already present in Shoko under a synthetic test token. Every result remains **not requestable** until the remaining identity and availability rules are proved; an unowned title with no detail row stays **details pending**. The isolated detail-load action requires the exact AniDB ID to have appeared in a recent successful search. Its coordinator reads every bounded episode page, checks consistent title and episode identities, reserves a durable SQLite admission claim, and submits at most one metadata refresh. Catalogue GETs remain read-only. A refresh response never proves that detail is complete, and uncertain submissions remain held. These components have only synthetic integration tests; they are not configured with live credentials or connected to a running Negev service. The ledger uses Node 24's release-candidate `node:sqlite` API, which needs production review. The app factory has no listener. The end-user web app, live catalogue hydration, downloader control, Shoko handoff, Plex observation, request persistence, and Docker image are **not implemented yet**. No production service has been changed for this repository.

Do not commit credentials, NAS configuration, database copies, logs, operational evidence, or media to this public project.

