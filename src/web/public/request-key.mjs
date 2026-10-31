const slot = ({ userId, anidbId, selection = 'installment' }) => {
  if (![userId, anidbId].every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new TypeError('Invalid request key scope');
  }
  if (selection !== 'installment' && !/^episode-[1-9]\d*$/.test(selection)) {
    throw new TypeError('Invalid request key selection');
  }
  return `negev-request-${userId}-${anidbId}-${selection}`;
};

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
    saved(scope) { storage.removeItem(slot(scope)); },
  };
}
