import { openUserStore } from '../auth/user-store.mjs';
import { createUserService } from './user-service.mjs';
import { parseUserServerConfig } from './user-server-config.mjs';
import { readPrivateShokoKey } from './private-shoko-key.mjs';
import { startShokoSignalRFeed } from '../availability/shoko-signalr-feed.mjs';

let service;
let shokoFeed;
try {
  const config = parseUserServerConfig(process.env);
  const store = await openUserStore({ dataDir: config.dataDir });
  const sessionKey = store.sessionKey;
  store.accounts.close();
  const shokoApiKey = await readPrivateShokoKey({ dataDir: config.dataDir,
    keyPath: config.shokoApiKeyPath });
  service = await createUserService({ ...config, shokoApiKey, sessionKey });
  if (config.shokoEvents) {
    shokoFeed = await startShokoSignalRFeed({ baseUrl: config.shokoBaseUrl,
      apiKey: shokoApiKey, consumer: {
        accept: service.acceptShokoEvent,
        flagReconciliation: service.flagShokoReconciliation,
      } });
  }
  await service.app.listen({ host: config.host, port: config.port });
  process.stdout.write(`Negev user API listening on ${config.host}:${config.port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await shokoFeed?.close(); } finally { await service.close(); }
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
} catch (error) {
  try { await shokoFeed?.close(); } finally { if (service) await service.close(); }
  process.stderr.write(`Negev user API failed to start (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
