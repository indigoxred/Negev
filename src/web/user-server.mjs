import { closeInOrder, createShutdownListener } from '../runtime/close-in-order.mjs';
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
import { openReleaseFeedLedger } from '../acquisition/release-feed-ledger.mjs';
import { readProwlarrRss } from '../acquisition/prowlarr-rss.mjs';
import { createReleaseFeedScheduler } from '../acquisition/release-feed-scheduler.mjs';
import { startParentWatchRuntime } from '../requests/start-parent-watch-runtime.mjs';
import { setHeldDiagnostics } from '../runtime/held-diagnostics.mjs';

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
let releaseFeedLedger;
let releaseFeedScheduler;
// Secrets read during startup. A startup error message is printed to the
// operator, so any of these values (and token-like URL parameters) are
// redacted from it first.
const loadedSecrets = [];
const remember = (value) => {
  if (typeof value === 'string' && value.length >= 4) loadedSecrets.push(value);
  return value;
};
function redactStartupMessage(text, secrets = loadedSecrets) {
  let result = String(text ?? '');
  for (const secret of secrets) result = result.split(secret).join('[redacted]');
  return result.replace(/([?&](?:x-plex-token|apikey|api_key|token|password)=)[^&\s]+/gi,
    '$1[redacted]');
}
async function closeAll() {
  await closeInOrder([
    ['airing scheduler',()=>airingScheduler?.stop()],
    ['release feed scheduler',()=>releaseFeedScheduler?.stop()],
    ['release feed ledger',()=>releaseFeedLedger?.close()],
    ['parent watches',()=>parentWatchRuntime?.close()],
    ['Plex scheduler',()=>plexScheduler?.close()],
    ['file backfill scheduler',()=>fileBackfillScheduler?.close()],
    ['direct availability scheduler',()=>directAvailabilityScheduler?.close()],
    ['pending title scheduler',()=>pendingTitleScheduler?.close()],
    ['Shoko inventory scheduler',()=>shokoInventory?.close()],
    ['Shoko provisional scheduler',()=>shokoProvisional?.close()],
    ['Shoko recent scheduler',()=>shokoRecent?.close()],
    ['Shoko feed supervisor',()=>shokoFeedSupervisor?.close()],
    ['user service',()=>service?.close()],
  ]);
}

try {
  const config = parseUserServerConfig(process.env);
  // Errors that workers turn into a held-and-retry reason are logged (rate
  // limited) unless the log level is error or silent.
  if (!['silent', 'error'].includes(config.logLevel)) {
    setHeldDiagnostics(({ scope, reason, error }) => process.stderr.write(
      `${JSON.stringify({ level: 'warn', time: Date.now(), msg: 'Negev work held',
        scope, reason, error: redactStartupMessage(error) })}\n`));
  }
  const store = await openUserStore({ dataDir: config.dataDir });
  const sessionKey = store.sessionKey;
  store.accounts.close();
  const shokoApiKey = remember(await readPrivateShokoKey({ dataDir: config.dataDir,
    keyPath: config.shokoApiKeyPath }));
  const acquisitionOwnershipGate = config.sonarrOwnership ?
    createSonarrOwnershipGuard({
      sonarrBaseUrl: config.sonarrOwnership.baseUrl,
      sonarrApiKey: remember(await readPrivateSonarrKey({ dataDir: config.dataDir,
        keyPath: config.sonarrOwnership.keyPath })) }) : null;
  const plex = config.plex ? { ...config.plex,
    plexToken: remember(await readPrivatePlexToken({ dataDir: config.dataDir,
      keyPath: config.plex.plexTokenPath })) } : null;
  const prowlarr = config.prowlarr ? { ...config.prowlarr,
    apiKey: remember(await readPrivateProwlarrKey({ dataDir: config.dataDir,
      keyPath: config.prowlarr.keyPath })) } : null;
  const qbitSessionGate = config.qbitSidecar ?
    createQbittorrentSessionGate({ baseUrl: config.qbitSidecar.baseUrl,
      username: config.qbitSidecar.username,
      password: remember(await readPrivateQbittorrentPassword({
        dataDir: config.dataDir,
        keyPath: config.qbitSidecar.passwordPath })) }) : null;
  const qbitSidecarObserver = qbitSessionGate ? {
    importSavePath: config.qbitSidecar.importSavePath,
    ...createQbittorrentSidecarObserver({
      baseUrl: config.qbitSidecar.baseUrl,
      sessionGate: qbitSessionGate,
    }),
  } : null;
  service = await createUserService({ ...config, plex, prowlarr,
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel,
      serializers: {err:error=>({type:error?.name??'Error',
        message:redactStartupMessage(error?.message),
        ...(typeof error?.stack==='string'?{stack:redactStartupMessage(error.stack)}:{})})},
      // Never write cookies, CSRF tokens or credentials to the log.
      redact: ['req.headers.cookie', 'req.headers["x-negev-csrf"]',
        'req.headers.authorization', 'res.headers["set-cookie"]'] },
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
  if (config.acquisitionRuntime && prowlarr) {
    releaseFeedLedger = openReleaseFeedLedger(config.dbPath, {
      aliasesForId: service.cachedReleaseAliases,
      onWake: (id, notification) => service.wakeReleaseRequest(id, notification) });
    releaseFeedScheduler = createReleaseFeedScheduler({
      indexerIds: prowlarr.indexerIds, feedLedger: releaseFeedLedger,
      readFeed: (indexerId) => readProwlarrRss({
        baseUrl: prowlarr.baseUrl, apiKey: prowlarr.apiKey, indexerId }),
    });
    releaseFeedScheduler.start();
  }
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
      runOnce: service.tickShokoProvisional, name: 'Shoko provisional',
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
      hasRecentArrival: service.hasRecentArrival,
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
      runOnce: cycle.runOnce, name: 'availability cycle',
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
    name: 'pending title',
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
    await closeAll();
  };
  const stopListener=createShutdownListener(stop,error=>{
    process.exitCode=1;
    process.stderr.write(`Negev shutdown failed: ${redactStartupMessage(error?.message)}\n`);
  });
  process.on('SIGINT',stopListener);
  process.on('SIGTERM',stopListener);
} catch (error) {
  try { await closeAll(); }
  catch (closeError) {
    process.stderr.write(`Negev shutdown after a failed start also failed: ${
      redactStartupMessage(closeError?.message)}\n`);
  }
  const detail = redactStartupMessage(error?.message).trim();
  process.stderr.write(`Negev user API failed to start (${error?.name ?? 'Error'})${
    detail ? `: ${detail}` : ''}.\n`);
  if (process.env.NEGEV_DEBUG_STARTUP === '1' && error?.stack) {
    process.stderr.write(`${redactStartupMessage(error.stack)}\n`);
  }
  process.exitCode = 1;
}
