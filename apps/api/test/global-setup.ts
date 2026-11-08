import { bootstrap } from '../src/db/bootstrap.js';

export default async function setup() {
  await import('./env.js');
  if (!process.env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL is required to create the test database');
  await bootstrap({
    adminUrl: process.env.DATABASE_ADMIN_URL,
    ownerUrl: process.env.DATABASE_OWNER_URL!,
    appUrl: process.env.DATABASE_APP_URL!,
    authUrl: process.env.DATABASE_AUTH_URL!,
    workerUrl: process.env.DATABASE_WORKER_URL!,
    reset: true,
    log: () => {},
  });
}
