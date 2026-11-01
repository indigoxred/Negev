import { openUserStore } from '../auth/user-store.mjs';
import { createUserService } from './user-service.mjs';
import { dateInZone, parseUserServerConfig } from './user-server-config.mjs';
import { readPrivatePlexToken, readPrivateProwlarrKey,
  readPrivateQbittorrentPassword,
  readPrivateShokoKey } from './private-shoko-key.mjs';
import { createQbittorrentSidecarObserver } from
  '../availability/qbittorrent-sidecar-observer.mjs';
import { createQbittorrentSessionGate } from
  '../acquisition/qbittorrent-session-gate.mjs';
import { startShokoSignalRFeed } from '../availability/shoko-signalr-feed.mjs';
import { createShokoFeedStatusReporter } from
  '../availability/shoko-feed-status.mjs';
import { createShokoFeedSupervisor } from
  '../availability/shoko-feed-supervisor.mjs';
import { createShokoInventoryScheduler } from
  '../availability/shoko-inventory-scheduler.mjs';
import { createShokoRecentScheduler } from
  '../availability/shoko-recent-scheduler.mjs';
import { createAiringScheduler } from '../requests/airing-scheduler.mjs';
import { createPlexIndexScheduler } from '../availability/plex-index-scheduler.mjs';
import { createFileBackfillScheduler } from
  '../availability/file-backfill-scheduler.mjs';
import { createDirectAvailabilityScheduler } from
  '../availability/direct-availability-scheduler.mjs';
import { createAvailabilityCycle } from '../availability/availability-cycle.mjs';
import { forwardShokoEvent } from '../availability/shoko-event-consumer.mjs';
import { startAcquisitionRuntime } from '../acquisition/start-acquisition-runtime.mjs';

let service;
let shokoFeedSupervisor;
let shokoInventory;
let shokoRecent;
let airingScheduler;
let plexScheduler;
let fileBackfillScheduler;
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
  const qbitSessionGate = config.qbitSidecar ?
    createQbittorrentSessionGate({ baseUrl: config.qbitSidecar.baseUrl,
      username: config.qbitSidecar.username,
      password: await readPrivateQbittorrentPassword({
        dataDir: config.dataDir,
        keyPath: config.qbitSidecar.passwordPath }) }) : null;
  const qbitSidecarObserver = qbitSessionGate ? {
    importSavePath: config.qbitSidecar.importSavePath,
    ...createQbittorrentSidecarObserver({
      baseUrl: config.qbitSidecar.baseUrl,
      sessionGate: qbitSessionGate,
    }),
  } : null;
  service = await createUserService({ ...config, plex, prowlarr,
    shokoApiKey, sessionKey, qbitSidecarObserver,
    readShokoConnectionState: () => shokoFeedSupervisor?.getState() ??
      { state: 'disconnected' },
    onShokoReconciliationNeeded: (_fileId, fullDebtStarted) => {
      if (fullDebtStarted) shokoInventory?.requestSoon();
      shokoRecent?.requestSoon();
    },
    today: () => dateInZone(config.timeZone) });
  await startAcquisitionRuntime({ config, service, sessionGate: qbitSessionGate });
  await service.app.listen({ host: config.host, port: config.port });
  const reportShokoFeedStatus = createShokoFeedStatusReporter();
  const flagShokoGap = (reason) => {
    reportShokoFeedStatus(reason);
    service.flagShokoReconciliation(reason);
    shokoInventory?.requestSoon();
    shokoRecent?.requestSoon();
  };
  if (config.shokoEvents) {
    shokoFeedSupervisor = createShokoFeedSupervisor({
      connect: () => startShokoSignalRFeed({ baseUrl: config.shokoBaseUrl,
        apiKey: shokoApiKey, consumer: {
          accept: (target, args) => {
            return forwardShokoEvent({
              consumer: { accept: service.acceptShokoEvent,
                getState: service.getShokoEventState },
              requestReconciliation: (_result, fullDebtStarted) => {
                if (fullDebtStarted) shokoInventory?.requestSoon();
                shokoRecent?.requestSoon();
              },
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
  if (config.shokoRecent) {
    shokoRecent = createShokoRecentScheduler({
      scan: service.tickShokoRecentScan,
      drainOne: service.tickShokoRecentDrain,
    });
    shokoRecent.start();
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
  if (config.fileBackfill) {
    fileBackfillScheduler = createFileBackfillScheduler({
      tick: service.tickFileBackfill,
      intervalMs: config.fileBackfillIntervalMs,
    });
    fileBackfillScheduler.start();
  }
  if (config.directAvailability || config.titleCheck) {
    const cycle = createAvailabilityCycle({
      runDirect: config.directAvailability ? service.tickDirectAvailability : null,
      runTitle: config.titleCheck ? service.tickTitleCheck : null,
    });
    directAvailabilityScheduler = createDirectAvailabilityScheduler({
      runOnce: cycle.runOnce,
      activeDelayMs: config.directActiveDelayMs,
      idleDelayMs: config.titleCheck ? 60_000 : 5 * 60_000 });
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
      await fileBackfillScheduler?.close();
      await directAvailabilityScheduler?.close();
      await shokoInventory?.close();
      await shokoRecent?.close();
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
    await fileBackfillScheduler?.close();
    await directAvailabilityScheduler?.close();
    await shokoInventory?.close();
    await shokoRecent?.close();
    await shokoFeedSupervisor?.close();
  }
  finally { if (service) await service.close(); }
  process.stderr.write(`Negev user API failed to start (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
