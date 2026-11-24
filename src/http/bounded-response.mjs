// Bound bytes while reading, including when Content-Length is absent or false.
const validate = (response, maxBytes) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !response) {
    throw new TypeError('Invalid bounded response');
  }
};
const beginCleanup = (cancel) => {
  // A cloned/teed body's cancellation can wait on an unrelated reader. Start
  // disposal, handle its rejection, and let the original rejection progress.
  try { void Promise.resolve(cancel()).catch(() => {}); } catch {}
};
export async function cancelResponseBody(response) {
  beginCleanup(() => response?.body?.cancel?.());
}
async function consumeChunks(response, maxBytes, consume) {
  validate(response, maxBytes);
  const body = response.body;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function' &&
      typeof body.getReader !== 'function') throw new TypeError('Invalid bounded response');
  const declared = response.headers?.get?.('content-length');
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await cancelResponseBody(response);
    throw new Error('Response exceeds byte limit');
  }
  const reader = typeof body.getReader === 'function' ? body.getReader() : null;
  const iterator = reader ?? body[Symbol.asyncIterator]();
  let total = 0;
  try {
    for (;;) {
      const item = await (reader ? reader.read() : iterator.next());
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw new TypeError('Invalid response byte chunk');
      total += item.value.byteLength;
      if (total > maxBytes) throw new Error('Response exceeds byte limit');
      consume(item.value);
    }
  } catch (error) {
    beginCleanup(() => reader ? reader.cancel() : iterator.return?.());
    throw error;
  } finally {
    if (reader) reader.releaseLock();
  }
  return total;
}
export async function readBoundedText(response, maxBytes) {
  validate(response, maxBytes);
  // Legacy isolated fetch fixtures supply text() without a native stream.
  if (!(response instanceof Response) && !response.body && typeof response.text === 'function') {
    const fixture = await response.text();
    if (new TextEncoder().encode(fixture).byteLength > maxBytes) throw new Error('Response exceeds byte limit');
    return fixture;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  await consumeChunks(response, maxBytes, chunk => { text += decoder.decode(chunk, { stream: true }); });
  return text + decoder.decode();
}
export async function readBoundedBytes(response, maxBytes) {
  const chunks = [];
  const total = await consumeChunks(response, maxBytes, chunk => chunks.push(chunk));
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function readBoundedJson(response, maxBytes) {
  return JSON.parse(await readBoundedText(response, maxBytes));
}
