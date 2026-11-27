import { createHash } from 'node:crypto';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// One static file (page, script, stylesheet or font). The browser keeps a
// copy and revalidates it with its ETag, so an unchanged file costs a 304
// with no body. Files are compressed with Brotli or gzip on first request
// for that encoding and the result is kept, so startup stays fast.
const MIN_COMPRESS_BYTES = 1024;

export function createStaticAsset(body, { contentType, cacheControl, headers = {} }) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const tag = createHash('sha256').update(raw).digest('base64url').slice(0, 32);
  const encoded = new Map([['identity', raw]]);
  const bodyFor = (encoding) => {
    if (!encoded.has(encoding)) {
      encoded.set(encoding, encoding === 'br'
        ? brotliCompressSync(raw, { params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : gzipSync(raw, { level: 9 }));
    }
    return encoded.get(encoding);
  };
  return (request, reply) => {
    const accepted = String(request.headers['accept-encoding'] ?? '').toLowerCase()
      .split(',').map((part) => part.trim())
      .filter((part) => !/;\s*q=0(?:\.0*)?$/.test(part))
      .map((part) => part.split(';')[0].trim());
    const encoding = raw.length < MIN_COMPRESS_BYTES ? 'identity'
      : accepted.includes('br') ? 'br' : accepted.includes('gzip') ? 'gzip' : 'identity';
    const etag = `"${tag}${encoding === 'identity' ? '' : `-${encoding}`}"`;
    reply.headers(headers).header('Cache-Control', cacheControl)
      .header('Vary', 'Accept-Encoding').header('ETag', etag).type(contentType);
    const known = String(request.headers['if-none-match'] ?? '').split(',')
      .map((value) => value.trim().replace(/^W\//, ''));
    if (known.includes(etag) || known.includes('*')) return reply.code(304).send();
    if (encoding !== 'identity') reply.header('Content-Encoding', encoding);
    return reply.send(bodyFor(encoding));
  };
}
