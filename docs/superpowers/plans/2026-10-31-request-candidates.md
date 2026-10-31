# Saved request to release candidates

The private diagnostic can look up a saved held request and re-read its complete Shoko AniDB detail before sending the canonical title to Prowlarr's read-only GET search. It requires the same anime ID, installment kind, every requested AniDB episode ID, and an unrestricted detail response. Missing or changed evidence holds the search. Empty results remain non-exhaustive. Candidates stay unverified and do not change request or target status.

The route is `GET /api/requests/:id/candidates` under the existing private bearer token. It is unavailable when Prowlarr is not configured. It does not use a title supplied by the caller, grab a release, contact qBittorrent, or move files. A synthetic whole-service test covers Shoko title search, saved exact request, Shoko recheck and one Prowlarr GET.

This is a diagnostic integration, not automatic acquisition. Future work must verify the installed provider response and indexer configuration, bound query variants, select candidates without inferring exact file identity from a title, download into isolated staging, and gate the completed bytes against an AniDB registered file before Shoko handoff.
