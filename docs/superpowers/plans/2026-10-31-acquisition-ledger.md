# Durable acquisition attempt boundary

The request ledger owns user history and exact AniDB episode targets. A separate SQLite acquisition ledger reserves one candidate for an existing held request and claims only its target episodes. A competing candidate for an overlapping episode is held; unrelated episodes remain free. The raw Prowlarr GUID is hashed before storage, so torrent URLs or indexer tokens are not persisted in this table.

Before any future Prowlarr grab, the worker must call `beginDispatch`. It durably changes the attempt from `reserved` to `dispatch_unknown` and grants one send action. A restart or repeated call returns `sendNow: false`; it must reconcile qBittorrent before acting again. An exact observed torrent hash can be recorded once. Different hashes conflict. Tests exercise restart and two SQLite connections against one temporary database.

This is a data boundary, not a dispatcher. It never calls Prowlarr or qBittorrent, releases a target claim, retries a failed candidate, verifies a torrent, or marks a request fulfilled. A later controlled workflow must check current Shoko/Plex availability before reservation, bind the observation to the configured Negev category and staging path, and define cleanup evidence before releasing a held target for another candidate. Node 24's `node:sqlite` support status remains a production packaging review item.
