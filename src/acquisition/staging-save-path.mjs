import path from 'node:path';

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DEFAULT_SAVE_ROOT = '/Downloads/negev';
export const validStagingSaveRoot = (value) => typeof value === 'string' &&
  value.startsWith('/') && value !== '/' &&
  !/[\\\0\r\n]/.test(value) &&
  path.posix.normalize(value) === value &&
  !value.split('/').includes('..') &&
  !value.split('/').includes('.') &&
  !value.endsWith('/');

// One torrent owns one staging directory. A shared save path can let common
// release names such as 01.mkv collide before identity verification.
export function stagingSavePath(hash, { saveRoot = DEFAULT_SAVE_ROOT } = {}) {
  if (typeof hash !== 'string' || !HASH.test(hash) ||
      !validStagingSaveRoot(saveRoot)) {
    throw new TypeError('Invalid torrent hash for staging');
  }
  return `${saveRoot}/${hash}`;
}

export function matchesStagingSavePath(expected,
  { saveRoot = DEFAULT_SAVE_ROOT } = {}) {
  return typeof expected?.hash === 'string' && HASH.test(expected.hash) &&
    validStagingSaveRoot(saveRoot) &&
    expected.savePath === stagingSavePath(expected.hash, { saveRoot });
}
