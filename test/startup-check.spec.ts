// Startup checks against real misconfigurations. Each scenario gets a NEW
// schema (never re-created under the same name) so it can't touch other tests'
// tables or see a previous scenario's objects.
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { checkPrismaRlsAdminSetup, checkPrismaRlsSetup, PrismaRlsModule } from '../src';
import { PrismaClient } from './prisma/generated/client';

const DB = 'localhost:54329/rowguard_prisma';
const SCHEMA_PREFIX = 'startup_check_';
let schemaN = 0;
let SCHEMA = '';
const TENANT_POLICY = `USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`;

const connect = (user: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://${user}:${user}@${DB}` }) });

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@${DB}` }),
});
const appUser = connect('app_user');
const adminUser = connect('rowguard_admin');
const scOwner = connect('sc_owner'); // owns the tables in the scenarios below
const scMember = connect('sc_member'); // member of sc_owner, inherits its privileges

// A fresh schema with only the tables a test needs. Runs as the superuser,
// in one transaction; SET LOCAL keeps search_path off the pooled connection.
async function scenario(sql: string) {
  SCHEMA = `${SCHEMA_PREFIX}${process.pid}_${++schemaN}`;
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA ${SCHEMA}`);
    await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app_user, rowguard_admin, sc_owner, sc_member`);
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMA}`);
    for (const statement of sql.split(';').filter((s) => s.trim())) {
      await tx.$executeRawUnsafe(statement);
    }
  });
}

const check = (client: PrismaClient, options = {}) => checkPrismaRlsSetup(client, { schema: SCHEMA, ...options });
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

beforeAll(async () => {
  await owner.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE ROLE sc_owner LOGIN PASSWORD 'sc_owner';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
  await owner.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE ROLE sc_member LOGIN PASSWORD 'sc_member' INHERIT IN ROLE sc_owner;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
});

afterAll(async () => {
  const schemas = await owner.$queryRawUnsafe<{ nspname: string }[]>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE '${SCHEMA_PREFIX}${process.pid}_%'`,
  );
  for (const { nspname } of schemas) await owner.$executeRawUnsafe(`DROP SCHEMA ${nspname} CASCADE`);
  await Promise.all([owner, appUser, adminUser, scOwner, scMember].map((c) => c.$disconnect()));
});

const goodTable = `
  CREATE TABLE "Note" (id int, "tenantId" uuid);
  ALTER TABLE "Note" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY p ON "Note" ${TENANT_POLICY};
  GRANT SELECT ON "Note" TO app_user`;

describe('app role', () => {
  it('correct setup: no issues', async () => {
    await scenario(goodTable);
    const r = await check(appUser);
    expect(r.issues).toEqual([]);
    expect(r.tenantTables).toEqual(['Note']);
  });

  it('superuser: error', async () => {
    await scenario(goodTable);
    expect(codes(await check(owner))).toContain('ROLE_SUPERUSER');
  });

  it('BYPASSRLS role used as the app client: error', async () => {
    await scenario(goodTable);
    expect(codes(await check(adminUser))).toContain('ROLE_BYPASSRLS');
  });

  it('table owner without FORCE: error', async () => {
    await scenario(`${goodTable}; ALTER TABLE "Note" OWNER TO sc_owner`);
    expect(codes(await check(scOwner))).toEqual(['TABLE_OWNER']);
  });

  it('table owner WITH FORCE: warn, because the owner can still turn RLS off', async () => {
    await scenario(`${goodTable}; ALTER TABLE "Note" OWNER TO sc_owner; ALTER TABLE "Note" FORCE ROW LEVEL SECURITY`);
    // The danger is real: the owner role itself can disable RLS (e.g. via SQL injection).
    await scOwner.$executeRawUnsafe(`ALTER TABLE ${SCHEMA}."Note" DISABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE ${SCHEMA}."Note" ENABLE ROW LEVEL SECURITY`);

    const r = await check(scOwner);
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', code: 'TABLE_OWNER_FORCED', table: 'Note' })]);
    expect(r.issues[0].message).toMatch(/non-owner role/);
  });

  it('member of the owner role really bypasses RLS, and is reported', async () => {
    await scenario(`${goodTable};
      ALTER TABLE "Note" OWNER TO sc_owner;
      INSERT INTO "Note" VALUES (1, '11111111-1111-1111-1111-111111111111')`);
    // No tenant set at all, yet the member sees the row: RLS is not applied.
    const rows = await scMember.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${SCHEMA}."Note"`);
    expect(rows).toHaveLength(1);
    expect(codes(await check(scMember))).toEqual(['TABLE_OWNER']);
  });
});

describe('tables', () => {
  it('RLS not enabled: error', async () => {
    await scenario(`CREATE TABLE "Note" (id int, "tenantId" uuid)`);
    expect(codes(await check(appUser))).toEqual(['RLS_DISABLED']);
  });

  it('RLS enabled without a policy: warn', async () => {
    await scenario(`CREATE TABLE "Note" (id int, "tenantId" uuid); ALTER TABLE "Note" ENABLE ROW LEVEL SECURITY`);
    const r = await check(appUser);
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', code: 'NO_POLICY' })]);
  });

  describe('policy without app.tenant_id', () => {
    it('permissive, for PUBLIC: error, and it really opens the table', async () => {
      await scenario(`${goodTable};
        INSERT INTO "Note" VALUES (1, '11111111-1111-1111-1111-111111111111');
        CREATE POLICY open ON "Note" USING (true)`);
      // Proof of the OR: no tenant set, yet app_user sees the row.
      expect(await appUser.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${SCHEMA}."Note"`)).toHaveLength(1);
      const r = await check(appUser);
      expect(r.issues).toEqual([expect.objectContaining({ level: 'error', code: 'POLICY_OPENS_TABLE', table: 'Note' })]);
    });

    it('permissive, targeting the app role directly: error', async () => {
      await scenario(`${goodTable}; CREATE POLICY open ON "Note" TO app_user USING (true)`);
      expect(codes(await check(appUser))).toEqual(['POLICY_OPENS_TABLE']);
    });

    it('permissive, targeting only other roles: no issue', async () => {
      await scenario(`${goodTable}; CREATE POLICY open ON "Note" TO sc_owner USING (true)`);
      expect((await check(appUser)).issues).toEqual([]);
    });

    it('restrictive: warn (AND-ed, so harmless but odd)', async () => {
      await scenario(`${goodTable}; CREATE POLICY positive_id ON "Note" AS RESTRICTIVE USING (id > 0)`);
      const r = await check(appUser);
      expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', code: 'POLICY_NO_TENANT' })]);
    });
  });

  it('no tenant tables found: warn', async () => {
    await scenario(`CREATE TABLE "Other" (id int)`);
    expect(codes(await check(appUser))).toEqual(['NO_TENANT_TABLES']);
  });

  it('custom tenant column name', async () => {
    await scenario(`CREATE TABLE "Note" (id int, org_id uuid)`);
    expect(codes(await check(appUser, { tenantColumn: 'org_id' }))).toEqual(['RLS_DISABLED']);
  });

  it('excludeTables skips a table on purpose and lists it', async () => {
    await scenario(`${goodTable}; CREATE TABLE "User" (id int, "tenantId" uuid)`);
    const r = await check(appUser, { excludeTables: ['User'] });
    expect(r.issues).toEqual([]);
    expect(r.excludedTables).toEqual(['User']);
  });

  it('limitation: a table without its own tenant column is invisible to the check', async () => {
    // "Comment" is linked to a tenant only through noteId and has no RLS at
    // all, yet nothing is reported. Hence the README rule: every tenant table
    // needs its own tenantId column.
    await scenario(`${goodTable}; CREATE TABLE "Comment" (id int, "noteId" int)`);
    const r = await check(appUser);
    expect(r.issues).toEqual([]);
    expect(r.tenantTables).toEqual(['Note']);
  });
});

describe('admin role', () => {
  it('BYPASSRLS role: no issues', async () => {
    expect(await checkPrismaRlsAdminSetup(adminUser)).toEqual([]);
  });

  it('role without BYPASSRLS: warn', async () => {
    expect((await checkPrismaRlsAdminSetup(appUser)).map((i) => i.code)).toEqual(['ADMIN_NO_BYPASSRLS']);
  });

  it('superuser: warn (more privilege than needed)', async () => {
    expect((await checkPrismaRlsAdminSetup(owner)).map((i) => i.code)).toEqual(['ADMIN_SUPERUSER']);
  });
});

describe('PrismaRlsModule startup', () => {
  const boot = async (user: string, options: object) => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaRlsModule.forRoot({
          tenantFrom: () => undefined,
          client: () => connect(user),
          schema: SCHEMA,
          ...options,
        }),
      ],
    }).compile();
    await moduleRef.init(); // runs onModuleInit, where the check happens
    return moduleRef;
  };

  afterEach(() => jest.restoreAllMocks());

  it("'error' (default): a superuser client stops the app", async () => {
    await scenario(goodTable);
    await expect(boot('postgres', {})).rejects.toThrow(/tenant isolation is not enforced[\s\S]*superuser/);
  });

  it("'warn': starts and logs the problem", async () => {
    await scenario(goodTable);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await boot('postgres', { startupCheck: 'warn' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('superuser'));
    await moduleRef.close();
  });

  it("'off': no check at all", async () => {
    await scenario(goodTable);
    const moduleRef = await boot('postgres', { startupCheck: 'off' });
    await moduleRef.close();
  });

  it('excluded tables are logged once at startup', async () => {
    await scenario(`${goodTable}; CREATE TABLE "User" (id int, "tenantId" uuid)`);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const moduleRef = await boot('app_user', { excludeTables: ['User'] });
    const calls = log.mock.calls.filter(([msg]) => String(msg).includes('excluded'));
    expect(calls).toEqual([[expect.stringContaining('User')]]);
    await moduleRef.close();
  });
});
