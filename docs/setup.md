# Setup and configuration

[Back to Negev](../README.md) · [Docker setup](#safe-docker-example) · [Settings](#settings)

## Quick start

This runs search and requests on one Linux host, with downloads off. Details are in [Safe Docker example](setup.md#safe-docker-example) and every option is in [Settings](setup.md#settings).

1. Make a private data folder outside this checkout, owned by UID 1000: `mkdir -m 700 /srv/negev /srv/negev/secrets`.
2. Save a dedicated Shoko API key as `/srv/negev/secrets/shoko.token` with mode `0600`.
3. Set `NEGEV_HOST_DATA=/srv/negev` and `NEGEV_SHOKO_URL=http://<shoko-host>:8111` in a `.env` file beside [`compose.example.yaml`](../compose.example.yaml).
4. Create the owner account (the command prompts for the password), then start Negev. Both commands are in [Safe Docker example](setup.md#safe-docker-example).
5. Open `http://localhost:3000` and sign in. Invite others from the account menu with **Create invite link**.

Public Plex availability, release search and downloads are separate opt-ins. Add them one at a time using [Settings](setup.md#settings), and check each against your own mounts and load.

## Safe Docker example

[`compose.example.yaml`](../compose.example.yaml) pins the versioned v0.0.336 image for a Linux host-network preview of catalogue search and requests. It binds Negev to `127.0.0.1:3000` and keeps acquisition off. Create a private host data directory **outside this checkout**, owned by UID 1000 with mode `0700`, and place a dedicated Shoko API key in `secrets/shoko.token` with mode `0600`. Set `NEGEV_HOST_DATA` and the locally reachable `NEGEV_SHOKO_URL` in your shell or a gitignored `.env` beside the Compose file. The `.env.example` values are placeholders, not credentials. Review the image tag and release notes before updating an installed service; this example never follows `latest` automatically.

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
- **Delete account** appears once an account is disabled. It permanently removes the account and requests with no dispatch, including unused reservations. A dispatched or stopped torrent without a start receipt must settle through the normal reconciliation/retirement path first; deletion waits rather than discarding uncertain work. Requests whose download started or may have started stay as closed history. They stop watching for new episodes. Used invitations remain listed without naming the deleted creator. Account and work IDs are never reassigned. Deletion cannot be undone.
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

**Admin commands** (`docker compose run … node <command>`): `src/auth/init-admin.mjs` creates the first owner from `NEGEV_ADMIN_USERNAME` and a password on stdin. `src/admin/worker-diagnostics.mjs` prints a read-only worker snapshot. `src/admin/retire-stalled.mjs` retires one stalled download; see [Design](how-it-works.md#design).

