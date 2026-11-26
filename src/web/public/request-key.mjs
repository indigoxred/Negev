const slot = ({ userId, anidbId, selection = 'installment' }) => {
  if (![userId, anidbId].every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new TypeError('Invalid request key scope');
  }
  if (selection !== 'installment' &&
      !/^(?:episode|film-entry)-[1-9]\d*$/.test(selection)) {
    throw new TypeError('Invalid request key selection');
  }
  return `negev-request-${userId}-${anidbId}-${selection}`;
};

export function generateRequestKey(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.getRandomValues !== 'function') {
    throw new TypeError('Secure random values are unavailable');
  }
  const bytes = new Uint8Array(16);
  cryptoSource.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Keep a key only while the result is uncertain. A saved request can be
// requested again later, and a shared browser cannot reuse another account's key.
export function createRequestKeyStore({ storage, createKey } = {}) {
  if (typeof storage?.getItem !== 'function' ||
      typeof storage?.setItem !== 'function' ||
      typeof storage?.removeItem !== 'function' ||
      typeof createKey !== 'function') {
    throw new TypeError('Invalid request key store');
  }
  return {
    pending(scope) {
      const name = slot(scope);
      const saved = storage.getItem(name);
      if (typeof saved === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(saved)) {
        return saved;
      }
      const key = createKey();
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
        throw new TypeError('Invalid generated request key');
      }
      storage.setItem(name, key);
      return key;
    },
    saved(scope, requestKey) {
      const name = slot(scope);
      if (requestKey === undefined || storage.getItem(name) === requestKey) storage.removeItem(name);
    },
    rejected(scope, result, requestKey) {
      // A lost acknowledgement is ambiguous. Only the server's definitive
      // cancellation response permits another command identity.
      const name = slot(scope);
      if (result?.reason === 'request_cancelled' &&
          (requestKey === undefined || storage.getItem(name) === requestKey)) storage.removeItem(name);
    },
  };
}
