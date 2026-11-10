# Measured anime acquisition ownership

The owner wants one acquisition owner per title during the Negev cutover. Anime Sonarr still monitors 99 series and can search/download, so enabling unrestricted acquisition on the public Negev instance would create overlap.

For a measured first cohort, Negev accepts an optional startup list of exact AniDB IDs. When present, only saved requests for those IDs enter its acquisition request queue. All other requests remain saved and visible but cannot reach indexer or qBittorrent work. A malformed or empty list fails startup rather than widening access. The default without the setting preserves current installations.

The first installed cohort must contain only verified non-Sonarr titles from the existing Negev pilot. The public review keeps its prior requests suspended until inspected individually. Stopping the old Negev worker and enabling the new one is a separate backed-up change. Sonarr's 99 watches and Seerr's existing request history remain intact until their exact replacement is proved.

Verification: parser rejects bad IDs and disabled-runtime use; queue skips noncohort IDs across cursor wrap/restart while allowing cohort IDs; existing tests pass; installed image is pinned; live request/attempt/handoff counts, health and rollback are checked before and after.
