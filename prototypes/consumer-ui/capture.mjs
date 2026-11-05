import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browser = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const previewUrl = new URL('./index.html', import.meta.url).href;
const root = join(tmpdir(), 'negev-ui-preview');
await mkdir(root, { recursive: true });
const profile = await mkdtemp(join(root, 'cdp-profile-'));
const child = spawn(browser, [
  '--headless=new', '--no-first-run', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let port;
  for (let tries = 0; tries < 100; tries += 1) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      break;
    } catch { await sleep(100); }
  }
  if (!port) throw new Error('Edge did not open a debugging port');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((entry) => entry.type === 'page');
  if (!page) throw new Error('Edge did not open a page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  for (const [name, hash, width, height] of [
    ['discover-desktop', 'discover', 1440, 900],
    ['requests-desktop', 'requests', 1440, 900],
    ['detail-desktop', 'title/4158', 1440, 900],
    ['discover-mobile', 'discover', 390, 844],
    ['requests-mobile', 'requests', 390, 844],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 650,
    });
    await send('Page.navigate', { url: `${previewUrl}#/${hash}` });
    await sleep(2000);
    const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const output = join(root, `${name}.png`);
    await writeFile(output, Buffer.from(data, 'base64'));
    process.stdout.write(`${output}\n`);
  }
  ws.close();
} finally {
  child.kill();
}
