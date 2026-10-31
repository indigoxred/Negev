const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// One torrent owns one staging directory. A shared save path can let common
// release names such as 01.mkv collide before identity verification.
export function stagingSavePath(hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) {
    throw new TypeError('Invalid torrent hash for staging');
  }
  return `/negev-staging/${hash}`;
}

export function matchesStagingSavePath(expected) {
  return typeof expected?.hash === 'string' && HASH.test(expected.hash) &&
    expected.savePath === stagingSavePath(expected.hash);
}
