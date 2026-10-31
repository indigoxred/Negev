import { openShokoRecentLedger } from './shoko-recent-ledger.mjs';
import { readShokoRecentPage } from './shoko-recent-catchup.mjs';
import { bootstrapShokoRecentHead } from './shoko-recent-baseline.mjs';

// Explicit first-run setup only. It never starts the account service, a scan,
// or a download. The saved watermark and head IDs share one transaction.
export async function runShokoRecentBaseline({ dbPath, shokoBaseUrl, apiKey,
  fetchImpl = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof fetchImpl !== 'function' || typeof pause !== 'function') {
    throw new TypeError('Invalid Shoko baseline reader');
  }
  const ledger = openShokoRecentLedger(dbPath);
  try {
    let reads = 0;
    return await bootstrapShokoRecentHead({ ledger,
      readPage: async (input) => {
        if (reads++ > 0) await pause(10_000);
        return readShokoRecentPage({ baseUrl: shokoBaseUrl,
          apiKey, ...input, fetchImpl });
      } });
  } finally { ledger.close(); }
}
