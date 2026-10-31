# Narrow qBittorrent completion observation

Negev can query one expected torrent by exact hash with qBittorrent v5's read-only `GET /api/v2/torrents/info?hashes=...` and `GET /api/v2/torrents/files?hash=...`. It reads torrent and file state twice and holds if the relevant fields change. The existing pure completion evaluator then checks exact category, staging save path, selected file names, file priorities, completion and safe video extensions.

This adapter has synthetic tests only. It does not log in, query a live qBittorrent instance, change priorities, grab a release, download anything, hash media or import a file. Completion is prerequisite evidence for a later AniDB byte check, not an import approval. No qBittorrent credential or NAS path belongs in this repository.

Source: [official qBittorrent 5 WebUI API](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29), torrent list and torrent contents sections.
