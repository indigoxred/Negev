import { openShokoRecentLedger } from './shoko-recent-ledger.mjs';
import { readShokoRecentPage } from './shoko-recent-catchup.mjs';
import { bootstrapShokoRecentHead } from './shoko-recent-baseline.mjs';

// Explicit first-run setup only. It never starts the account service, a scan,
// or a download. The saved watermark and head IDs share one transaction.
export async function runShokoRecentBaseline({ dbPath, shokoBaseUrl, apiKey,
  fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid Shoko baseline reader');
  }
  const ledger = openShokoRecentLedger(dbPath);
  try {
    return await bootstrapShokoRecentHead({ ledger,
      readPage: (input) => readShokoRecentPage({ baseUrl: shokoBaseUrl,
        apiKey, ...input, fetchImpl }) });
  } finally { ledger.close(); }
}
