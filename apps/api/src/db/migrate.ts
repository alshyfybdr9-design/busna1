import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');

/** يطبّق ملفات SQL بالترتيب مرة واحدة لكل ملف، باستخدام اتصال المالك */
export async function migrate(ownerUrl: string, log = console.log) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const applied = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [f]);
        await client.query('commit');
        log(`applied ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    console.error('DATABASE_OWNER_URL is required');
    process.exit(1);
  }
  migrate(url).then(() => console.log('migrations complete'), (e) => {
    console.error(e.message);
    process.exit(1);
  });
}
