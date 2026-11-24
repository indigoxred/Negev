import { mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createCatalogueTestService } from '../catalogue/catalogue-service.mjs';
import { createAiringScheduler } from '../requests/airing-scheduler.mjs';
import { parsePrivateServerConfig } from './private-server-config.mjs';

let service;
let airingScheduler;
try {
  const config = parsePrivateServerConfig(process.env);
  const dataDir = path.resolve(config.dataDir);
  if (config.dataDir !== dataDir || path.parse(dataDir).root === dataDir) {
    throw new TypeError('Dedicated canonical private directory required');
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) ||
      path.relative(dataDir, await realpath(dataDir)) !== '') {
    throw new TypeError('Private diagnostic directory required');
  }
  service = createCatalogueTestService({
    ...config, dbPath: path.join(dataDir, 'catalogue-claims.sqlite'),
  });
  await service.app.listen({ host: config.host, port: config.port });
  if (config.airingPollEnabled) {
    airingScheduler = createAiringScheduler({ runPage: service.pollAiringNextPage });
    airingScheduler.start();
  }
  process.stdout.write(`Private catalogue test listening on ${config.host}:${config.port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await airingScheduler?.stop();
    await service.close();
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
} catch (error) {
  await airingScheduler?.stop();
  if (service) await service.close();
  process.stderr.write(`Private catalogue failed to start (${error?.name ?? 'Error'}).\n`);
  process.exitCode = 1;
}
