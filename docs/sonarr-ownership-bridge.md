# Temporary Anime Sonarr ownership bridge

Negev can accept requests outside a fixed AniDB test cohort while Anime
Sonarr still monitors series only when both sources of ownership evidence are
available:

- Sonarr's supported `GET /api/v3/series` with `monitored=true` and TVDB IDs.
- The versioned `cplieger/animap` TVDB-to-AniDB release, checked against its
  published SHA-256 and its generation date.

Configure `NEGEV_SONARR_OWNERSHIP_URL` and
`NEGEV_SONARR_API_KEY_FILE=/data/secrets/sonarr.token`. The key is read from
Negev's private data directory, never from an environment variable. A missing
mapping, unavailable source, or stale observation closes new requests and
holds request selection and torrent starts. Existing completion and import
reconciliation can continue. With no fixed title cohort, this bridge is
mandatory. Keep the existing historic request suspensions until each request
is reviewed; lifting the title cohort does not lift those suspensions.

This bridge is a cutover aid, not a permanent anime identity source. After
Anime Sonarr's monitored titles are handed over, review and remove it as part
of the measured service retirement. It does not change Sonarr monitoring or
move files.

The live mapping is supplied by [cplieger/animap](https://github.com/cplieger/animap).
Its database is licensed under ODbL 1.0; Negev does not package or publish
that database. Follow its attribution and license terms when distributing a
derived database or adapting this bridge.
