# Negev

Negev is a self-hosted anime request and acquisition project for series and films. It aims to combine a searchable anime catalogue, user requests, airing episode monitoring, guarded torrent acquisition, Shoko import, and public Plex availability in one Docker-hosted service.

For this server, make new anime series and anime film requests in Negev. Seerr remains the request service for TV and regular movies and retains historical anime requests. Seerr does not forward new anime requests to Negev. A Negev title that cannot currently be requested must stay in Negev's retry path; sending it through Seerr would bypass the anime owner.

**Status:** Negev is the anime request and acquisition owner on the original server after a measured handover. New completed-series and film downloads have reached Shoko and public Plex; a later Airing episode and a manual Shoko import have also been observed. Anime Sonarr remains an unmonitored archive, while Seerr continues TV and regular movie requests. These results do not guarantee every release will match or import. The Docker example below is deliberately an acquisition-disabled starting point, not a complete installation.

## Quick start

This runs search and requests on one Linux host, with downloads off. Details are in [Safe Docker example](#safe-docker-example) and every option is in [Settings](#settings).

1. Make a private data folder outside this checkout, owned by UID 1000: `mkdir -m 700 /srv/negev /srv/negev/secrets`.
2. Save a dedicated Shoko API key as `/srv/negev/secrets/shoko.token` with mode `0600`.
3. Set `NEGEV_HOST_DATA=/srv/negev` and `NEGEV_SHOKO_URL=http://<shoko-host>:8111` in a `.env` file beside [`compose.example.yaml`](compose.example.yaml).
4. Create the owner account (the command prompts for the password), then start Negev. Both commands are in [Safe Docker example](#safe-docker-example).
5. Open `http://localhost:3000` and sign in. Invite others from the account menu with **Create invite link**.

Public Plex availability, release search and downloads are separate opt-ins. Add them one at a time using [Settings](#settings), and check each against your own mounts and load.

## Design

- AniDB identifies anime installments and exact release files. A title match alone cannot authorize an import.
- The seasonal browse view reads AniMap's map into a bounded, compact in-memory index and confirms each displayed AniDB ID and adult flag against its AniDB detail record. The map currently expands to roughly 52 MB during refresh, so Negev streams individual entries instead of parsing one huge JSON object. Seasonal mapping is display-only and can omit ambiguous titles; normal AniDB title search remains available. The weekly schedule is a separate view. Adult/18+ titles are visible and requestable by default. Signed-in users can hide them using the top-right switch; the preference stays in that browser per account. Search results without an adult classification stay hidden while the switch is off until Negev confirms the AniDB detail flag. A failed classification leaves the result hidden. Admins can disable adult requests per account in User management, enforced at the request API. This personal browse switch is not a parental control; an unknown adult flag holds a request. [AniMap's data attribution](https://animap.id/) lists AniDB data under CC BY-NC-SA 4.0; the UI credits both sources.
- Airing series retain a watch for future episodes. Completed titles are one-time acquisition requests. Films are requestable from the start.
- Request opens a season/film submenu with **Auto-Pick** and **Manual Pick**. Compact manual results show group, quality, size, seeds and advertised audio; Details expands exact file coverage and registration evidence before selection. The default quality filter is **Blu-ray or 1080p+**, including BD names without a stated resolution. Japanese + dual audio is the default manual audio filter, with separate Japanese-only, dual-audio and English-dub choices. Explicit manual language/UHD choices apply only to that saved release. A saved choice retains its torrent hash across restarts and cannot silently turn into another download. Resume unfinished selections from Requests. Members can select releases for their own requests; administrators can manage any request, subject to the account's adult-access setting.
- Registration evidence is separate from filename prediction. Advertised CRC32 plus size is labelled likely correspondence; only previously verified exact files are shown as confirmed. Unknown registration stays neutral and does not exclude an otherwise eligible release. Packs show evidence per video file.
- Auto search offers a materially better unconfirmed alternative only when an acceptable option has AniDB correspondence evidence. The alternative is labelled **Use likely match** for advertised CRC32 plus size, or **Use verified release** for previously verified exact files; **Grab better release** selects the stronger alternative with unknown correspondence. An unanswered offer defaults to the evidence-backed alternative after five minutes. Likely evidence is not proof that the torrent contains an AniDB-listed file. Unattended work prefers correspondence evidence within the required resolution and peer tier; registration never makes a suitable 1080p release lose to 720p or 480p. Older lower-resolution releases remain fallbacks when stronger options are unavailable. Failed or incomplete searches cannot justify an automatic quality downgrade.
- Confirmed Airing installments can save an editable preferred group. A new episode waits at most two hours from Negev's first observation of a suitable alternative; hourly RSS checks and an independently scheduled deadline survive restarts. Later alternatives do not reset the deadline. At expiry Negev searches again and uses the best eligible alternative, retaining exact observed fallback evidence for a provider outage. Historical catch-up and completed seasons do not wait. Group preference cannot override stronger quality/peer tiers or regrab an active or playable fallback. Requests display the group and deadline while waiting.
- Candidate releases are inspected before qBittorrent starts them. Unexpected executable or archive content is held.
- Negev needs two configured paths for acquisition: its own mounted staging directory and the corresponding qBittorrent save root. It checks qBittorrent's reported save path and selected files before starting a torrent. It does not require or mount the Docker control socket.
- When acquisition is explicitly enabled, set `NEGEV_STAGING_HOST_PATH` to the staging directory as seen **inside Negev**, and `NEGEV_QBITTORRENT_STAGING_ROOT` to the matching directory as seen **inside qBittorrent**. Both must refer to the same shared storage. Negev's path check cannot discover another container's mount mapping; verify that mapping during installation before enabling downloads.
- The Negev container user must be able to open the staging directory, even though its mount stays read-only. If the host directory is group-restricted, grant the container only that group with Docker `group_add` (or an equivalent narrow ACL). Negev holds acquisition when it cannot open the directory; changing host media ownership or making it world-writable is unnecessary.
- A torrent descriptor cannot prove the identity of its future video bytes. Negev may download a candidate that later fails its file and episode checks; that candidate remains outside Shoko Import. Shoko performs its own hashing and recognition after handoff. Exact AniDB registration is preferred, but Negev also accepts a release through its guarded Shoko-compatible fallback when exact registration is not yet available.
- An incomplete Negev-owned torrent is not retired by a timer. An operator can explicitly retire one stalled attempt with its exact ledger ID and hash using `node src/admin/retire-stalled.mjs <attempt-id> <torrent-hash> --delete-staged-files` inside the acquisition container. This deletes that torrent and its own incomplete staged files only after checking qBittorrent ownership and paths twice. Negev releases the episode claim only after qBittorrent reports the torrent absent and its own staging folder is absent or empty. A timeout leaves the delete outcome uncertain; repeat the command to **check absence**, never to send another delete. If the torrent remains, inspect it in qBittorrent and resolve that exact item manually before repeating the check. Back up the private ledger before using this action.
- In the current `NEGEV_PURE_MOVE=1` path, Negev prepares selected completed files in a private holding directory, then atomically moves the prepared directory into its `Negev` child of the configured watched Shoko Source. Staging, holding and Source must be distinct paths on the same filesystem. The verified move avoids a second full video copy; Shoko remains responsible for hashing and identifying imported files. A changed mount, file or identity holds that attempt without publishing it.
- Configure and verify the actual acquisition Source path and its Shoko managed-folder ID. The `holding` and `source` directories share a parent mount; the acquisition destination is `source/Negev`. Retain any separate manual Import source and its existing consumer behavior. Give Negev only the mount access required by the chosen mode, and verify container paths and filesystem before enabling acquisition.
- The staging path must resolve to a non-overlay mount inside Negev and stay separate from holding and Import. qBittorrent needs its own writable mapping to the same storage; Negev checks the reported save path and selected files before handoff. A bad mapping holds the attempt and requires an installation correction.
- Shoko identifies imported files; a readable, matching Part in an allowed public Plex library proves playback availability. An incomplete observation remains Unknown.
- Direct Shoko imports can update availability without a Negev request. A blocked or unrecognized item must not stop unrelated work.
- Acquisition and broad observers are separate opt-ins, disabled by default. Their live settings require measured load, rollback, and genuine arrival checks before use.
- The file backfill defaults to one file per tick. `NEGEV_FILE_BACKFILL_FILES_PER_TICK` can opt into 1–10 serial files under one shared limit of ten fresh Plex card reads and 64 physical metadata probes per tick; measure load before raising it.
- A file-backfill service restart retains recent positive proofs and resumes its saved sweep. Changes Negev observes while running withdraw the affected proofs. A Shoko or Plex change made while Negev is stopped may remain reported as **checked playable recently** until Negev reobserves it or the configured proof lifetime expires. That historical status is not a live playback check; use a fresh exact availability check when current presence matters. A large library can take time to revisit in full.
- The Plex index defaults to one page of at most five cards, plus at most one due retry card, every 60 seconds. `NEGEV_PLEX_INDEX_INTERVAL_MS` can set 15,000–300,000 ms only when the index is enabled; each tick remains single-flight and the interval begins after that tick finishes. Measure NAS load before shortening it.

The current source includes guarded components for these flows. Genuine installed arrivals have completed the request-to-download-to-Shoko-to-public-Plex path, including a later Airing episode. The independent availability observer has also checked a manual Shoko import without a Negev request. These results do not replace installation-specific mount, credential, load, and ownership checks.
## Safe Docker example

[`compose.example.yaml`](compose.example.yaml) pins the versioned v0.0.330 image for a Linux host-network preview of catalogue search and requests. It binds Negev to `127.0.0.1:3000` and keeps acquisition off. Create a private host data directory **outside this checkout**, owned by UID 1000 with mode `0700`, and place a dedicated Shoko API key in `secrets/shoko.token` with mode `0600`. Set `NEGEV_HOST_DATA` and the locally reachable `NEGEV_SHOKO_URL` in your shell or a gitignored `.env` beside the Compose file. The `.env.example` values are placeholders, not credentials. Review the image tag and release notes before updating an installed service; this example never follows `latest` automatically.

Before the first start, create the owner account with the same Compose configuration. On a Linux shell, enter a 12–128 byte password at the prompt:

```sh
read -rsp 'Negev owner password: ' negev_admin_password; printf '\n'
printf '%s\n' "$negev_admin_password" | docker compose -f compose.example.yaml run --rm -T \
  -e NEGEV_ADMIN_USERNAME=Owner --entrypoint node negev src/auth/init-admin.mjs
unset negev_admin_password
docker compose -f compose.example.yaml up -d
```

Keep the Shoko key and the data directory private. Create the `secrets/` subdirectory with mode `0700`, owned by the same service UID, before writing `shoko.token` with mode `0600`; the loader checks both directories and the file. Do not paste the password or API key into Compose, `.env`, an issue, or a shell command argument.

First-time initialization publishes a fully written session key without replacing an existing key. For an older setup interrupted before its first successful start, stop Negev and take a private consistent database backup plus the existing `session.key`. Check that the key is invalid (it must contain exactly 32 bytes); preserve that invalid file privately under another name, then rerun the offline initialization command to create the missing key. Never remove or replace a valid installed key during a routine retry: doing so invalidates existing sessions. An invalid key is rejected rather than silently repaired.

For a redacted read-only worker snapshot, run `node src/admin/worker-diagnostics.mjs` as the existing service user with its configured `NEGEV_DATA_DIR`. The command reports persisted claims, due retries and cursors without starting workers or calling providers. Compare snapshots over normal worker turns; a single snapshot and HTTP liveness do not establish readiness. Uninitialized queues and unknown hold reasons are explicit, and queues without enqueue timestamps cannot supply pending age. For acquisition, `dueRetries` follows persisted request eligibility, excluding cancelled, suspended and settled completed work. `recordedDueRetries` retains raw timestamp-due history, while `retainedDueRetries` counts records excluded from that eligible set; a new choice or target scope can be eligible before its saved timestamp. Missing historical eligibility fields produce unknown (`null`) actionable counts. Runtime title cohorts and provider/ownership gates are not evaluated, so these counts still do not establish readiness.

Use a local browser with the exact configured `http://localhost:3000` origin for this loopback preview. It rejects a different host or HTTPS origin. For a public HTTPS tunnel that reaches Negev in the same network namespace, keep `NEGEV_LISTEN_HOST=127.0.0.1`, set `NEGEV_EXPOSE_USERS=1`, and set `NEGEV_PUBLIC_ORIGIN` to the exact HTTPS browser origin. Negev then uses Secure cookies while retaining its loopback-only listener. A separate HTTPS reverse proxy can instead use `NEGEV_LISTEN_HOST=0.0.0.0` with the same exposure flag and exact origin; that configuration opens a LAN listener. To sign in through both the HTTPS hostname and the direct private LAN address on that listener, also set `NEGEV_LOCAL_ORIGIN` to its exact HTTP URL, including the listener port. The LAN cookie is separate from the Secure HTTPS cookie; the LAN URL must use a private IPv4 address and cannot be enabled for a public HTTP hostname. Verify TLS, origin, and proxy routing before inviting users. The preview does not expose a LAN port, mount `/var/run/docker.sock`, or start a download. Public Plex availability and acquisition require additional, explicitly configured mounts, providers and validation; this example does not claim a complete installation. Pin a versioned image and verify its rollback before enabling acquisition in an installed system.

### Logs and sign-in sessions

- If Negev cannot start, stderr names the setting at fault, for example `Acquisition runtime is unavailable: NEGEV_SHOKO_EVENTS=1 is required`. Loaded secrets and token-like URL parameters are redacted. Set `NEGEV_DEBUG_STARTUP=1` to also print the stack trace.
- `NEGEV_LOG_LEVEL` (`silent`, `error`, `warn`, `info` or `debug`; default `warn`) controls the JSON request log on stdout. Every 5xx response is logged with its route and, when one was caught, the underlying error. Cookies, CSRF tokens and authorization headers are never logged.
- A signed-in browser stays signed in while it is used at least once every 7 days, for at most 30 days after sign-in. **Sign out** ends that browser's session only. **Sign out of all devices** in the account menu ends every session for the account.
- When a new version is deployed, an open page reloads by itself only if nothing is in progress. Otherwise it shows a **Reload now** banner.

### Admin tools

- **Create invite link** (account menu or Administration) gives a link with a **Copy link** button. The link works once, expires after 7 days, and fills in the registration form. The **Invitations** list on the Administration page shows each link's status (active, used, expired or revoked) and who used it; **Revoke** stops an unused link working. Links are shown only once, because Negev stores only a digest of each code.
- **Reset password** next to an account gives a one-time link that expires after 24 hours. Opening it lets that person choose a new password, which also signs the account out everywhere. Creating a new link cancels any earlier unused one. Negev never shows or stores the password itself.
- **Disable account** in the admin account list signs that person out on every device and blocks sign-in until you enable the account again. Their requests are kept but pause: nothing new is searched or started for them until the account is enabled. A download that had already started finishes normally. You cannot disable your own account.
- **Delete account** appears once an account is disabled. It permanently removes the account and every request of theirs that never started a download. Requests that already started a download stay as history, because they describe files in Plex or still downloading, and stop watching for new episodes. It cannot be undone.
- With `NEGEV_TITLE_CHECK=1`, a title's page shows **Check whole title in Plex**. Use it for titles imported outside Negev, for example manually through Shoko; it checks every episode and reports how many are playable.
- Two admin-only diagnostic endpoints have no UI and never start a download: `POST /api/admin/import-activity` (`{}`) reports whether Shoko is importing, and `POST /api/requests/:id/presence-probe` (`{"episodeIds":[…]}`) re-checks up to 10 of a request's episodes in Plex. Both need a signed-in admin session with its CSRF header.
- Search hides titles known to be 18+ from accounts without 18+ access. A title counts as known once its details have been opened in the last day; opening a restricted title is always blocked for those accounts.

## Settings

All settings are environment variables. On/off settings take `1` or `0`, and unset means off. Negev refuses to start on an invalid or inconsistent setting, and names it in the error. Key files always live in `<data>/secrets/` with mode `0600`. Their `*_FILE` setting is optional, and if set it must point at that exact file. Secrets are never accepted as plain environment variables.

**Required**

| Setting | Value |
|---|---|
| `NEGEV_USER_SERVER` | `1` |
| `NEGEV_DATA_DIR` | Absolute path of the private data folder (database, `session.key`, `secrets/`) |
| `NEGEV_SHOKO_URL` | Shoko base URL, for example `http://shoko:8111` (no path) |
| `NEGEV_PUBLIC_ORIGIN` | The exact URL people open, for example `http://localhost:3000` or `https://anime.example.com` |
| `secrets/shoko.token` | Shoko API key (`NEGEV_SHOKO_API_KEY_FILE` optional) |

**Network, sign-in and logs**

| Setting | Default | Meaning |
|---|---|---|
| `NEGEV_PORT` | `3000` | Listening port |
| `NEGEV_LISTEN_HOST` | `127.0.0.1` | `0.0.0.0` opens a LAN listener and needs `NEGEV_EXPOSE_USERS=1` |
| `NEGEV_EXPOSE_USERS` | off | Serve users over HTTPS. `NEGEV_PUBLIC_ORIGIN` must then be `https://` |
| `NEGEV_LOCAL_ORIGIN` | unset | Also allow sign-in from this private-LAN `http://` URL, including the port |
| `NEGEV_LOG_LEVEL` | `warn` | `silent`, `error`, `warn`, `info` or `debug` |
| `NEGEV_DEBUG_STARTUP` | off | Print the stack trace when startup fails |
| `NEGEV_IMPORT_FENCE_TRACE` | off | Log each Shoko Import fence observation to stdout |

**Catalogue and airing**

| Setting | Default | Meaning |
|---|---|---|
| `NEGEV_ANIDB_TITLE_DUMP` | off | Search the AniDB title list, cached in the data folder, instead of only Shoko's cache |
| `NEGEV_SHOKO_HYDRATION` | off | Let Negev ask Shoko to load details for titles it has not cached |
| `NEGEV_AIRING_WATCH` | off | Check saved airing requests for new episodes. Needs `NEGEV_TIME_ZONE` |
| `NEGEV_PARENT_WATCH` | off | Follow a show's later seasons and installments. Needs `NEGEV_AIRING_WATCH` |
| `NEGEV_TIME_ZONE` | `UTC` | IANA time zone used for air dates, for example `Australia/Sydney` |

**Shoko and Plex availability**

| Setting | Default | Meaning |
|---|---|---|
| `NEGEV_SHOKO_EVENTS` | off | Follow Shoko's live event feed |
| `NEGEV_SHOKO_RECENT` | off | Scan Shoko's recently added files |
| `NEGEV_SHOKO_INVENTORY` | off | Slow full reconciliation of Shoko's files |
| `NEGEV_SHOKO_INVENTORY_HINTS` | off | Use path hints from the inventory. Needs `NEGEV_SHOKO_INVENTORY` |
| `NEGEV_SHOKO_IMPORT_ROOT`, `NEGEV_SHOKO_IMPORT_FOLDER_ID` | unset | The Shoko Import folder Negev watches: path and managed-folder ID |
| `NEGEV_PLEX_OBSERVER` | off | Check public Plex for playable files. Needs the next five settings |
| `NEGEV_PLEX_URL` | | Plex base URL |
| `secrets/plex.token` | | Plex token (`NEGEV_PLEX_TOKEN_FILE` optional) |
| `NEGEV_PLEX_SECTIONS` | | JSON library IDs, for example `{"episode":[102],"movie":[103]}` |
| `NEGEV_SHOKO_MEDIA_MOUNT` | | JSON `{"appRoot":"/shoko/path","localRoot":"/path/in/negev"}` |
| `NEGEV_PLEX_MEDIA_MOUNTS` | | JSON list of `{"appRoot","localRoot"}` for Plex's paths |
| `NEGEV_PLEX_SOURCE_POLICY` | unset | JSON per library: `libraryId`, `type`, `agent`, `scanner`, `roots` |
| `NEGEV_PLEX_GUID_PROBE` | off | Match Plex items by AniDB GUID (at most 4 libraries) |
| `NEGEV_PLEX_INDEX` | off | Index public Plex cards in the background |
| `NEGEV_PLEX_INDEX_INTERVAL_MS` | `60000` | 15,000–300,000. Needs `NEGEV_PLEX_INDEX` |
| `NEGEV_FILE_BACKFILL` | off | Prove older files playable, one at a time. Needs inventory hints, Plex index and observer |
| `NEGEV_FILE_BACKFILL_INTERVAL_MS` | | 10,000–300,000. Required with backfill |
| `NEGEV_FILE_BACKFILL_FILES_PER_TICK` | `1` | 1–10 |
| `NEGEV_FILE_PROOF_LIFETIME_MS` | | 30 minutes to 7 days. Required with backfill or proof reading |
| `NEGEV_FILE_PROOF_READ` | off | Use saved file proofs without running the backfill |
| `NEGEV_DIRECT_AVAILABILITY` | off | Check requested episodes directly. Needs a Shoko observer and the Plex index or GUID probe |
| `NEGEV_DIRECT_ACTIVE_DELAY_MS` | `60000` | 10,000–300,000 between busy direct checks |
| `NEGEV_TITLE_CHECK` | off | Show **Check whole title in Plex** on title pages |

**Release search and downloads**

| Setting | Default | Meaning |
|---|---|---|
| `NEGEV_PROWLARR_DISCOVERY` | off | Search releases through Prowlarr |
| `NEGEV_PROWLARR_URL`, `secrets/prowlarr.token` | | Prowlarr base URL and API key |
| `NEGEV_PROWLARR_INDEXERS` | | JSON list of indexer IDs, for example `[5,7]` |
| `NEGEV_PROWLARR_TRUSTED_INDEXERS` | `[]` | Subset of the indexers treated as trusted |
| `NEGEV_QBITTORRENT_SIDECAR_READ` | off | Read qBittorrent state. Needs the Shoko Import folder settings |
| `NEGEV_QBITTORRENT_URL`, `NEGEV_QBITTORRENT_USERNAME`, `secrets/qbittorrent.password` | | qBittorrent connection |
| `NEGEV_QBITTORRENT_IMPORT_SAVE_PATH` | | The Import folder as qBittorrent sees it |
| `NEGEV_ACQUISITION_RUNTIME` | off | Start downloads. Needs Prowlarr, the Plex observer with source policy and GUID probe, qBittorrent, Shoko events, recent scan and direct availability, plus the settings below. The startup error names whichever is missing |
| `NEGEV_STAGING_HOST_PATH` | | Download staging folder inside Negev |
| `NEGEV_QBITTORRENT_STAGING_ROOT` | | The same staging folder as qBittorrent sees it |
| `NEGEV_HOLDING_ROOT` | | Private holding folder, ending in `holding` |
| `NEGEV_ACQUISITION_IMPORT_PARENT` | | Shoko Source parent, ending in `source`, beside `holding` |
| `NEGEV_ACQUISITION_IMPORT_FOLDER_ID` | | Shoko managed-folder ID of that Source (not the Import folder) |
| `NEGEV_ACQUISITION_SHOKO_SOURCE_PATH` | | That Source as Shoko sees it |
| `NEGEV_SHOKO_RELEASE_PROVIDER_ID` | | Shoko release-provider UUID |
| `NEGEV_PURE_MOVE` | off | Move prepared files into the Source instead of copying them |
| Ownership guard | | One of: `NEGEV_ACQUISITION_ALLOWED_ANIDB_IDS` (comma list), `NEGEV_SONARR_OWNERSHIP_URL` with `secrets/sonarr.token`, or `NEGEV_ANIME_SOLE_OWNER=1` |

**Admin commands** (`docker compose run … node <command>`): `src/auth/init-admin.mjs` creates the first owner from `NEGEV_ADMIN_USERNAME` and a password on stdin. `src/admin/worker-diagnostics.mjs` prints a read-only worker snapshot. `src/admin/retire-stalled.mjs` retires one stalled download; see [Design](#design).

## Development

Use Node.js 24 and pnpm 11:

```sh
pnpm install --frozen-lockfile
pnpm test          # everything, browser files one at a time (as CI runs it)
pnpm test:unit     # everything except the browser fixtures
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

### Qualified availability cache upgrades

Stop Negev and retain a private SQLite/WAL-consistent backup before using
`node src/availability/migrate-qualified-cache.mjs --manifest /private/data/qualified.json --stopped-service-confirmed`
with the installation's normal private configuration. The manifest must be a
canonical private file inside the configured data directory. It binds exact
source/card generations, public server identity, libraries and mounts; the
command rechecks physical witnesses before atomic cache publication. Accounts,
requests, choices, acquisition journals and source inventory are preserved.
Imported proof timestamps remain the original qualification times.

The frozen v0.0.300 availability schema is supported directly for the specific
additive `components_json` proof migration. Other schema differences fail
closed rather than rebuilding unknown tables. Keep the matched backup until
request scope, Library and installed workers have been checked. If publication
fails, its transaction rolls back; if a later fresh request check fails after
publication, inspect privately and restore the matched backup if needed.

The requested-target warmer processes at most 1,000 targets and 15 minutes per
invocation. A private durable cursor advances across both available and unknown
targets, survives restarts and resets when the public scope changes. When the
returned `requested.state` is `partial`, repeat the command with
`--warm-requests-only` to continue without republishing the qualified cache.
A complete cycle resets the cursor, allowing unknown targets to be checked
again in a later cycle. Fresh successful checks receive their own current
proof time; they never refresh an imported receipt merely by copying it.

Public evidence reads require a configured, currently authenticated Plex
observer. Disabling that observer stops old direct/title receipts from trimming
new requests. Availability-consuming API reads and actions renew the bounded server identity
lease even when all periodic availability workers are off. Renewal failure
keeps saved evidence untrusted until identity can be verified again.

### Arrival availability retries

A newly linked file can reach Shoko before Plex has indexed it. An inconclusive
first public observation now leaves durable, due-time retry work. Fresh priority
work, due arrival retries and the historical file sweep share bounded turns;
the existing per-tick provider and physical-check budgets remain unchanged.
Retries use one-minute spacing initially and at most five-minute spacing after
15 minutes. They survive restart and do not expire with the old recent-event
marker. Duplicate events do not reset age or bypass backoff. A newer source
generation cannot be retired by an older in-flight result.

An arrival is complete only when all its linked targets have current guarded
proofs. Unknown results do not mark a file Available or start another download.
Direct availability also alternates newer pending arrivals with oldest due work,
so the historical queue and ordinary reconciliation continue progressing.
Existing in-flight priority work is migrated without rebasing known observation
or proof timestamps. No media, request or provider configuration is changed.
