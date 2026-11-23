// One descriptor/selected-file budget through preflight, completion and pure handoff.
// Large completed packs share this bounded file/target capacity; bonus policy
// and the existing 64 GiB video budget are independent.
export const MAX_TORRENT_FILES = 500;

export const MAX_ACQUISITION_VIDEOS = MAX_TORRENT_FILES;
export const MAX_ACQUISITION_TARGETS = MAX_TORRENT_FILES;
