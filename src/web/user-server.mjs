import { openUserStore } from '../auth/user-store.mjs';
import { createUserService } from './user-service.mjs';
import { parseUserServerConfig } from './user-server-config.mjs';

let service;
try {
  const config = parseUserServerConfig(process.env);
  const store = await openUserStore({ dataDir: config.dataDir });
  const sessionKey = store.sessionKey;
  store.accounts.close();
  service = await createUserService({ ...config, sessionKey });
  await service.app.listen({ host: config.host, port: config.port });
  process.stdout.write(`Negev user API listening on ${config.host}:${config.port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
} catch (error) {
  if (service) await service.close();
  process.stderr.write(`Negev user API failed to start (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
