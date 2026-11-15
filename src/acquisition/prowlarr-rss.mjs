import { readBoundedText } from '../http/bounded-response.mjs';

const unavailable = (retryAfterMs) => ({ state: 'unavailable',
  ...(retryAfterMs === null ? {} : { retryAfterMs }) });

function retryAfter(response) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) * 1000 :
    Date.parse(value) - Date.now();
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), 24 * 60 * 60_000) : null;
}

function xmlText(fragment) {
  if (fragment.startsWith('<![CDATA[') && fragment.endsWith(']]>')) {
    return fragment.slice(9, -3).trim();
  }
  const source = fragment;
  const entity = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
  if (/[<>]/.test(source) || source.replace(entity, '').includes('&')) return null;
  const decoded = source.replace(entity,
    (_whole, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (!entity.startsWith('#')) return named[entity.toLowerCase()];
      const value = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return value > 0 && value <= 0x10ffff &&
        !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
    });
  return decoded.trim();
}

function field(body, name) {
  const match = body.match(new RegExp(`<${name}\\s*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'));
  return match ? xmlText(match[1]) : null;
}

export async function readProwlarrRss({ baseUrl, apiKey, indexerId,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid RSS URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base.pathname) ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(indexerId) || indexerId < 1 ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Prowlarr RSS configuration');
  }
  const url = new URL(`${base.pathname}${indexerId}/api`, base);
  url.searchParams.set('t', 'search');
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { 'X-Api-Key': apiKey, Accept: 'application/rss+xml, application/xml' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return unavailable(retryAfter(response));
    const xml = await readBoundedText(response, 2_000_000);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) ||
        !/<rss(?:\s[^>]*)?>/i.test(xml) || !/<\/rss\s*>\s*$/i.test(xml) ||
        !/<channel(?:\s[^>]*)?>/i.test(xml) || !/<\/channel\s*>/i.test(xml)) {
      return unavailable(null);
    }
    const bodies = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)];
    if ((xml.match(/<item(?:\s[^>]*)?>/gi) ?? []).length !== bodies.length ||
        bodies.length > 1_000) return unavailable(null);
    const items = [];
    for (const match of bodies) {
      const title = field(match[1], 'title');
      const guid = field(match[1], 'guid');
      const published = field(match[1], 'pubDate');
      const publishedMs = published === null ? null : Date.parse(published);
      if (!title || title.length > 500 || !guid || guid.length > 3_400 ||
          (published !== null && !Number.isFinite(publishedMs))) return unavailable(null);
      items.push({ guid, title, indexerId, publishedMs });
    }
    return { state: 'feed', items };
  } catch { return unavailable(null); }
}
