import { createHash } from 'node:crypto';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// One static file (page, script, stylesheet or font). The browser keeps a
// copy and revalidates it with its ETag, so an unchanged file costs a 304
// with no body. Files are compressed with Brotli or gzip on first request
// for that encoding and the result is kept, so startup stays fast.
const MIN_COMPRESS_BYTES = 1024;

// RFC 9110 section 12.5.3: explicit refusals override wildcards; identity
// remains an acceptable fallback unless the client has excluded it too.
function chooseEncoding(header, bytes) {
  const weights = new Map();
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [coding, ...parameters] = part.trim().split(';').map(value => value.trim());
    if (!coding) continue;
    const parameter = parameters[0];
    const quality = parameter === undefined ? 1
      : parameters.length === 1 && /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(parameter)
        ? Number(parameter.slice(2)) : 0;
    weights.set(coding, quality);
  }
  const identity = weights.get('identity') ?? (weights.get('*') === 0 ? 0 : null);
  if (bytes < MIN_COMPRESS_BYTES && identity !== 0) return 'identity';
  const quality = coding => weights.get(coding) ?? weights.get('*') ?? 0;
  const coding = quality('br') >= quality('gzip') ? 'br' : 'gzip';
  if (identity !== null && identity > quality(coding)) return 'identity';
  if (quality(coding) > 0) return coding;
  return identity === 0 ? null : 'identity';
}

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
    const encoding = chooseEncoding(request.headers['accept-encoding'], raw.length);
    if (encoding === null) return reply.headers(headers).header('Vary', 'Accept-Encoding')
      .header('Cache-Control', 'no-store').code(406).send();
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
