// Runs once before all test files. Never runs anything destructive:
// it only creates missing objects and applies pending migrations.
import { execSync } from 'child_process';
import { Client } from 'pg';

const DEFAULT_URL = 'postgresql://postgres:postgres@localhost:54329/rowguard_prisma';

// Refuse to touch anything that isn't the local test database.
export function assertTestDatabase(url: string) {
  const { hostname, pathname } = new URL(url);
  const database = pathname.slice(1);
  if (!['localhost', '127.0.0.1'].includes(hostname) || database !== 'rowguard_prisma') {
    throw new Error(
      `Refusing to run tests against ${hostname}/${database}: ` +
        'tests only run on localhost/rowguard_prisma.',
    );
  }
}

export default async function globalSetup() {
  const url = process.env.DATABASE_URL ?? DEFAULT_URL;
  assertTestDatabase(url);

  // Connect to the maintenance db `postgres` of the same server.
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const admin = new Client(maintenanceUrl.toString());
  await admin.connect();
  // Roles are shared by all databases in the cluster, so create it once, idempotently.
  await admin.query(`
    DO $$ BEGIN
      CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
  // Admin role for the bypass client: skips RLS, but still limited by GRANTs.
  await admin.query(`
    DO $$ BEGIN
      CREATE ROLE rowguard_admin LOGIN PASSWORD 'rowguard_admin' NOSUPERUSER BYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
  const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'rowguard_prisma'`);
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE rowguard_prisma');
  await admin.end();

  // Applies only pending migrations; never drops data.
  // Changed an existing migration? Run `npm run db:reset` yourself.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
