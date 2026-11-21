// Torrent descriptors contain per-piece hashes, not the video bytes. A valid
// season descriptor can exceed 2 MB; keep every byte boundary consistent.
export const MAX_TORRENT_METAINFO_BYTES = 8 * 1024 * 1024;
