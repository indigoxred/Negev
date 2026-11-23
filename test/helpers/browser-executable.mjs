import {existsSync} from 'node:fs';
export function findTestBrowser({platform=process.platform,browser=process.env.NEGEV_TEST_BROWSER,exists=existsSync}={}) {
  // Fresh Chromium profiles can trigger Windows account authentication probes.
  // Keep native browser execution in Linux CI; use the connected browser for live checks.
  if(platform==='win32')return undefined;
  return [browser,'/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(exists);
}

export const browserSkipReason=process.platform==='win32' ? 'Native browser fixtures disabled on Windows; run them in Linux CI' : 'No supported test browser installed';
