# Negev

Negev is a self-hosted anime request and acquisition project for series and films. It aims to combine a searchable anime catalogue, user requests, airing episode monitoring, guarded torrent acquisition, Shoko import, and public Plex availability in one Docker-hosted service.

For this server, make new anime series and anime film requests in Negev. Seerr remains the request service for TV and regular movies and retains historical anime requests. Seerr does not forward new anime requests to Negev. A Negev title that cannot currently be requested must stay in Negev's retry path; sending it through Seerr would bypass the anime owner.

**Status:** Negev is the anime request and acquisition owner on the original server after a measured handover. New completed-series and film downloads have reached Shoko and public Plex; a later Airing episode and a manual Shoko import have also been observed. Anime Sonarr remains an unmonitored archive, while Seerr continues TV and regular movie requests. These results do not guarantee every release will match or import. The Docker example below is deliberately an acquisition-disabled starting point, not a complete installation.

## Design

- AniDB identifies anime installments and exact release files. A title match alone cannot authorize an import.
- The seasonal browse view reads AniMap's map into a bounded, compact in-memory index and confirms each displayed AniDB ID and adult flag against its AniDB detail record. The map currently expands to roughly 52 MB during refresh, so Negev streams individual entries instead of parsing one huge JSON object. Seasonal mapping is display-only and can omit ambiguous titles; normal AniDB title search remains available. The weekly schedule is a separate view. Adult/18+ titles are visible and requestable by default. Signed-in users can hide them using the top-right switch; the preference stays in that browser per account. Search results without an adult classification stay hidden while the switch is off until Negev confirms the AniDB detail flag. A failed classification leaves the result hidden. Admins can disable adult requests per account in User management, enforced at the request API. This personal browse switch is not a parental control; an unknown adult flag holds a request. [AniMap's data attribution](https://animap.id/) lists AniDB data under CC BY-NC-SA 4.0; the UI credits both sources.
- Airing series retain a watch for future episodes. Completed titles are one-time acquisition requests. Films are requestable from the start.
- Candidate releases are inspected before qBittorrent starts them. Unexpected executable or archive content is held.
- Negev needs two configured paths for acquisition: its own mounted staging directory and the corresponding qBittorrent save root. It checks qBittorrent's reported save path and selected files before starting a torrent. It does not require or mount the Docker control socket.
- When acquisition is explicitly enabled, set `NEGEV_STAGING_HOST_PATH` to the staging directory as seen **inside Negev**, and `NEGEV_QBITTORRENT_STAGING_ROOT` to the matching directory as seen **inside qBittorrent**. Both must refer to the same shared storage. Negev's path check cannot discover another container's mount mapping; verify that mapping during installation before enabling downloads.
- The Negev container user must be able to open the staging directory, even though its mount stays read-only. If the host directory is group-restricted, grant the container only that group with Docker `group_add` (or an equivalent narrow ACL). Negev holds acquisition when it cannot open the directory; changing host media ownership or making it world-writable is unnecessary.
- A torrent descriptor cannot prove the identity of its future video bytes. Negev may download a candidate that later fails its file and episode checks; that candidate remains outside Shoko Import. Shoko performs its own hashing and recognition after handoff. Exact AniDB registration is preferred, but Negev also accepts a release through its guarded Shoko-compatible fallback when exact registration is not yet available.
- An incomplete Negev-owned torrent is not retired by a timer. An operator can explicitly retire one stalled attempt with its exact ledger ID and hash using `node src/admin/retire-stalled.mjs <attempt-id> <torrent-hash> --delete-staged-files` inside the acquisition container. This deletes that torrent and its own incomplete staged files only after checking qBittorrent ownership and paths twice. Negev releases the episode claim only after qBittorrent reports the torrent absent and its own staging folder is absent or empty. A timeout leaves the delete outcome uncertain; repeat the command to **check absence**, never to send another delete. If the torrent remains, inspect it in qBittorrent and resolve that exact item manually before repeating the check. Back up the private ledger before using this action.
- In the current `NEGEV_PURE_MOVE=1` path, Negev prepares selected completed files in a private holding directory, then atomically moves the prepared directory into Shoko's existing watched Import folder. Staging, holding and Import must be distinct paths on the same filesystem. The verified move avoids a second full video copy; Shoko remains responsible for hashing and identifying imported files. A changed mount, file or identity holds that attempt without publishing it.
- The current configuration still validates the legacy `source` path and its Shoko folder ID, but pure-move publication uses the existing Import root instead. Do not create a second watched Shoko Source folder solely for this mode. Give Negev only the mount access required by the chosen mode, and verify the actual container paths and filesystem before enabling acquisition.
- The staging path must resolve to a non-overlay mount inside Negev and stay separate from holding and Import. qBittorrent needs its own writable mapping to the same storage; Negev checks the reported save path and selected files before handoff. A bad mapping holds the attempt and requires an installation correction.
- Shoko identifies imported files; a readable, matching Part in an allowed public Plex library proves playback availability. An incomplete observation remains Unknown.
- Direct Shoko imports can update availability without a Negev request. A blocked or unrecognized item must not stop unrelated work.
- Acquisition and broad observers are separate opt-ins, disabled by default. Their live settings require measured load, rollback, and genuine arrival checks before use.
- The file backfill defaults to one file per tick. `NEGEV_FILE_BACKFILL_FILES_PER_TICK` can opt into 1–10 serial files under one shared limit of ten fresh Plex card reads and 64 physical metadata probes per tick; measure load before raising it.
- A file-backfill service restart retains recent positive proofs and resumes its saved sweep. Changes Negev observes while running withdraw the affected proofs. A Shoko or Plex change made while Negev is stopped may remain reported as **checked playable recently** until Negev reobserves it or the configured proof lifetime expires. That historical status is not a live playback check; use a fresh exact availability check when current presence matters. A large library can take time to revisit in full.
- The Plex index defaults to one page of at most five cards, plus at most one due retry card, every 60 seconds. `NEGEV_PLEX_INDEX_INTERVAL_MS` can set 15,000–300,000 ms only when the index is enabled; each tick remains single-flight and the interval begins after that tick finishes. Measure NAS load before shortening it.

The current source includes guarded components for these flows. Genuine installed arrivals have completed the request-to-download-to-Shoko-to-public-Plex path, including a later Airing episode. The independent availability observer has also checked a manual Shoko import without a Negev request. These results do not replace installation-specific mount, credential, load, and ownership checks. The planning files under `docs/superpowers/plans/` describe source work; they are not evidence of a deployed feature.

## Safe Docker example

[`compose.example.yaml`](compose.example.yaml) pins the versioned v0.0.195 image for a Linux host-network preview of catalogue search and requests. It binds Negev to `127.0.0.1:3000` and keeps acquisition off. Create a private host data directory **outside this checkout**, owned by UID 1000 with mode `0700`, and place a dedicated Shoko API key in `secrets/shoko.token` with mode `0600`. Set `NEGEV_HOST_DATA` and the locally reachable `NEGEV_SHOKO_URL` in your shell or a gitignored `.env` beside the Compose file. The `.env.example` values are placeholders, not credentials. Review the image tag and release notes before updating an installed service; this example never follows `latest` automatically.

Before the first start, create the owner account with the same Compose configuration. On a Linux shell, enter a 12–128 byte password at the prompt:

```sh
read -rsp 'Negev owner password: ' negev_admin_password; printf '\n'
printf '%s\n' "$negev_admin_password" | docker compose -f compose.example.yaml run --rm -T \
  -e NEGEV_ADMIN_USERNAME=Owner --entrypoint node negev src/auth/init-admin.mjs
unset negev_admin_password
docker compose -f compose.example.yaml up -d
```

Keep the Shoko key and the data directory private. Do not paste the password or API key into Compose, `.env`, an issue, or a shell command argument.

Use a local browser with the exact configured `http://localhost:3000` origin for this loopback preview. It rejects a different host or HTTPS origin. For a public HTTPS tunnel that reaches Negev in the same network namespace, keep `NEGEV_LISTEN_HOST=127.0.0.1`, set `NEGEV_EXPOSE_USERS=1`, and set `NEGEV_PUBLIC_ORIGIN` to the exact HTTPS browser origin. Negev then uses Secure cookies while retaining its loopback-only listener. A separate HTTPS reverse proxy can instead use `NEGEV_LISTEN_HOST=0.0.0.0` with the same exposure flag and exact origin; that configuration opens a LAN listener. To sign in through both the HTTPS hostname and the direct private LAN address on that listener, also set `NEGEV_LOCAL_ORIGIN` to its exact HTTP URL, including the listener port. The LAN cookie is separate from the Secure HTTPS cookie; the LAN URL must use a private IPv4 address and cannot be enabled for a public HTTP hostname. Verify TLS, origin, and proxy routing before inviting users. The preview does not expose a LAN port, mount `/var/run/docker.sock`, or start a download. Public Plex availability and acquisition require additional, explicitly configured mounts, providers and validation; this example does not claim a complete installation. Pin a versioned image and verify its rollback before enabling acquisition in an installed system.

## Development

Use Node.js 24 and pnpm 11:

```sh
pnpm install --frozen-lockfile
node --test
```

The Dockerfile builds a non-root image. Starting the account server requires explicit configuration and private secret files; there are no public example credentials or server-specific paths in this repository. Keep tokens, databases, media, logs, installed configuration, and operational evidence outside Git.

Negev is independent of TV Sonarr and Radarr. It must not remove or modify existing services as part of installation.

During a measured handover from another anime acquisition owner, an enabled
Negev worker can be restricted to exact AniDB titles with
`NEGEV_ACQUISITION_ALLOWED_ANIDB_IDS=42,19847`. The list is optional, but when
set it must contain 1–100 distinct positive AniDB IDs with no spaces. Only
those titles enter the acquisition request queue. New requests outside the
list are rejected with a clear cutover message; previously saved requests
outside it remain saved and are not downloaded by Negev. Changing the list requires a
restart. Confirm that any previously started attempts outside the list have
finished or are held before enabling this mode, since downstream attempt
workers continue their durable journals. Remove the restriction only after
the former owner's corresponding watches and request route have been retired.
