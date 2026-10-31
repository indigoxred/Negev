import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createCatalogueTestService } from '../catalogue/catalogue-service.mjs';
import { parsePrivateServerConfig } from './private-server-config.mjs';

let service;
try {
  const config = parsePrivateServerConfig(process.env);
  const dataDir = path.resolve(config.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  service = createCatalogueTestService({
    ...config, dbPath: path.join(dataDir, 'catalogue-claims.sqlite'),
  });
  await service.app.listen({ host: config.host, port: config.port });
  process.stdout.write(`Private catalogue test listening on ${config.host}:${config.port}\n`);
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
  process.stderr.write(`Private catalogue failed to start (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
