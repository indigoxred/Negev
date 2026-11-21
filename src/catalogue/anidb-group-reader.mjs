import { readBoundedJson } from '../http/bounded-response.mjs';

const normalize = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
const neutral = Object.freeze({ match: () => null });
function indexGroups(rows) {
  if (!Array.isArray(rows) || rows.length > 30_000) return null;
  const aliases = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.anidb_group_id) || row.anidb_group_id < 1 ||
        typeof row.name !== 'string' || !normalize(row.name) || row.name.length > 300 ||
        row.short_name != null && (typeof row.short_name !== 'string' || row.short_name.length > 300)) return null;
    const group = Object.freeze({ state: 'listed', scope: 'global', groupId: row.anidb_group_id,
      name: row.name, source: 'https://animap.id/api/anidb/groups' });
    for (const name of [row.name, row.short_name]) {
      const key = normalize(name); if (!key) continue;
      if (!aliases.has(key)) aliases.set(key, group);
      else if (aliases.get(key)?.groupId !== group.groupId) aliases.set(key, null);
    }
  }
  return Object.freeze({ match: name => aliases.get(normalize(name)) ?? null });
}

// Presentation only: a listed group is not proof of this show or exact files.
// One public global-list GET serves every search; no anime/user data is sent.
export function createAniDbGroupReader({ fetchImpl = fetch, now = Date.now, timeoutMs = 1_500 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_000) throw new TypeError('Invalid group reader');
  let cached = neutral, expiresMs = 0, pending = null;
  return { read() {
    if (expiresMs > now()) return Promise.resolve(cached);
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController(); let timer;
      try {
        const result = await Promise.race([
          (async () => {
            const response = await fetchImpl('https://animap.id/api/anidb/groups', {
              method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' }, signal: controller.signal });
            if (response.status !== 200) return null;
            return indexGroups(await readBoundedJson(response, 8_000_000));
          })().catch(() => null),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); }),
        ]);
        cached = result ?? neutral;
        expiresMs = now() + (result ? 6 * 60 * 60_000 : 60_000);
        return cached;
      } finally { clearTimeout(timer); pending = null; }
    })();
    return pending;
  } };
}
