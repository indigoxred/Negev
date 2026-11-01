// Prowlarr can use a magnet URI as the GUID. Keep it bounded across every
// search, review, and submission gate without truncating the identity.
export const MAX_RELEASE_GUID_LENGTH = 2_048;
