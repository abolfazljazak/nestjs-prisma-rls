// Pure Postgres RLS tests: no rowguard code involved.
// They prove the policy in setup.sql isolates tenants on its own.
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const HOST = { host: 'localhost', port: 54329, database: 'rowguard_test' };
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const admin = new Client({ ...HOST, user: 'postgres', password: 'postgres' });
const app = new Client({ ...HOST, user: 'app_user', password: 'app_user' });

// What rowguard will do later: set the tenant for one transaction only.
// The `true` argument of set_config means "local to this transaction" (like SET LOCAL).
async function asTenant(tenantId: string, sql: string, params: unknown[] = []) {
  await app.query('BEGIN');
  try {
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await app.query(sql, params);
    await app.query('COMMIT');
    return result;
  } catch (err) {
    await app.query('ROLLBACK');
    throw err;
  }
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(readFileSync(join(__dirname, 'setup.sql'), 'utf8'));
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  // Seed as the superuser, which bypasses RLS.
  await admin.query('TRUNCATE "Note" RESTART IDENTITY');
  await admin.query(
    `INSERT INTO "Note" ("tenantId", title) VALUES ($1, 'a1'), ($1, 'a2'), ($2, 'b1')`,
    [TENANT_A, TENANT_B],
  );
});

const countAll = async () => Number((await admin.query('SELECT count(*) FROM "Note"')).rows[0].count);

it('SELECT returns only the current tenant rows', async () => {
  const { rows } = await asTenant(TENANT_A, 'SELECT title FROM "Note" ORDER BY title');
  expect(rows.map((r) => r.title)).toEqual(['a1', 'a2']);
});

it('UPDATE cannot touch another tenant rows', async () => {
  const res = await asTenant(TENANT_A, `UPDATE "Note" SET title = 'hacked' WHERE title = 'b1'`);
  expect(res.rowCount).toBe(0);
  const { rows } = await admin.query(`SELECT title FROM "Note" WHERE "tenantId" = $1`, [TENANT_B]);
  expect(rows[0].title).toBe('b1');
});

it('UPDATE cannot move a row into another tenant (WITH CHECK)', async () => {
  await expect(
    asTenant(TENANT_A, `UPDATE "Note" SET "tenantId" = $1 WHERE title = 'a1'`, [TENANT_B]),
  ).rejects.toThrow(/row-level security/);
});

it('DELETE cannot remove another tenant rows', async () => {
  const res = await asTenant(TENANT_A, 'DELETE FROM "Note"');
  expect(res.rowCount).toBe(2); // only a1, a2
  expect(await countAll()).toBe(1); // b1 survived
});

it('INSERT for another tenant is rejected', async () => {
  await expect(
    asTenant(TENANT_A, `INSERT INTO "Note" ("tenantId", title) VALUES ($1, 'x')`, [TENANT_B]),
  ).rejects.toThrow(/row-level security/);
});

it('without a tenant: reads return nothing, writes fail (fail closed)', async () => {
  // Fresh query with no set_config at all: setting is NULL.
  expect((await app.query('SELECT * FROM "Note"')).rowCount).toBe(0);
  await expect(
    app.query(`INSERT INTO "Note" ("tenantId", title) VALUES ($1, 'x')`, [TENANT_A]),
  ).rejects.toThrow(/row-level security/);
});

it("reused connection after a finished transaction: setting is '' and NULLIF prevents a cast error", async () => {
  await asTenant(TENANT_A, 'SELECT 1'); // leaves the setting defined on this connection

  // Outside any transaction now: the local value is gone, but it is '' not NULL.
  const { rows } = await app.query("SELECT current_setting('app.tenant_id', true) AS v");
  expect(rows[0].v).toBe('');

  // Without NULLIF this would be ''::uuid -> "invalid input syntax for type uuid".
  await expect(app.query("SELECT ''::uuid")).rejects.toThrow(/invalid input syntax/);
  // With NULLIF the policy simply matches nothing.
  expect((await app.query('SELECT * FROM "Note"')).rowCount).toBe(0);
});

it('superuser bypasses RLS (why the app must not connect as one)', async () => {
  expect(await countAll()).toBe(3);
});
