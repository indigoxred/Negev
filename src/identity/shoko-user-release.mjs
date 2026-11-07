const unavailable = (reason) => ({ state: 'unavailable', reason });

// Shoko's supported admin action saves a User release for one existing file.
// The caller must first prove that this exact file is still unrecognized and
// must read Shoko again after the save; a 201 alone does not prove identity.
export async function saveShokoUserRelease({ baseUrl, apiKey, fileId, body,
  fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(fileId) || fileId < 1 ||
      body?.ProviderName !== 'User' || body?.IsCorrupted !== false ||
      body?.PreventRescan !== false ||
      !Array.isArray(body.CrossReferences) || body.CrossReferences.length !== 1 ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko User release request');
  }
  const url = new URL(`/api/v3/ReleaseInfo/File/${fileId}`, base);
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch { return unavailable('transport'); }
  return response.status === 201 ? { state: 'saved' }
    : unavailable(`http_${response.status}`);
}
