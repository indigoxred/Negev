# Configurable paced Plex indexing

Negev's opt-in public Plex index reads at most five cards per tick, with one tick per minute. For a large library, the initial pass can take days. Keep the default conservative; provide a separately enabled faster interval that can be tested in each installation before use.

Add an optional `NEGEV_PLEX_INDEX_INTERVAL_MS` to choose 15,000–300,000 ms. Keep 60,000 ms as the default. The scheduler remains single-flight, reads only one five-card page per tick, retains the recent-page cadence, and waits the full interval after each completed tick. Reject a supplied interval when the index observer is disabled. This only creates a private tuning option; the installed diagnostic remains at its current setting until a separate measured pilot and review.

At 15 seconds, an initial pass can be up to four times faster than the default. That estimate assumes complete, non-retrying pages and says nothing about broad availability correctness. The setting must not enable acquisition, change Plex sources, alter media, or bypass exact file checks.
