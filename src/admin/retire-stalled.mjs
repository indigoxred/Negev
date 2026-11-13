import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAcquisitionLedger } from '../acquisition/acquisition-ledger.mjs';
import { verifyLocalStagingRoot } from '../acquisition/local-staging-root.mjs';
import { createQbittorrentSessionGate } from
  '../acquisition/qbittorrent-session-gate.mjs';
import { runStalledRetirement } from '../acquisition/run-stalled-retirement.mjs';
import { readPrivateQbittorrentPassword } from '../web/private-shoko-key.mjs';
import { parseUserServerConfig } from '../web/user-server-config.mjs';

export function parseRetirementArgs(args) {
  if (!Array.isArray(args) || args.length !== 3 ||
      !/^[1-9]\d*$/.test(args[0]) ||
      !Number.isSafeInteger(Number(args[0])) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(args[1]) ||
      args[2] !== '--delete-staged-files') {
    throw new TypeError('One attempt, exact hash and staged-file confirmation required');
  }
  return { attemptId: Number(args[0]), hash: args[1].toLowerCase() };
}

export function retirementStagingOptions(acquisition) {
  return { stagingRoot: acquisition.stagingHostPath,
    holdingRoot: acquisition.holdingRoot,
    importRoot: acquisition.importRoot,
    writablePureMove: acquisition.pureMode === true };
}

async function main() {
  const { attemptId, hash } = parseRetirementArgs(process.argv.slice(2));
  const config = parseUserServerConfig(process.env);
  if (!config.acquisitionRuntime || !config.acquisition || !config.qbitSidecar) {
    throw new TypeError('Acquisition runtime is not configured');
  }
  const password = await readPrivateQbittorrentPassword({
    dataDir: config.dataDir, keyPath: config.qbitSidecar.passwordPath });
  const gate = createQbittorrentSessionGate({
    baseUrl: config.qbitSidecar.baseUrl,
    username: config.qbitSidecar.username, password });
  const ledger = openAcquisitionLedger(config.dbPath);
  try {
    const a = config.acquisition;
    const result = await runStalledRetirement({ ledger, attemptId, hash,
      baseUrl: config.qbitSidecar.baseUrl,
      stagingRoot: a.stagingHostPath, saveRoot: a.qbitStagingRoot,
      verifyStagingRoot: () => verifyLocalStagingRoot(
        retirementStagingOptions(a)),
      sessionGate: gate });
    process.stdout.write(`Negev stalled retirement: ${result.state}` +
      `${result.reason ? ` (${result.reason})` : ''}\n`);
    if (result.state !== 'retired_stalled') process.exitCode = 2;
  } finally { ledger.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`Negev stalled retirement failed (${error?.name ?? 'Error'}).\n`);
    process.exitCode = 1;
  }
}
