// Isolation tests through Prisma + prismaRlsExtension, as `app_user` (RLS applies).
import { PrismaPg } from '@prisma/adapter-pg';
import { MissingTenantError, prismaRlsExtension, runWithTenant } from '../src';
import { createTestTenants, deleteTenantData, dropTestTenants } from './helpers';
import { PrismaClient } from './prisma/generated/client';

const DB = 'localhost:54329/rowguard_prisma';
// Random per file (see helpers.ts), so files can run in parallel.
let TENANT_A: string;
let TENANT_B: string;

// Superuser client without the extension: seeds and inspects, bypassing RLS.
const admin = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@${DB}` }),
});

// The app client. max: 1 = a single pooled connection, so every query reuses
// the same connection and we'd notice if a tenant setting leaked between queries.
const base = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://app_user:app_user@${DB}`, max: 1 }),
});
const prisma = base.$extends(prismaRlsExtension());

const asA = <T>(fn: () => Promise<T>) => runWithTenant(TENANT_A, fn);

beforeAll(async () => {
  [TENANT_A, TENANT_B] = await createTestTenants(admin, 'prisma');
});

beforeEach(async () => {
  // As the superuser (table owner), not app_user: RLS would hide rows from app_user.
  await deleteTenantData(admin, [TENANT_A, TENANT_B]);
  await admin.note.createMany({
    data: [
      { tenantId: TENANT_A, title: 'a1' },
      { tenantId: TENANT_A, title: 'a2' },
      { tenantId: TENANT_B, title: 'b1' },
    ],
  });
});

afterAll(async () => {
  await dropTestTenants(admin, [TENANT_A, TENANT_B]);
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
    const b1 = await admin.note.findFirstOrThrow({ where: { tenantId: TENANT_B, title: 'b1' } });
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
    expect(await admin.note.count({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } })).toBe(3);
  });
});

it('tenants used one after another on one pooled connection do not leak', async () => {
  const a = await asA(() => prisma.note.findMany());
  const b = await runWithTenant(TENANT_B, () => prisma.note.findMany());
  const a2 = await asA(() => prisma.note.findMany());
  expect([a.length, b.length, a2.length]).toEqual([2, 1, 2]);
});

it('the tenant setting does not survive COMMIT on the same connection (PgBouncer transaction mode safe)', async () => {
  await asA(() => prisma.note.findMany()); // nestjs-prisma-rls: BEGIN; set_config(..., true); query; COMMIT
  // Same single pooled connection, now outside any transaction, without nestjs-prisma-rls:
  const [row] = await base.$queryRaw<{ v: string | null }[]>`SELECT current_setting('app.tenant_id', true) AS v`;
  expect(row.v).toBe(''); // defined-but-empty after a local set_config: no tenant left behind
  expect(await base.note.count()).toBe(0); // and RLS shows nothing
});

describe('relations between tenant tables (foreign keys)', () => {
  // Postgres checks foreign keys WITHOUT applying RLS. A plain FK
  // Comment.noteId -> Note.id lets tenant B attach rows to tenant A's note.
  const noteOfA = () => admin.note.findFirstOrThrow({ where: { tenantId: TENANT_A } });

  it("tenant B cannot create a Comment pointing to tenant A's Note", async () => {
    const note = await noteOfA();
    await expect(
      runWithTenant(TENANT_B, () => prisma.comment.create({ data: { body: 'x', noteId: note.id } })),
    ).rejects.toThrow();
    expect(await admin.comment.count({ where: { noteId: note.id } })).toBe(0);
  });

  it("the error for another tenant's note id is the same as for a missing id (no existence leak)", async () => {
    const note = await noteOfA();
    const attempt = (noteId: number) =>
      runWithTenant(TENANT_B, () => prisma.comment.create({ data: { body: 'x', noteId } })).then(
        () => 'created',
        (err: { code?: string }) => err.code,
      );
    const otherTenant = await attempt(note.id);
    const missing = await attempt(2_000_000_000);
    expect(otherTenant).toBe(missing);
  });
});
