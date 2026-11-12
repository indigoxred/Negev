import { openUserStore } from '../auth/user-store.mjs';
import { createUserService } from './user-service.mjs';
import { dateInZone, parseUserServerConfig } from './user-server-config.mjs';
import { readPrivatePlexToken, readPrivateProwlarrKey,
  readPrivateQbittorrentPassword,
  readPrivateShokoKey, readPrivateSonarrKey } from './private-shoko-key.mjs';
import { createSonarrOwnershipGuard } from
  '../acquisition/sonarr-ownership-guard.mjs';
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
import { startParentWatchRuntime } from '../requests/start-parent-watch-runtime.mjs';

let service;
let shokoFeedSupervisor;
let shokoInventory;
let shokoProvisional;
let shokoRecent;
let airingScheduler;
let parentWatchRuntime;
let plexScheduler;
let fileBackfillScheduler;
let directAvailabilityScheduler;
let pendingTitleScheduler;
try {
  const config = parseUserServerConfig(process.env);
  const store = await openUserStore({ dataDir: config.dataDir });
  const sessionKey = store.sessionKey;
  store.accounts.close();
  const shokoApiKey = await readPrivateShokoKey({ dataDir: config.dataDir,
    keyPath: config.shokoApiKeyPath });
  const acquisitionOwnershipGate = config.sonarrOwnership ?
    createSonarrOwnershipGuard({
      sonarrBaseUrl: config.sonarrOwnership.baseUrl,
      sonarrApiKey: await readPrivateSonarrKey({ dataDir: config.dataDir,
        keyPath: config.sonarrOwnership.keyPath }) }) : null;
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
    acquisitionOwnershipGate,
    acquisitionAllowedAnidbIds: config.acquisition?.allowedAnidbIds ?? null,
    shokoApiKey, sessionKey, qbitSidecarObserver,
    ...(process.env.NEGEV_IMPORT_FENCE_TRACE === '1' ? {
      importFenceTrace: (observation) => process.stdout.write(
        `Negev Import fence ${JSON.stringify(observation)}\n`),
    } : {}),
    readShokoConnectionState: () => shokoFeedSupervisor?.getState() ??
      { state: 'disconnected' },
    onShokoReconciliationNeeded: (_fileId, fullDebtStarted) => {
      if (fullDebtStarted) shokoInventory?.requestSoon();
      shokoRecent?.requestSoon();
    },
    today: () => dateInZone(config.timeZone) });
  await startAcquisitionRuntime({ config, service, sessionGate: qbitSessionGate,
    shokoApiKey, ownershipGate: acquisitionOwnershipGate });
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
    shokoProvisional = createDirectAvailabilityScheduler({
      runOnce: service.tickShokoProvisional,
      initialDelayMs: 30_000, activeDelayMs: 2 * 60_000,
      idleDelayMs: 2 * 60_000 });
    shokoProvisional.start();
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
  parentWatchRuntime = startParentWatchRuntime({ config, shokoApiKey });
  if (config.plexIndex) {
    plexScheduler = createPlexIndexScheduler({
      sections: config.plex.publicSections,
      tickPage: service.tickPublicPlexPage,
      tickRecent: service.tickPublicPlexRecent,
      intervalMs: config.plexIndexIntervalMs,
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
  pendingTitleScheduler = createDirectAvailabilityScheduler({
    runOnce: async () => {
      const result = await service.tickPendingTitle();
      return ['resolved', 'complete'].includes(result?.state)
        ? { state: 'checked' } : result;
    },
    initialDelayMs: 10_000,
    activeDelayMs: 10_000,
    idleDelayMs: 60_000,
  });
  pendingTitleScheduler.start();
  process.stdout.write(`Negev user API listening on ${config.host}:${config.port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await airingScheduler?.stop();
      await parentWatchRuntime?.close();
      await plexScheduler?.close();
      await fileBackfillScheduler?.close();
      await directAvailabilityScheduler?.close();
      await pendingTitleScheduler?.close();
      await shokoInventory?.close();
      await shokoProvisional?.close();
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
    await parentWatchRuntime?.close();
    await plexScheduler?.close();
    await fileBackfillScheduler?.close();
    await directAvailabilityScheduler?.close();
    await pendingTitleScheduler?.close();
    await shokoInventory?.close();
    await shokoProvisional?.close();
    await shokoRecent?.close();
    await shokoFeedSupervisor?.close();
  }
  finally { if (service) await service.close(); }
  process.stderr.write(`Negev user API failed to start (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
