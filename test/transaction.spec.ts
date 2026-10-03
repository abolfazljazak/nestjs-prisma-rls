// The user's own prisma.$transaction(...) with nestjs-prisma-rls.
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma } from '@prisma/client/extension';
import { MissingTenantError, prismaRlsExtension, runWithTenant, TenantSwitchError } from '../src';
import { createTestTenants, deleteTenantData, dropTestTenants } from './helpers';
import { PrismaClient } from './prisma/generated/client';

const DB = 'localhost:54329/rowguard_prisma';
// Random per file (see helpers.ts), so files can run in parallel.
let TENANT_A: string;
let TENANT_B: string;

const admin = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@${DB}` }),
});
// One connection: a second, hidden transaction would have to wait for it -> deadlock.
const base = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://app_user:app_user@${DB}`, max: 1 }),
});
const prisma = base.$extends(prismaRlsExtension());

const asA = <T>(fn: () => Promise<T>) => runWithTenant(TENANT_A, fn);
const countA = () => admin.note.count({ where: { tenantId: TENANT_A } });

beforeAll(async () => {
  [TENANT_A, TENANT_B] = await createTestTenants(admin, 'transaction');
});

beforeEach(async () => {
  // As the superuser (table owner), not app_user: RLS would hide rows from app_user.
  await deleteTenantData(admin, [TENANT_A, TENANT_B]);
  await admin.note.createMany({
    data: [
      { tenantId: TENANT_A, title: 'a1' },
      { tenantId: TENANT_B, title: 'b1' },
    ],
  });
});

afterAll(async () => {
  await dropTestTenants(admin, [TENANT_A, TENANT_B]);
  await base.$disconnect();
  await admin.$disconnect();
});

describe('interactive $transaction', () => {
  it('reads and writes as the current tenant', async () => {
    const titles = await asA(() =>
      prisma.$transaction(async (tx) => {
        await tx.note.create({ data: { title: 'a2' } }); // tenantId from the DB default
        return (await tx.note.findMany({ orderBy: { title: 'asc' } })).map((n) => n.title);
      }),
    );
    expect(titles).toEqual(['a1', 'a2']);
  });

  it('rolls back everything when the callback throws (one real transaction)', async () => {
    await expect(
      asA(() =>
        prisma.$transaction(async (tx) => {
          await tx.note.create({ data: { title: 'a2' } });
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(await countA()).toBe(1); // a2 was rolled back
  });

  it('raw queries on tx see the tenant too', async () => {
    const rows = await asA(() =>
      prisma.$transaction((tx) => tx.$queryRaw<{ title: string }[]>`SELECT title FROM "Note"`),
    );
    expect(rows.map((r) => r.title)).toEqual(['a1']);
  });

  it('passes options through (isolationLevel)', async () => {
    const rows = await asA(() =>
      prisma.$transaction((tx) => tx.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`, {
        isolationLevel: 'Serializable',
      }),
    );
    expect(rows[0].transaction_isolation).toBe('serializable');
  });

  it('nested runWithTenant with the same tenant inside the callback is fine', async () => {
    const n = await asA(() => prisma.$transaction((tx) => runWithTenant(TENANT_A, () => tx.note.count())));
    expect(n).toBe(1);
  });

  it('switching to a different tenant inside the callback throws (and rolls back)', async () => {
    await expect(
      asA(() =>
        prisma.$transaction(async (tx) => {
          await tx.note.create({ data: { title: 'a2' } });
          return runWithTenant(TENANT_B, () => tx.note.findMany());
        }),
      ),
    ).rejects.toThrow(TenantSwitchError);
    expect(await countA()).toBe(1); // a2 rolled back
  });

  it('throws MissingTenantError without a tenant, before opening a transaction', async () => {
    await expect(prisma.$transaction(async (tx) => tx.note.count())).rejects.toThrow(MissingTenantError);
  });

  it('documented behavior: outer `prisma` inside the callback runs in its own transaction', async () => {
    // Pool of 1: the outer query would need a second connection while the
    // user's transaction holds the only one. Use a separate 2-connection client.
    const base2 = new PrismaClient({
      adapter: new PrismaPg({ connectionString: `postgresql://app_user:app_user@${DB}`, max: 2 }),
    });
    const prisma2 = base2.$extends(prismaRlsExtension());
    try {
      await expect(
        asA(() =>
          prisma2.$transaction(async () => {
            await prisma2.note.create({ data: { title: 'outside-tx' } }); // wrong: not `tx`
            throw new Error('boom');
          }),
        ),
      ).rejects.toThrow('boom');
      // Still tenant-filtered (no leak), but NOT rolled back: it was its own transaction.
      expect(await countA()).toBe(2);
    } finally {
      await base2.$disconnect();
    }
  });
});

describe('batch $transaction', () => {
  it('is rejected with a clear error', async () => {
    await expect(
      // @ts-expect-error -- the array form is removed from the types too
      asA(() => prisma.$transaction([prisma.note.count()])),
    ).rejects.toThrow(/batch transactions are not supported/);
  });
});

describe('tx type', () => {
  // An extension added BEFORE nestjs-prisma-rls (the supported order).
  const withHelpers = base.$extends({
    model: {
      note: {
        async titles() {
          const ctx = Prisma.getExtensionContext(this);
          const notes: { title: string }[] = await (ctx as any).findMany({ orderBy: { title: 'asc' } });
          return notes.map((n) => n.title);
        },
      },
    },
  });
  const prismaH = withHelpers.$extends(prismaRlsExtension());

  it('keeps methods from extensions added before nestjs-prisma-rls, at compile time and runtime', async () => {
    const titles = await asA(() =>
      prismaH.$transaction(async (tx) => {
        const t: string[] = await tx.note.titles(); // compile-time: method exists, typed
        // @ts-expect-error -- like Prisma's own tx, no nested $transaction
        void tx.$transaction;
        return t;
      }),
    );
    expect(titles).toEqual(['a1']);
  });
});
