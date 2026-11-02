# Isolated mount-witness pilot

Negev needs a fresh mount snapshot before a qBittorrent add or start. The account-facing container must never receive `/var/run/docker.sock`. Its only mount-inspection interface is the fixed `GET /v1/mounts` Unix socket from `run-docker-mount-witness.mjs`.

## Before starting

1. Keep acquisition disabled and preserve the current Negev container, its private SQLite backup, and its inspect record. Confirm the current qBittorrent, Shoko, and Plex container names and IDs.
2. Verify the account container's actual UID/GID. Create a dedicated socket directory owned by root and that client GID with mode `0750`. Mount that exact directory into the account container at its configured `dataDir/mount-witness` path and into the witness container at the corresponding socket path. Do not expose this directory through HTTP or a media share.
3. Run the pinned Negev image as a **separate root witness container** with no network, a read-only root filesystem, dropped capabilities, no new privileges, bounded memory/CPU/PIDs, and only two mounts: the dedicated socket directory writable and the Docker Unix socket. A read-only Docker-socket bind does **not** make Docker API access read-only; the isolated witness process can still reach a root-equivalent API. Keep this container separate from Negev's account process and do not give it credentials or media mounts.
4. Set the three fixed container-name variables, `NEGEV_MOUNT_WITNESS_SOCKET`, and `NEGEV_MOUNT_CLIENT_GID`. Override the image's inherited HTTP healthcheck with one that checks this witness socket, because this process does not run Negev's web server. Use no restart policy during the pilot.

## Acceptance checks before any torrent write

- The witness socket is owned by root and the selected client GID, with mode `0660`; its parent remains root-owned, canonical and mode `0750`.
- A single client `GET /v1/mounts` returns only qBittorrent, Shoko, and Plex container IDs plus filtered `Type`, `Source`, `Destination`, and `RW` mount fields. No environment, labels, HostConfig, credentials, or arbitrary Docker endpoint is exposed. An unrelated method or path fails.
- A fresh snapshot passes Negev's staging-isolation check for the exact configured host path. Stop the witness and confirm the direct client reports `mount_witness_unavailable` and the add/start gate holds with `mount_evidence_unavailable` before any write. Restart only after checking for a stale socket using the source's same-inode refusal rule.
- Inspect the account container and confirm it has neither `/var/run/docker.sock` nor a broad host mount added for this pilot. Check witness and account health, restart count, resource use and recent errors.

Only after these checks pass should a separate stopped-add test be considered. A successful witness response does not authorize a download, establish AniDB file registration, or prove Shoko import. If any check fails, leave acquisition disabled and remove only the pilot witness container and its owned socket after verifying their identity; preserve the Negev database and existing services.
