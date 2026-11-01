import * as signalR from '@microsoft/signalr';

const targets = ['file:detected', 'file:hashed', 'file:relocated',
  'file:deleted', 'file:updated'];

function defaultConnection({ url, accessTokenFactory }) {
  return new signalR.HubConnectionBuilder()
    .withUrl(url, { accessTokenFactory })
    .withAutomaticReconnect()
    .configureLogging(signalR.LogLevel.Error)
    .build();
}

// Opt-in transport. A live installed-server subscription still needs a
// controlled proof; the module never starts merely because it was imported.
export async function startShokoSignalRFeed({ baseUrl, apiKey, consumer,
  createConnection = defaultConnection } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) ||
      typeof consumer?.accept !== 'function' ||
      typeof consumer?.flagReconciliation !== 'function' ||
      typeof createConnection !== 'function') {
    throw new TypeError('Invalid Shoko feed configuration');
  }
  const url = new URL('/signalr/aggregate', base).href;
  const connection = createConnection({ url, accessTokenFactory: () => apiKey });
  if (typeof connection?.on !== 'function' || typeof connection?.off !== 'function' ||
      typeof connection?.onreconnecting !== 'function' ||
      typeof connection?.onreconnected !== 'function' ||
      typeof connection?.onclose !== 'function' ||
      typeof connection?.start !== 'function' ||
      typeof connection?.invoke !== 'function' ||
      typeof connection?.stop !== 'function') {
    throw new TypeError('Invalid Shoko SignalR connection');
  }
  let stopping = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const handlers = new Map(targets.map((target) =>
    [target, (event) => consumer.accept(target, [event])]));
  for (const [target, handler] of handlers) connection.on(target, handler);
  const join = async () => {
    // Shoko 6's hub method has two SignalR arguments even though its
    // nullable lastConnectedAt parameter has a C# default value.
    await connection.invoke('feed.join_single', 'file', null);
    const joined = await connection.invoke('feed.list_joined');
    if (!Array.isArray(joined) || !joined.includes('file')) {
      throw new Error('Shoko file feed unavailable');
    }
  };
  connection.onreconnecting(() => {
    if (!stopping) consumer.flagReconciliation('feed_disconnected');
  });
  connection.onreconnected(async () => {
    if (stopping) return;
    try {
      await join();
      consumer.flagReconciliation('feed_reconnected');
    } catch {
      consumer.flagReconciliation('feed_disconnected');
      await connection.stop();
    }
  });
  connection.onclose(() => {
    if (!stopping) consumer.flagReconciliation('feed_disconnected');
    resolveClosed();
  });
  try {
    await connection.start();
    await join();
    consumer.flagReconciliation('feed_started');
  } catch (error) {
    for (const [target, handler] of handlers) connection.off(target, handler);
    await connection.stop();
    throw error;
  }
  return {
    closed,
    async close() {
      if (stopping) return;
      stopping = true;
      for (const [target, handler] of handlers) connection.off(target, handler);
      await connection.stop();
      resolveClosed();
    },
  };
}
