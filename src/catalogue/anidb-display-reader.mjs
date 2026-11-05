import { readBoundedJson } from '../http/bounded-response.mjs';

const unavailable = () => ({ state: 'unavailable' });
const cleanText = (value, maxLength) => {
  if (typeof value !== 'string' || value.length > maxLength * 3) return null;
  const text = value.replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/gi, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    }[entity.toLowerCase()] ?? ' '))
    .replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text || null : null;
};

// Optional display metadata. This source never supplies an acquisition,
// Shoko or Plex identity and cannot change a request target.
export function createAniDbDisplayReader({ fetchImpl = fetch,
  now = Date.now, timeoutMs = 8_000, concurrency = 2 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    throw new TypeError('Invalid AniDB display reader');
  }
  const cache = new Map();
  const inflight = new Map();
  const pending = [];
  let active = 0;
  const fetchRecord = async (anidbId) => {
    try {
      const response = await fetchImpl(`https://animap.id/api/anidb/${anidbId}`, {
        method: 'GET', redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return unavailable();
      const data = await readBoundedJson(response, 96_000);
      if (data?.anidb_id !== anidbId || typeof data.restricted !== 'boolean' ||
          typeof data.title !== 'string' || !data.title.trim() ||
          data.title.length > 500 ||
          data.title_english !== null && data.title_english !== undefined &&
            (typeof data.title_english !== 'string' || data.title_english.length > 500) ||
          data.description !== null && data.description !== undefined &&
            (typeof data.description !== 'string' || data.description.length > 12_000) ||
          !Array.isArray(data.tags) || data.tags.length > 100) return unavailable();
      const tags = data.tags.map((tag) => tag?.name);
      if (tags.some((tag) => typeof tag !== 'string' || !tag.trim() ||
          tag.length > 80)) return unavailable();
      return { state: 'display', anidbId, title: data.title.trim(),
        englishTitle: cleanText(data.title_english, 500),
        type: cleanText(data.type, 80),
        startYear: Number.isSafeInteger(data.startyear) &&
          data.startyear >= 1800 && data.startyear <= 2200 ? data.startyear : null,
        description: cleanText(data.description, 4_000),
        tags: tags.slice(0, 8).map((tag) => tag.trim()) };
    } catch { return unavailable(); }
  };
  const pump = () => {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active++;
      fetchRecord(job.anidbId).then((value) => {
        cache.set(job.anidbId, { value, expiresMs: now() +
          (value.state === 'display' ? 86_400_000 : 600_000) });
        while (cache.size > 200) cache.delete(cache.keys().next().value);
        inflight.delete(job.anidbId);
        job.resolve(value);
      }).finally(() => { active--; pump(); });
    }
  };
  return { read({ anidbId }) {
    if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
        anidbId > 2_147_483_647) throw new TypeError('Invalid AniDB ID');
    const hit = cache.get(anidbId);
    if (hit && hit.expiresMs > now()) {
      cache.delete(anidbId);
      cache.set(anidbId, hit);
      return Promise.resolve(hit.value);
    }
    if (hit) cache.delete(anidbId);
    if (inflight.has(anidbId)) return inflight.get(anidbId);
    if (pending.length >= 20) return Promise.resolve(unavailable());
    const result = new Promise((resolve) => {
      pending.push({ anidbId, resolve }); pump();
    });
    inflight.set(anidbId, result);
    return result;
  } };
}
