// Per-file test data: each test file creates its own random tenants and only
// ever deletes their rows, so test files can run in parallel on one database.
import { randomUUID } from 'crypto';
import { PrismaClient } from './prisma/generated/client';

// `owner` must bypass RLS (superuser/owner), otherwise it can't see the rows.
export async function createTestTenants(owner: PrismaClient, label: string): Promise<[string, string]> {
  const ids: [string, string] = [randomUUID(), randomUUID()];
  await owner.tenant.createMany({ data: ids.map((id, i) => ({ id, name: `${label}-${i}` })) });
  return ids;
}

export async function deleteTenantData(owner: PrismaClient, ids: string[]) {
  await owner.comment.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.note.deleteMany({ where: { tenantId: { in: ids } } });
}

export async function dropTestTenants(owner: PrismaClient, ids: string[]) {
  await deleteTenantData(owner, ids);
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}
