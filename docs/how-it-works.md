# How Negev works

[Back to Negev](../README.md) · [Setup and configuration](setup.md)

## Design

- AniDB identifies anime installments and exact release files. A title match alone cannot authorize an import.
- The seasonal browse view reads AniMap's map into a bounded, compact in-memory index and confirms each displayed AniDB ID and adult flag against its AniDB detail record. The map currently expands to roughly 52 MB during refresh, so Negev streams individual entries instead of parsing one huge JSON object. Seasonal mapping is display-only and can omit ambiguous titles; normal AniDB title search remains available. The weekly schedule is a separate view. Adult/18+ titles are visible and requestable by default. Signed-in users can hide them using the top-right switch; the preference stays in that browser per account. Search results without an adult classification stay hidden while the switch is off until Negev confirms the AniDB detail flag. A failed classification leaves the result hidden. Admins can disable adult requests per account in User management, enforced at the request API. This personal browse switch is not a parental control; an unknown adult flag holds a request. [AniMap's data attribution](https://animap.id/) lists AniDB data under CC BY-NC-SA 4.0; the UI credits both sources.
- Airing series retain a watch for future episodes. If its owner is disabled, the watch stays paused; another member sees an administrator resolution instead of a healthy-monitoring message. Re-enable the existing owner to resume that one watch; ownership is not transferred. Completed titles are one-time acquisition requests. Films are requestable from the start.
- Request opens a season/film submenu with **Auto-Pick** and **Manual Pick**. Compact manual results show group, quality, size, seeds and advertised audio; Details expands exact file coverage and registration evidence before selection. The default quality filter is **Blu-ray or 1080p+**, including BD names without a stated resolution. Japanese + dual audio is the default manual audio filter, with separate Japanese-only, dual-audio and English-dub choices. Explicit manual language/UHD choices apply only to that saved release. A saved choice retains its torrent hash across restarts and cannot silently turn into another download. Resume unfinished selections from Requests. Members can select releases for their own requests; administrators can manage any request, subject to the account's adult-access setting.
- Registration evidence is separate from filename prediction. Advertised CRC32 plus size is labelled likely correspondence; only previously verified exact files are shown as confirmed. Unknown registration stays neutral and does not exclude an otherwise eligible release. Packs show evidence per video file.
- Auto search offers a materially better unconfirmed alternative only when an acceptable option has AniDB correspondence evidence. The alternative is labelled **Use likely match** for advertised CRC32 plus size, or **Use verified release** for previously verified exact files; **Grab better release** selects the stronger alternative with unknown correspondence. An unanswered offer defaults to the evidence-backed alternative after five minutes. Likely evidence is not proof that the torrent contains an AniDB-listed file. Unattended work prefers correspondence evidence within the required resolution and peer tier; registration never makes a suitable 1080p release lose to 720p or 480p. Older lower-resolution releases remain fallbacks when stronger options are unavailable. Failed or incomplete searches cannot justify an automatic quality downgrade.
- Confirmed Airing installments can save an editable preferred group. A new episode waits at most two hours from Negev's first observation of a suitable alternative; hourly RSS checks and an independently scheduled deadline survive restarts. Later alternatives do not reset the deadline. At expiry Negev searches again and uses the best eligible alternative, retaining exact observed fallback evidence for a provider outage. Historical catch-up and completed seasons do not wait. Group preference cannot override stronger quality/peer tiers or regrab an active or playable fallback. Requests display the group and deadline while waiting.
- Candidate releases are inspected before qBittorrent starts them. Unexpected executable or archive content is held.
- Negev needs two configured paths for acquisition: its own mounted staging directory and the corresponding qBittorrent save root. It checks qBittorrent's reported save path and selected files before starting a torrent. It does not require or mount the Docker control socket.
- When acquisition is explicitly enabled, set `NEGEV_STAGING_HOST_PATH` to the staging directory as seen **inside Negev**, and `NEGEV_QBITTORRENT_STAGING_ROOT` to the matching directory as seen **inside qBittorrent**. Both must refer to the same shared storage. Negev's path check cannot discover another container's mount mapping; verify that mapping during installation before enabling downloads.
- The Negev container user must be able to open staging. Legacy copy mode mounts staging read-only; pure-move mode needs a writable parent shared by staging, holding and Source. If the host directory is group-restricted, grant the container only that group with Docker `group_add` (or an equivalent narrow ACL). Negev holds acquisition when it cannot open the directory; changing host media ownership or making it world-writable is unnecessary.
- A torrent descriptor cannot prove the identity of its future video bytes. Negev may download a candidate that later fails its file and episode checks; that candidate remains outside Shoko Import. Shoko performs its own hashing and recognition after handoff. Exact AniDB registration is preferred, but Negev also accepts a release through its guarded Shoko-compatible fallback when exact registration is not yet available.
- An incomplete Negev-owned torrent is not retired by a timer. An operator can explicitly retire one stalled attempt with its exact ledger ID and hash using `node src/admin/retire-stalled.mjs <attempt-id> <torrent-hash> --delete-staged-files` inside the acquisition container. This deletes that torrent and its own incomplete staged files only after checking qBittorrent ownership and paths twice. Negev releases the episode claim only after qBittorrent reports the torrent absent and its own staging folder is absent or empty. A timeout leaves the delete outcome uncertain; repeat the command to **check absence**, never to send another delete. If the torrent remains, inspect it in qBittorrent and resolve that exact item manually before repeating the check. Back up the private ledger before using this action.
- In the current `NEGEV_PURE_MOVE=1` path, Negev prepares selected completed files in a private holding directory, then atomically moves the prepared directory into its `Negev` child of the configured watched Shoko Source. Staging, holding and Source must be distinct, non-overlapping paths under one writable parent mount, on the same filesystem. The verified move avoids a second full video copy; Shoko remains responsible for hashing and identifying imported files. A changed mount, file or identity holds that attempt without publishing it.
- Configure and verify the actual acquisition Source path and its Shoko managed-folder ID. The `holding` and `source` directories share a parent mount; the acquisition destination is `source/Negev`. Retain any separate manual Import source and its existing consumer behavior. Give Negev only the mount access required by the chosen mode, and verify container paths and filesystem before enabling acquisition.
- The staging path must resolve to a non-overlay mount inside Negev and stay separate from holding and Import. qBittorrent needs its own writable mapping to the same storage; Negev checks the reported save path and selected files before handoff. A bad mapping holds the attempt and requires an installation correction.
- Shoko identifies imported files; a readable, matching Part in an allowed public Plex library proves playback availability. An incomplete observation remains Unknown.
- Direct Shoko imports can update availability without a Negev request. A blocked or unrecognized item must not stop unrelated work.
- Acquisition and broad observers are separate opt-ins, disabled by default. Their live settings require measured load, rollback, and genuine arrival checks before use.
- The file backfill defaults to one file per tick. `NEGEV_FILE_BACKFILL_FILES_PER_TICK` can opt into 1–10 serial files under one shared limit of ten fresh Plex card reads and 64 physical metadata probes per tick; measure load before raising it.
- A file-backfill service restart retains recent positive proofs and resumes its saved sweep. Changes Negev observes while running withdraw the affected proofs. A Shoko or Plex change made while Negev is stopped may remain reported as **checked playable recently** until Negev reobserves it or the configured proof lifetime expires. That historical status is not a live playback check; use a fresh exact availability check when current presence matters. A large library can take time to revisit in full.
- The Plex index defaults to one page of at most five cards, plus at most one due retry card, every 60 seconds. `NEGEV_PLEX_INDEX_INTERVAL_MS` can set 15,000–300,000 ms only when the index is enabled; each tick remains single-flight and the interval begins after that tick finishes. Measure NAS load before shortening it.

The current source includes guarded components for these flows. Genuine installed arrivals have completed the request-to-download-to-Shoko-to-public-Plex path, including a later Airing episode. The independent availability observer has also checked a manual Shoko import without a Negev request. These results do not replace installation-specific mount, credential, load, and ownership checks.

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
