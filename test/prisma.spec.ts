// Isolation tests through Prisma + rowguardExtension, as `app_user` (RLS applies).
import { PrismaPg } from '@prisma/adapter-pg';
import { MissingTenantError, rowguardExtension, runWithTenant } from '../src';
import { PrismaClient } from './prisma/generated/client';

const DB = 'localhost:54329/rowguard_prisma';
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

// Superuser client without the extension: seeds and inspects, bypassing RLS.
const admin = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@${DB}` }),
});

// The app client. max: 1 = a single pooled connection, so every query reuses
// the same connection and we'd notice if a tenant setting leaked between queries.
const base = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://app_user:app_user@${DB}`, max: 1 }),
});
const prisma = base.$extends(rowguardExtension());

const asA = <T>(fn: () => Promise<T>) => runWithTenant(TENANT_A, fn);

beforeAll(async () => {
  await admin.tenant.createMany({
    data: [
      { id: TENANT_A, name: 'A' },
      { id: TENANT_B, name: 'B' },
    ],
    skipDuplicates: true,
  });
});

beforeEach(async () => {
  // As the superuser (table owner), not app_user: RLS would hide rows from app_user.
  await admin.$executeRaw`TRUNCATE "Comment", "Note" RESTART IDENTITY CASCADE`;
  await admin.note.createMany({
    data: [
      { tenantId: TENANT_A, title: 'a1' },
      { tenantId: TENANT_A, title: 'a2' },
      { tenantId: TENANT_B, title: 'b1' },
    ],
  });
});

afterAll(async () => {
  await base.$disconnect();
  await admin.$disconnect();
});

const titlesOf = async (tenantId: string) =>
  (await admin.note.findMany({ where: { tenantId }, orderBy: { title: 'asc' } })).map((n) => n.title);

describe('reads', () => {
  it('findMany returns only the current tenant rows (no where clause)', async () => {
    const notes = await asA(() => prisma.note.findMany({ orderBy: { title: 'asc' } }));
    expect(notes.map((n) => n.title)).toEqual(['a1', 'a2']);
  });

  it('count and findFirst are filtered too', async () => {
    expect(await asA(() => prisma.note.count())).toBe(2);
    expect(await asA(() => prisma.note.findFirst({ where: { title: 'b1' } }))).toBeNull();
  });
});

describe('writes to another tenant', () => {
  it('updateMany cannot touch them', async () => {
    const res = await asA(() => prisma.note.updateMany({ where: { title: 'b1' }, data: { title: 'x' } }));
    expect(res.count).toBe(0);
    expect(await titlesOf(TENANT_B)).toEqual(['b1']);
  });

  it('update by id fails as "not found"', async () => {
    const b1 = await admin.note.findFirstOrThrow({ where: { title: 'b1' } });
    await expect(asA(() => prisma.note.update({ where: { id: b1.id }, data: { title: 'x' } }))).rejects.toThrow();
    expect(await titlesOf(TENANT_B)).toEqual(['b1']);
  });

  it('deleteMany without a filter deletes only own rows', async () => {
    const res = await asA(() => prisma.note.deleteMany());
    expect(res.count).toBe(2);
    expect(await titlesOf(TENANT_B)).toEqual(['b1']);
  });
});

describe('creates (tenantId filled by the database default)', () => {
  it('create without tenantId gets the current tenant', async () => {
    // Also a compile-time check: `tenant: { connect }` is not required.
    const note = await asA(() => prisma.note.create({ data: { title: 'new' } }));
    expect(note.tenantId).toBe(TENANT_A);
  });

  it('nested create fills tenantId on the children too', async () => {
    const note = await asA(() =>
      prisma.note.create({
        data: { title: 'parent', comments: { create: [{ body: 'c1' }, { body: 'c2' }] } },
        include: { comments: true },
      }),
    );
    expect(note.tenantId).toBe(TENANT_A);
    expect(note.comments.map((c) => c.tenantId)).toEqual([TENANT_A, TENANT_A]);
  });

  it('createMany without tenantId', async () => {
    await asA(() => prisma.note.createMany({ data: [{ title: 'm1' }, { title: 'm2' }] }));
    expect(await titlesOf(TENANT_A)).toEqual(['a1', 'a2', 'm1', 'm2']);
  });

  it("create with another tenant's id is rejected (WITH CHECK)", async () => {
    await expect(
      asA(() => prisma.note.create({ data: { title: 'evil', tenantId: TENANT_B } })),
    ).rejects.toThrow(/row-level security/);
    expect(await titlesOf(TENANT_B)).toEqual(['b1']);
  });
});

describe('fail closed', () => {
  it('throws MissingTenantError without a tenant context', async () => {
    await expect(prisma.note.findMany()).rejects.toThrow(MissingTenantError);
  });

  it('create without tenant context and without the extension fails at the DB (NOT NULL)', async () => {
    await expect(base.note.create({ data: { title: 'orphan' } })).rejects.toThrow();
  });

  it('a malicious tenant id is a bound parameter, not SQL', async () => {
    const evil = `'); DROP TABLE "Note"; --`;
    // Not a valid uuid, so the policy cast fails; the table must survive.
    await expect(runWithTenant(evil, () => prisma.note.findMany())).rejects.toThrow();
    expect(await admin.note.count()).toBe(3);
  });
});

it('tenants used one after another on one pooled connection do not leak', async () => {
  const a = await asA(() => prisma.note.findMany());
  const b = await runWithTenant(TENANT_B, () => prisma.note.findMany());
  const a2 = await asA(() => prisma.note.findMany());
  expect([a.length, b.length, a2.length]).toEqual([2, 1, 2]);
});
