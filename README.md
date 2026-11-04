# Negev

Negev is a self-hosted anime request and acquisition project for series and films. It aims to combine a searchable anime catalogue, user requests, airing episode monitoring, guarded torrent acquisition, Shoko import, and public Plex availability in one Docker-hosted service.

**Status:** Early preview. Isolated genuine arrivals have completed download, exact AniDB file verification, Shoko import, and public Plex availability for two series episodes and one film. A separate manual qBittorrent-to-Shoko import also reached exact public Plex availability without a Negev request. An Airing watch is running, but acquisition of an episode released after the request is not yet proved. Broad load, end-user acceptance of a combined service, and production cutover remain unproved. Do not treat a successful pilot or healthy container as a production cutover.

## Design

- AniDB identifies anime installments and exact release files. A title match alone cannot authorize an import.
- Airing series retain a watch for future episodes. Completed titles are one-time acquisition requests. Films are requestable from the start.
- Candidate releases are inspected before qBittorrent starts them. Unexpected executable or archive content is held.
- Negev needs two configured paths for acquisition: its own mounted staging directory and the corresponding qBittorrent save root. It checks qBittorrent's reported save path and selected files before starting a torrent. It does not require or mount the Docker control socket.
- When acquisition is explicitly enabled, set `NEGEV_STAGING_HOST_PATH` to the staging directory as seen **inside Negev**, and `NEGEV_QBITTORRENT_STAGING_ROOT` to the matching directory as seen **inside qBittorrent**. Both must refer to the same shared storage. Negev's path check cannot discover another container's mount mapping; verify that mapping during installation before enabling downloads.
- The Negev container user must be able to open the staging directory, even though its mount stays read-only. If the host directory is group-restricted, grant the container only that group with Docker `group_add` (or an equivalent narrow ACL). Negev holds acquisition when it cannot open the directory; changing host media ownership or making it world-writable is unnecessary.
- A torrent descriptor cannot prove that its future video bytes are registered in AniDB. Negev may download a candidate that later fails the exact ED2K-and-size lookup; that candidate remains outside Shoko Import and needs review. Exact registration is an import gate, not a pre-download guarantee.
- An incomplete Negev-owned torrent is not retired by a timer. An operator can explicitly retire one stalled attempt with its exact ledger ID and hash using `node src/admin/retire-stalled.mjs <attempt-id> <torrent-hash> --delete-staged-files` inside the acquisition container. This deletes that torrent and its own incomplete staged files only after checking qBittorrent ownership and paths twice. Negev releases the episode claim only after qBittorrent reports the torrent absent and its own staging folder is absent or empty. A timeout leaves the delete outcome uncertain; repeat the command to **check absence**, never to send another delete. If the torrent remains, inspect it in qBittorrent and resolve that exact item manually before repeating the check. Back up the private ledger before using this action.
- Verified video bytes are prepared outside Shoko's watched Import folder and published only after exact AniDB file and episode checks.
- Acquisition uses a separate Shoko watched **Source** folder. Keep the existing manual Shoko Import folder mounted read-only in Negev and give Negev write access only to a dedicated handoff volume containing sibling holding and source directories. Configure `NEGEV_ACQUISITION_IMPORT_PARENT` as the source directory inside Negev, `NEGEV_ACQUISITION_IMPORT_FOLDER_ID` as that Shoko managed-folder ID, and `NEGEV_ACQUISITION_SHOKO_SOURCE_PATH` as its path inside Shoko. Shoko must report that exact folder as watched and Source before Negev can hand off files.
- The acquisition worker checks that its private holding and dedicated source roots resolve under one explicit, non-overlay container mount before copying or publishing. The actual shared bind source and atomic rename still need an installed check.
- If the dedicated empty `source/Negev` child disappears, Negev can recreate only that child after checking its existing parent and holding root. A missing or changed mount keeps acquisition held.
- The staging path must resolve to a read-only, non-overlay mount inside Negev and stay separate from its writable holding and Import paths. qBittorrent needs its own writable mapping to the same storage; Negev confirms the downloaded bytes at its own path before any Shoko handoff. A bad mapping holds the import and requires an installation correction.
- Shoko identifies imported files; a readable, matching Part in an allowed public Plex library proves playback availability. An incomplete observation remains Unknown.
- Direct Shoko imports can update availability without a Negev request. A blocked or unrecognized item must not stop unrelated work.
- Acquisition and broad observers are separate opt-ins, disabled by default. Their live settings require measured load, rollback, and genuine arrival checks before use.
- The file backfill defaults to one file per tick. `NEGEV_FILE_BACKFILL_FILES_PER_TICK` can opt into 1–10 serial files under one shared limit of ten fresh Plex card reads and 64 physical metadata probes per tick; measure load before raising it.
- A file-backfill service restart withdraws prior positive proofs, rechecks formerly proven files first within the same read limits, then scans the full Shoko inventory. Availability returns only after fresh exact Shoko/Plex checks; a large library can still take time to rebuild.
- The Plex index defaults to one page of at most five cards, plus at most one due retry card, every 60 seconds. `NEGEV_PLEX_INDEX_INTERVAL_MS` can set 15,000–300,000 ms only when the index is enabled; each tick remains single-flight and the interval begins after that tick finishes. Measure NAS load before shortening it.

The current source includes guarded components for these flows. The isolated request-to-public-Plex-availability chain has been exercised for two series episodes and one acquired film. The independent availability observer also verified these arrivals and a separate 13-episode manual import against public Plex. This is still short of a production cutover or a full-series/Airing continuation pass. See the source and tests for exact contracts. The planning files under `docs/superpowers/plans/` describe source work; they are not evidence of a deployed feature.

## Docker preview

[`compose.example.yaml`](compose.example.yaml) is a Linux host-network preview for catalogue search and requests. It binds Negev to `127.0.0.1:3000` and keeps acquisition off. Create a private host data directory **outside this checkout**, owned by UID 1000 with mode `0700`, and place a dedicated Shoko API key in `secrets/shoko.token` with mode `0600`. Set `NEGEV_HOST_DATA` and the locally reachable `NEGEV_SHOKO_URL` in your shell or a gitignored `.env` beside the Compose file. The `.env.example` values are placeholders, not credentials.

Before the first start, create the owner account with the same Compose configuration. On a Linux shell, enter a 12–128 byte password at the prompt:

```sh
read -rsp 'Negev owner password: ' negev_admin_password; printf '\n'
printf '%s\n' "$negev_admin_password" | docker compose -f compose.example.yaml run --rm -T \
  -e NEGEV_ADMIN_USERNAME=Owner --entrypoint node negev src/auth/init-admin.mjs
unset negev_admin_password
docker compose -f compose.example.yaml up -d
```

Keep the Shoko key and the data directory private. Do not paste the password or API key into Compose, `.env`, an issue, or a shell command argument.

Use a local browser or a separately configured HTTPS reverse proxy to reach the loopback listener. The preview does not expose a LAN port, mount `/var/run/docker.sock`, or start a download. Public Plex availability and acquisition require additional, explicitly configured mounts, providers and validation; this example does not claim a complete installation. Pin a versioned image and verify its rollback before enabling acquisition in an installed system.

## Development

Use Node.js 24 and pnpm 11:

```sh
pnpm install --frozen-lockfile
node --test
```

The Dockerfile builds a non-root image. Starting the account server requires explicit configuration and private secret files; there are no public example credentials or server-specific paths in this repository. Keep tokens, databases, media, logs, installed configuration, and operational evidence outside Git.

Negev is independent of TV Sonarr and Radarr. It must not remove or modify existing services as part of installation.
