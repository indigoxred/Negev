import { cancelResponseBody, readBoundedJson } from '../http/bounded-response.mjs';

// Shoko's explicit Unrecognized classification is checked only after the
// exact path has remained unmatched across two quiet import observations.
export async function readShokoUnrecognizedFile({ baseUrl, apiKey, fileId,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko unrecognized lookup'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(fileId) || fileId < 1 ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 60_000) throw new TypeError('Invalid Shoko unrecognized lookup');
  try {
    const url = new URL('/api/v3/File', base);
    url.searchParams.set('include_only', 'Unrecognized');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('page', '1');
    let total=null;
    const seen = new Set();
    const signal=AbortSignal.timeout(timeoutMs);
    for(let number=1;number<=10;number++) {
      url.searchParams.set('page',String(number));
      const response=await fetchImpl(url,{method:'GET',redirect:'manual',headers:{
        Authorization:`Bearer ${apiKey}`,Accept:'application/json'},signal});
      if (response.status !== 200) await cancelResponseBody(response);
      if(response.status!==200)return {state:'unavailable'};
      const page=await readBoundedJson(response,2000000);
      if(!Number.isSafeInteger(page?.Total)||page.Total<0||page.Total>1000||
        total!==null&&total!==page.Total||!Array.isArray(page.List)||
        page.List.length!==Math.min(100,Math.max(0,page.Total-(number-1)*100))||
        page.List.some(x=>!Number.isSafeInteger(x?.ID)||x.ID<1||seen.has(x.ID)))return {state:'unavailable'};
      total=page.Total;
      for(const x of page.List){if(seen.has(x.ID))return {state:'unavailable'};seen.add(x.ID);}
      if(seen.has(fileId))return {state:'unrecognized'};
      if(seen.size===total)return {state:'not_unrecognized'};
    }
    return {state:'unavailable'};
  } catch { return { state: 'unavailable' }; }
}
