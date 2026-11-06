import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAcquisitionLedger } from '../acquisition/acquisition-ledger.mjs';
import { verifyLocalStagingRoot } from '../acquisition/local-staging-root.mjs';
import { createQbittorrentSessionGate } from
  '../acquisition/qbittorrent-session-gate.mjs';
import { runPrestartMismatchRetirement } from
  '../acquisition/run-prestart-mismatch-retirement.mjs';
import { readPrivateQbittorrentPassword } from '../web/private-shoko-key.mjs';
import { parseUserServerConfig } from '../web/user-server-config.mjs';

export function parsePrestartMismatchArgs(args) {
  if (!Array.isArray(args) || args.length !== 3 ||
      !/^[1-9]\d*$/.test(args[0]) ||
      !Number.isSafeInteger(Number(args[0])) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(args[1]) ||
      args[2] !== '--remove-torrent-only') {
    throw new TypeError('One attempt, exact hash and torrent-only confirmation required');
  }
  return { attemptId: Number(args[0]), hash: args[1].toLowerCase() };
}

async function main() {
  const { attemptId, hash } = parsePrestartMismatchArgs(process.argv.slice(2));
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
    const result = await runPrestartMismatchRetirement({ ledger, attemptId,
      hash, baseUrl: config.qbitSidecar.baseUrl,
      stagingRoot: a.stagingHostPath, saveRoot: a.qbitStagingRoot,
      verifyStagingRoot: () => verifyLocalStagingRoot({
        stagingRoot: a.stagingHostPath, holdingRoot: a.holdingRoot,
        importRoot: a.importRoot }),
      sessionGate: gate });
    process.stdout.write(`Negev prestart retirement: ${result.state}` +
      `${result.reason ? ` (${result.reason})` : ''}\n`);
    if (result.state !== 'retired_prestart_mismatch') process.exitCode = 2;
  } finally { ledger.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`Negev prestart retirement failed (${error?.name ?? 'Error'}).\n`);
    process.exitCode = 1;
  }
}
