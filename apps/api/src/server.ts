import { buildApp } from './app.js';
import { config } from './config.js';
import { closePools } from './db/pool.js';
import { startWorker } from './worker/dispatcher.js';

const cfg = config();
const app = await buildApp();
const stopWorker = cfg.WORKER_ENABLED ? startWorker(app.log) : () => {};

await app.listen({ port: cfg.PORT, host: cfg.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopWorker();
    await app.close();
    await closePools();
    process.exit(0);
  });
}
