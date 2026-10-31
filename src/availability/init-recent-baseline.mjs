import { parseUserServerConfig } from '../web/user-server-config.mjs';
import { readPrivateShokoKey } from '../web/private-shoko-key.mjs';
import { runShokoRecentBaseline } from './shoko-recent-baseline-command.mjs';

try {
  if (process.argv.length !== 3 || process.argv[2] !== '--init') {
    throw new TypeError('Explicit --init argument required');
  }
  const config = parseUserServerConfig(process.env);
  if (!config.shokoRecent) throw new TypeError('Recent observer flag required');
  const apiKey = await readPrivateShokoKey({ dataDir: config.dataDir,
    keyPath: config.shokoApiKeyPath });
  const result = await runShokoRecentBaseline({ dbPath: config.dbPath,
    shokoBaseUrl: config.shokoBaseUrl, apiKey });
  if (result.state === 'baseline_saved') {
    process.stdout.write('Negev Shoko recent baseline saved.\n');
  } else {
    process.stderr.write(`Negev Shoko recent baseline held (${result.reason}).\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`Negev Shoko recent baseline failed (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
