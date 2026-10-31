# Exact Shoko/Plex availability decision

**Goal:** Evaluate a requested AniDB episode from normalized Shoko and public Plex observations. Do not use title, filename or season-number inference.

**Input contract:** Shoko must report a complete, healthy set of files associated with the exact AniDB anime/episode IDs. Each file has a stable, adapter-verified storage key. Plex must report a complete, healthy set of media parts with storage keys and library IDs. The future adapters must prove these keys refer to the same NAS bytes across different container mount paths; this pure evaluator does not make that translation.

**Decision:** A matching Shoko file with a readable media part in an allowed public Plex library is Available. A Shoko match with no public Plex part is Awaiting Plex. No exact Shoko match after a complete observation is Absent. Unhealthy or incomplete observations are Unknown; conflicting Shoko claims for the same storage key are Held. Duplicate encodes and multi-episode files are allowed only with exact provider associations. A private/test Plex part never counts.

**Tests:** Synthetic exact match, direct Shoko import without request ownership, wrong installment, missing Plex, private Plex only, duplicate encodes, multi-episode file, conflicts, and observer outage. No live media or NAS scan.
