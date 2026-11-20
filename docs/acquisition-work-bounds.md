# Acquisition decision work

Availability uncertainty belongs to an episode, not its whole request. Known
Shoko ownership and old playable proofs select exact targets for rechecking.
An uncertain or uninspected owned target stays protected. Independently missing
episodes remain eligible, with the usual final fresh absence and claim checks.
A pack containing protected targets cannot authorize their duplicate download.

Each pass rechecks at most 16 owned targets, four concurrently, with a five-second
deadline per observation. Uninspected targets remain uncertain. Checks rotate
fairly; an unavailable target cannot starve the rest. Positives are reused for
five minutes, explicit missing results for ten seconds and uncertainty for five
seconds. Target source revisions and file events invalidate affected evidence.
The 2,048-entry cache starts empty after restart.

Discovery issues at most 16 queries per call. Larger requests give each missing
episode a canonical query before broad aliases and additional targeted aliases.
Successful nonempty query results are reused for five minutes, empty results
for twenty seconds, with at most 64 cached query results. New request wakeups
invalidate the affected title's query results.

Automatic preflight checks are memoized in the private SQLite database. Valid
plans last fifteen minutes; explicit deterministic rejections last six hours.
These are read results, not dispatch authorization. Changed identity, filename,
size, query, target scope, hydration or relevant file events invalidate them.
Transient provider errors are not memoized as permanent rejections. Manual
inspection performs a fresh check. The cache stores at most 512 records of at
most 64 KB each and persists no raw candidate GUID, proxy URL or credentials.

Cached checks do not consume the three-new-preflight page budget. Later pack
phases can therefore reuse already inspected files without another long series
of provider reads or scheduler turns. Provider failures advance through other
candidates and retain a short retry, rather than masquerading as an empty set.

The queue retains the decision start across candidate pages, phase changes,
retries and restarts. A newly added episode scope starts its own decision clock.
The first complete decision is recorded separately from torrent download,
Shoko identification and Plex publication timestamps. These later stages and
the intentional preferred-group wait are not included in a completed acquisition
decision's elapsed time. The responding-provider target is fifteen minutes.

Every saved retry deadline reaches the running scheduler. Its bounded local
deadline page is refreshed during operation, including deadlines advanced by
other workers. New submissions lead old backlog while completion/start/publish
stages retain turns. New aired targets become immediately eligible even if
the preceding empty watch had a later deadline. Legacy NULL-due busy-reader
checks resume on both request and start queues; existing dispatch intents,
cancellation, suspensions and ownership guards remain intact.
