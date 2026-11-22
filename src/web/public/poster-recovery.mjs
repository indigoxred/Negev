// Native image errors do not expose Retry-After. One same-origin HEAD probe
// distinguishes a missing image from a temporary hold, then schedules at most
// one native lazy retry after that hold. No cache-busting or recurring polling.
export function attachPosterRecovery(image, { schedule = setTimeout,
  cancel = clearTimeout, now = Date.now,
  probe = source => fetch(source, { method: 'HEAD', credentials: 'same-origin',
    signal: AbortSignal.timeout(10_000) }) } = {}) {
  let retried = false, timer = null, loaded = false;
  image.addEventListener('load', () => {
    loaded = true;
    image.classList.remove('missing-art');
    if (timer !== null) { cancel(timer); timer = null; }
  });
  image.addEventListener('error', async () => {
    loaded = false;
    image.classList.add('missing-art');
    if (retried) return;
    retried = true;
    const source = image.getAttribute('src');
    let delay = 60_000;
    try {
      const response = await probe(source);
      if (response.status === 200) delay = 0;
      else if ([408, 429, 503].includes(response.status) || response.status >= 500) {
        const raw = response.headers.get('retry-after');
        const deadline = /^\d+$/.test(raw ?? '') ? now() + Number(raw) * 1000 : Date.parse(raw);
        if (Number.isFinite(deadline)) delay = Math.max(1000, deadline - now());
      } else return; // A real 404, authorization failure or invalid image is not retried.
    } catch { /* One delayed retry is still useful after a failed connection. */ }
    // Do not create years-long or overflowing timers from an invalid header.
    if (!Number.isFinite(delay) || delay > 300_000 || loaded ||
        !image.isConnected || image.getAttribute('src') !== source) return;
    timer = schedule(() => {
      if (timer === null) return;
      timer = null;
      if (!image.isConnected || image.getAttribute('src') !== source) return;
      image.classList.remove('missing-art');
      image.src = source;
    }, delay);
  });
}
