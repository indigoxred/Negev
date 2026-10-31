import { openUserStore } from '../auth/user-store.mjs';
import { createUserService } from './user-service.mjs';
import { dateInZone, parseUserServerConfig } from './user-server-config.mjs';
import { readPrivatePlexToken, readPrivateProwlarrKey,
  readPrivateShokoKey } from './private-shoko-key.mjs';
import { startShokoSignalRFeed } from '../availability/shoko-signalr-feed.mjs';
import { createShokoFeedSupervisor } from
  '../availability/shoko-feed-supervisor.mjs';
import { createShokoInventoryScheduler } from
  '../availability/shoko-inventory-scheduler.mjs';
import { createAiringScheduler } from '../requests/airing-scheduler.mjs';
import { createPlexIndexScheduler } from '../availability/plex-index-scheduler.mjs';
import { createDirectAvailabilityScheduler } from
  '../availability/direct-availability-scheduler.mjs';
import { forwardShokoEvent } from '../availability/shoko-event-consumer.mjs';

let service;
let shokoFeedSupervisor;
let shokoInventory;
let airingScheduler;
let plexScheduler;
let directAvailabilityScheduler;
try {
  const config = parseUserServerConfig(process.env);
  const store = await openUserStore({ dataDir: config.dataDir });
  const sessionKey = store.sessionKey;
  store.accounts.close();
  const shokoApiKey = await readPrivateShokoKey({ dataDir: config.dataDir,
    keyPath: config.shokoApiKeyPath });
  const plex = config.plex ? { ...config.plex,
    plexToken: await readPrivatePlexToken({ dataDir: config.dataDir,
      keyPath: config.plex.plexTokenPath }) } : null;
  const prowlarr = config.prowlarr ? { ...config.prowlarr,
    apiKey: await readPrivateProwlarrKey({ dataDir: config.dataDir,
      keyPath: config.prowlarr.keyPath }) } : null;
  service = await createUserService({ ...config, plex, prowlarr,
    shokoApiKey, sessionKey,
    onShokoReconciliationNeeded: () => shokoInventory?.requestSoon(),
    today: () => dateInZone(config.timeZone) });
  await service.app.listen({ host: config.host, port: config.port });
  const flagShokoGap = (reason) => {
    service.flagShokoReconciliation(reason);
    shokoInventory?.requestSoon();
  };
  if (config.shokoEvents) {
    shokoFeedSupervisor = createShokoFeedSupervisor({
      connect: () => startShokoSignalRFeed({ baseUrl: config.shokoBaseUrl,
        apiKey: shokoApiKey, consumer: {
          accept: (target, args) => {
            return forwardShokoEvent({
              consumer: { accept: service.acceptShokoEvent },
              requestReconciliation: () => shokoInventory?.requestSoon(),
              target, args,
            });
          },
          flagReconciliation: flagShokoGap,
        } }),
      onGap: flagShokoGap,
    });
    shokoFeedSupervisor.start();
  }
  if (config.shokoInventory) {
    shokoInventory = createShokoInventoryScheduler({ tick: service.tickShokoInventory });
    shokoInventory.start();
  }
  if (config.airingWatch) {
    airingScheduler = createAiringScheduler({ runPage: service.pollAiringNextPage,
      pageDelayMs: 60_000 });
    airingScheduler.start();
  }
  if (config.plexIndex) {
    plexScheduler = createPlexIndexScheduler({
      sections: config.plex.publicSections,
      tickPage: service.tickPublicPlexPage,
      tickRecent: service.tickPublicPlexRecent,
    });
    plexScheduler.start();
  }
  if (config.directAvailability) {
    directAvailabilityScheduler = createDirectAvailabilityScheduler({
      runOnce: service.tickDirectAvailability });
    directAvailabilityScheduler.start();
  }
  process.stdout.write(`Negev user API listening on ${config.host}:${config.port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await airingScheduler?.stop();
      await plexScheduler?.close();
      await directAvailabilityScheduler?.close();
      await shokoInventory?.close();
      await shokoFeedSupervisor?.close();
    }
    finally { await service.close(); }
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
} catch (error) {
  try {
    await airingScheduler?.stop();
    await plexScheduler?.close();
    await directAvailabilityScheduler?.close();
    await shokoInventory?.close();
    await shokoFeedSupervisor?.close();
  }
  finally { if (service) await service.close(); }
  process.stderr.write(`Negev user API failed to start (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
