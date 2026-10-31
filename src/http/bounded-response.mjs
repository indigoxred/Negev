// Read a network response under a byte ceiling. Never call Response.text(),
// which buffers the whole body before its size can be checked.
export async function readBoundedText(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !response) {
    throw new TypeError('Invalid bounded response');
  }
  // Legacy synthetic fetch fixtures have text() but no stream. Native fetch
  // always supplies a Response body; its network path never uses this branch.
  if (!(response instanceof Response) && !response.body && typeof response.text === 'function') {
    const fixture = await response.text();
    if (new TextEncoder().encode(fixture).byteLength > maxBytes) {
      throw new Error('Response exceeds byte limit');
    }
    return fixture;
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('Invalid bounded response');
  }
  const declared = response.headers?.get?.('content-length');
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new Error('Response exceeds byte limit');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error('Response exceeds byte limit');
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export async function readBoundedJson(response, maxBytes) {
  return JSON.parse(await readBoundedText(response, maxBytes));
}
