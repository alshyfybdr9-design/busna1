/** تشغيل سياسة الاحتفاظ يدويًا أو من مُجدول خارجي (cron) */
import { runRetention } from './dispatcher.js';
import { closePools } from '../db/pool.js';

const r = await runRetention();
console.log(JSON.stringify(r));
await closePools();
