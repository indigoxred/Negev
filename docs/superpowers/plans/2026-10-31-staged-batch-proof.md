# Staged batch identity proof

After a single owned torrent's completion and selected-file manifest have been observed, a diagnostic coordinator checks that every selected video is planned for the exact requested AniDB episode IDs. It rejects missing or extra selected videos, duplicate target episodes and over-budget batches before reading media bytes. It then hashes selected videos **sequentially** and requires Shoko's AniDB release preview to match each file's exact ED2K digest, size, anime and episode IDs. One failed file holds the whole batch. Finally it re-observes the torrent manifest; a change holds the result.

The result is evidence only and explicitly says `handoffReady: false`. It neither selects nor grabs a torrent, moves a file, triggers Shoko import, nor marks a request fulfilled. The episode-to-file plan is only a proposed mapping; the exact AniDB file response must prove it. A later handoff needs its own immediate file and torrent recheck and durable transaction rules.

Synthetic tests include a two-video batch with real tiny file bytes and exact AniDB release responses. No NAS media was read. Before any live hashing, benchmark the ED2K implementation and set resource limits appropriate for the NAS; the current JavaScript digest can consume sustained CPU and disk read bandwidth.
