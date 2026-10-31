# Exact anime request intent

**Goal:** Plan one installment request from fully enumerated AniDB detail without invoking an indexer or creating a download. Keep Airing and Completed scopes distinct.

**Inputs:** A complete, exact AniDB detail record; a trusted `airing` or `completed` classification; and either the whole installment or explicit AniDB episode IDs. Unknown classification is held. Movies are acquired once; Airing series monitor future regular episodes, while Completed series acquire their current scope once. Explicit specials remain exact episode IDs and do not silently add other installments.

**Output:** A stable request intent containing the AniDB installment ID, exact episode IDs, and `monitorFuture`. It is not a persisted request or availability claim. Invalid, missing, duplicate or trailer-only target sets hold with a reason.

**Tests:** Synthetic movie, Airing series, Completed series, special selection, wrong/duplicate ID and incomplete detail. No live API, qBittorrent or Shoko writes.
