# Pre-download AniDB correspondence

Torrent inspection reports evidence for each selected video, separately from
Shoko's filename prediction. Unknown evidence never prevents acquisition.

- **Previously verified exact file:** the same torrent and planned file have a
  recorded pure move and exact playback proof. Shoko's current file must match
  that move's physical inode, size and timestamp. Its computed ED2K and size
  must match an AniMap AniDB file record for exactly the requested episodes.
  This describes the previous download, not verification of future bytes.
- **Likely correspondence:** a bracketed publisher-advertised CRC32 in the
  filename and the exact torrent-file size match one AniDB file and all its
  requested episode IDs. CRC32 is not cryptographic identity proof.
- **Filename prediction only:** Shoko predicts the requested identity from the
  filename, but file registration remains unknown.
- **Unknown:** no usable checksum, lookup failure, conflicting or ambiguous
  records, or the bounded lookup budget was exhausted. Unknown does not mean
  the file is absent from AniDB or unusable by Shoko.

Partially matched packs remain partial. A group name, search query, title match
or BitTorrent info hash never proves AniDB file registration. None of these
labels skips stopped-torrent, identity, completion, Shoko or Plex checks.

The existing [AniMap file endpoint](https://animap.id/docs/anidb) supplies these
records. The service caches at most 512 hash-and-size responses for six hours
(five minutes for empty or failed lookups). Records are revalidated against
each caller's anime and episode IDs. Each inspection permits at most eight
new AniMap lookups and three seconds total enrichment, with a one-second
per-operation deadline. Shared limits allow two concurrent lookups and 60 new
lookups per minute. Remaining files are explicitly unknown. No catalogue
mirror, new service or media scan is involved.

The add/start coordinator uses per-attempt live ownership inside Negev's single
writer process. A pending add cannot be claimed by start recovery, and an
already-claimed start owns its attempt while authentication is pending. Other
attempts and completion continue independently. Durable dispatch intents remain
authoritative after restart; an uncertain add is observed by exact hash rather
than sent a second time.
