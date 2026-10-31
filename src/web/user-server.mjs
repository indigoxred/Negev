import { openUserStore } from '../auth/user-store.mjs';
import { createUserService } from './user-service.mjs';
import { dateInZone, parseUserServerConfig } from './user-server-config.mjs';
import { readPrivateShokoKey } from './private-shoko-key.mjs';
import { startShokoSignalRFeed } from '../availability/shoko-signalr-feed.mjs';
import { createShokoInventoryScheduler } from
  '../availability/shoko-inventory-scheduler.mjs';
import { createAiringScheduler } from '../requests/airing-scheduler.mjs';

let service;
let shokoFeed;
let shokoInventory;
let airingScheduler;
try {
  const config = parseUserServerConfig(process.env);
  const store = await openUserStore({ dataDir: config.dataDir });
  const sessionKey = store.sessionKey;
  store.accounts.close();
  const shokoApiKey = await readPrivateShokoKey({ dataDir: config.dataDir,
    keyPath: config.shokoApiKeyPath });
  service = await createUserService({ ...config, shokoApiKey, sessionKey,
    today: () => dateInZone(config.timeZone) });
  if (config.shokoEvents) {
    shokoFeed = await startShokoSignalRFeed({ baseUrl: config.shokoBaseUrl,
      apiKey: shokoApiKey, consumer: {
        accept: service.acceptShokoEvent,
        flagReconciliation: service.flagShokoReconciliation,
      } });
  }
  await service.app.listen({ host: config.host, port: config.port });
  if (config.shokoInventory) {
    shokoInventory = createShokoInventoryScheduler({ tick: service.tickShokoInventory });
    shokoInventory.start();
  }
  if (config.airingWatch) {
    airingScheduler = createAiringScheduler({ runPage: service.pollAiringNextPage,
      pageDelayMs: 60_000 });
    airingScheduler.start();
  }
  process.stdout.write(`Negev user API listening on ${config.host}:${config.port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await airingScheduler?.stop();
      await shokoInventory?.close();
      await shokoFeed?.close();
    }
    finally { await service.close(); }
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
} catch (error) {
  try {
    await airingScheduler?.stop();
    await shokoInventory?.close();
    await shokoFeed?.close();
  }
  finally { if (service) await service.close(); }
  process.stderr.write(`Negev user API failed to start (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
