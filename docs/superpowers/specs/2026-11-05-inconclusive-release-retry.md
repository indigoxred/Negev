# Inconclusive AniDB release retry

Negev verifies every completed video through Shoko's installed AniDB release provider before it can enter Shoko Import. Shoko's release preview returns HTTP 204 both when no matching release exists and when its AniDB provider cannot answer because of a temporary ban or login problem. Negev must not import or reject a completed video solely from that status.

The present completion queue retries every 30 minutes. Each retry reads the staged video to recompute ED2K. Four completed pilot files are held this way; Shoko's own log says at least two of the latest probes found no registered release. Repeating full-file reads twice an hour without new evidence adds avoidable NAS load.

Keep the exact verification gate and other queue behavior. For the same attempt, schedule the first inconclusive lookup at 30 minutes, then 2 hours, then 8 hours, and later inconclusive lookups at 24-hour intervals. The delay changes only the `file_lookup_inconclusive` reason. An incomplete torrent retains its 5-minute delay; other holds retain their existing 30-minute delay. A different result resets the consecutive inconclusive count. The count and next due time survive a Negev restart. Older database rows migrate in place with a zero count, preserving their existing next due time and all request, torrent, handoff, and file data.

No lookup result is converted to proof of AniDB absence. No torrent, staged file, Shoko Import item, Plex record, or request is deleted or changed. Later requests and attempts continue through the normal paced worker. This is a load-control fix, not automatic fallback selection for unregistered releases.
