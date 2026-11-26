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

// A failed parallel request leaves its fulfilled siblings without consumers.
// Start cleanup without delaying the original failure, including responses
// that arrive after Promise.all has already rejected.
export async function fetchResponsesOrCancel(requests) {
  const received = [];
  let failed = false;
  try {
    return await Promise.all(requests.map(request => {
      const pending = Promise.resolve(request()).then(response => {
        if (failed) void cancelResponseBody(response);
        else received.push(response);
        return response;
      });
      // A later request may throw before Promise.all receives this promise.
      // Observe its rejection immediately while keeping it in the aggregate.
      void pending.catch(() => {});
      return pending;
    }));
  } catch (error) {
    failed = true;
    for (const response of received) void cancelResponseBody(response);
    throw error;
  }
}

async function consumeChunks(response, maxBytes, consume, signal) {
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
  let cancelled = false;
  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    beginCleanup(() => reader ? reader.cancel() : iterator.return?.());
  };
  signal?.addEventListener('abort', stop, { once: true });
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Response batch cancelled');
      const item = await (reader ? reader.read() : iterator.next());
      if (signal?.aborted) throw new Error('Response batch cancelled');
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw new TypeError('Invalid response byte chunk');
      total += item.value.byteLength;
      if (total > maxBytes) throw new Error('Response exceeds byte limit');
      consume(item.value);
    }
  } catch (error) {
    stop();
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop);
    if (reader) reader.releaseLock();
  }
  return total;
}
async function readText(response, maxBytes, signal) {
  validate(response, maxBytes);
  // Legacy isolated fetch fixtures supply text() without a native stream.
  if (!(response instanceof Response) && !response.body && typeof response.text === 'function') {
    const fixture = await response.text();
    if (new TextEncoder().encode(fixture).byteLength > maxBytes) throw new Error('Response exceeds byte limit');
    return fixture;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  await consumeChunks(response, maxBytes, chunk => { text += decoder.decode(chunk, { stream: true }); }, signal);
  return text + decoder.decode();
}
export function readBoundedText(response, maxBytes) {
  return readText(response, maxBytes);
}

// Own the readers as well as the responses. A body already locked by a
// sibling bounded read cannot be cancelled through response.body.cancel().
export async function readBoundedTexts(entries) {
  const controller = new AbortController();
  try {
    return await Promise.all(entries.map(([response, maxBytes]) =>
      readText(response, maxBytes, controller.signal)));
  } catch (error) {
    controller.abort();
    throw error;
  }
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
