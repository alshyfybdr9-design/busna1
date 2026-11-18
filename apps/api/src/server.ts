import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { buildApp } from './app.js';
import { config } from './config.js';
import { closePools } from './db/pool.js';
import { startWorker } from './worker/dispatcher.js';

const cfg = config();

/**
 * WEB_CONCURRENCY: عدد نسخ الخادم داخل الحاوية الواحدة (نسخة لكل معالج).
 * 1 = عملية واحدة (الافتراضي)، 0 = عدد المعالجات المتاحة.
 * العامل الخلفي (الإشعارات وفحوص السلامة) يعمل في نسخة واحدة فقط.
 */
const n = cfg.WEB_CONCURRENCY === 0 ? availableParallelism() : cfg.WEB_CONCURRENCY;

if (n > 1 && cluster.isPrimary) {
  // أي نسخة تتوقف تُستبدل؛ ونسخة العامل الخلفي تُستبدل بنسخة تشغّله
  const runsWorker = new Map<number, boolean>();
  const spawn = (withWorker: boolean) => runsWorker.set(cluster.fork({ BUSNA_RUN_WORKER: withWorker ? '1' : '0' }).id, withWorker);
  for (let i = 0; i < n; i++) spawn(i === 0);
  cluster.on('exit', (w, code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGINT') return;
    console.error(`server process ${w.process.pid} exited (${code ?? signal}); restarting`);
    const had = runsWorker.get(w.id) ?? false;
    runsWorker.delete(w.id);
    spawn(had);
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      for (const w of Object.values(cluster.workers ?? {})) w?.kill(sig);
      process.exit(0);
    });
  }
} else {
  const app = await buildApp();
  const runWorker = cfg.WORKER_ENABLED && (n <= 1 || process.env.BUSNA_RUN_WORKER === '1');
  const stopWorker = runWorker ? startWorker(app.log) : () => {};

  await app.listen({ port: cfg.PORT, host: cfg.HOST });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      stopWorker();
      await app.close();
      await closePools();
      process.exit(0);
    });
  }
}
