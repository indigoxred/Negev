# Private held-request flow

**Goal:** Connect search, complete AniDB detail, conservative release-state inference, exact intent planning and the durable request ledger behind a diagnostic-only endpoint. It does not search indexers or download anything.

**Authority:** The route takes an AniDB ID, scope, optional episode IDs and a retry key. It never accepts requester ID or Airing/Completed from the client. The diagnostic service assigns one fixed test requester, requires the ID from a recent successful search, loads all episode pages from Shoko, holds restricted or incomplete titles, infers status from Shoko dates, and persists only a planner-validated exact scope. All saved requests and targets remain held.

**Tests:** Synthetic Shoko v3 responses with dates and one episode; search then submit, duplicate retry, held unknown date, unseen ID, wrong episode and client-supplied forged status/requester fields. Use temporary SQLite and Fastify injection. No live Shoko token, user account, indexer, qBittorrent, media or production service.
