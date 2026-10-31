import { initializeUserStore } from './user-store.mjs';

async function passwordFromStdin() {
  if (process.stdin.isTTY) throw new TypeError('Pipe the admin password through stdin');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 130) throw new TypeError('Invalid admin password');
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (Buffer.byteLength(value, 'utf8') < 12 ||
      Buffer.byteLength(value, 'utf8') > 128) {
    throw new TypeError('Invalid admin password');
  }
  return value;
}

try {
  const result = await initializeUserStore({
    dataDir: process.env.NEGEV_DATA_DIR,
    username: process.env.NEGEV_ADMIN_USERNAME,
    password: await passwordFromStdin(),
  });
  process.stdout.write(`Negev admin ${result.state}.\n`);
} catch (error) {
  process.stderr.write(`Negev admin initialization failed (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
