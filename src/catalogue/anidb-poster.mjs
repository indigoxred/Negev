import { readBoundedText } from '../http/bounded-response.mjs';

const MAX_IMAGE_BYTES = 2_000_000;

// Artwork is display-only. The catalogue identity remains the AniDB ID.
// AniMap serves AniDB's archived metadata and reports the AniDB picture
// filename, which is then read from AniDB's fixed image host.
export async function readAniDbPoster({ anidbId, fetchImpl = fetch,
  timeoutMs = 8_000 } = {}) {
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 || anidbId > 2_147_483_647 ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('Invalid AniDB poster request');
  }
  try {
    const options = { method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs) };
    const metadata = await fetchImpl(`https://animap.id/api/anidb/${anidbId}`, options);
    if (metadata.status !== 200) return { state: 'unavailable' };
    const data = JSON.parse(await readBoundedText(metadata, 64_000));
    if (data?.anidb_id !== anidbId ||
        typeof data.picture !== 'string' || !/^\d+\.jpg$/.test(data.picture)) {
      return { state: 'unavailable' };
    }
    const image = await fetchImpl(`https://cdn.anidb.net/images/main/${data.picture}`,
      options);
    if (image.status !== 200 ||
        image.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/jpeg') {
      return { state: 'unavailable' };
    }
    const imageLength = image.headers?.get?.('content-length');
    if (imageLength && (!/^\d+$/.test(imageLength) ||
        Number(imageLength) > MAX_IMAGE_BYTES)) return { state: 'unavailable' };
    const chunks = [];
    let total = 0;
    for await (const chunk of image.body) {
      total += chunk.byteLength;
      if (total > MAX_IMAGE_BYTES) return { state: 'unavailable' };
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff) return { state: 'unavailable' };
    return { state: 'image', type: 'image/jpeg', bytes };
  } catch { return { state: 'unavailable' }; }
}
