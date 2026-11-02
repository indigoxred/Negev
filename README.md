# Negev

Negev is a self-hosted anime request and acquisition project for series and films. It aims to combine a searchable anime catalogue, user requests, airing episode monitoring, guarded torrent acquisition, Shoko import, and public Plex availability in one Docker-hosted service.

**Status:** Early prototype. The source has synthetic tests, but broad availability, real download-to-import arrival, load, and end-user acceptance are not yet proved. Do not treat a successful unit test or healthy container as a production cutover.

## Design

- AniDB identifies anime installments and exact release files. A title match alone cannot authorize an import.
- Airing series retain a watch for future episodes. Completed titles are one-time acquisition requests. Films are requestable from the start.
- Candidate releases are inspected before qBittorrent starts them. Unexpected executable or archive content is held.
- Verified video bytes are prepared outside Shoko's watched Import folder and published only after exact AniDB file and episode checks.
- The acquisition worker checks that its private holding and watched Import roots resolve under one explicit, non-overlay container mount before copying or publishing. The intended bind source and atomic rename still need an installed check.
- Shoko identifies imported files; a readable, matching Part in an allowed public Plex library proves playback availability. An incomplete observation remains Unknown.
- Direct Shoko imports can update availability without a Negev request. A blocked or unrecognized item must not stop unrelated work.
- Acquisition and broad observers are separate opt-ins, disabled by default. Their live settings require measured load, rollback, and genuine arrival checks before use.
- The file backfill defaults to one file per tick. `NEGEV_FILE_BACKFILL_FILES_PER_TICK` can opt into 1–10 serial files under one shared limit of ten fresh Plex card reads and 64 physical metadata probes per tick; measure load before raising it.
- The Plex index defaults to one page of at most five cards, plus at most one due retry card, every 60 seconds. `NEGEV_PLEX_INDEX_INTERVAL_MS` can set 15,000–300,000 ms only when the index is enabled; each tick remains single-flight and the interval begins after that tick finishes. Measure NAS load before shortening it.

The current source includes guarded components for these flows, but the full operational chain remains unvalidated. See the source and tests for exact contracts. The planning files under `docs/superpowers/plans/` describe source work; they are not evidence of a deployed feature.

## Development

Use Node.js 24 and pnpm 11:

```sh
pnpm install --frozen-lockfile
node --test
```

The Dockerfile builds a non-root image. Starting the account server requires explicit configuration and private secret files; there are no public example credentials or server-specific paths in this repository. Keep tokens, databases, media, logs, installed configuration, and operational evidence outside Git.

Negev is independent of TV Sonarr and Radarr. It must not remove or modify existing services as part of installation.
