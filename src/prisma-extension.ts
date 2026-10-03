import { Prisma } from '@prisma/client/extension';
import { getTenantId } from './context';

// The generic client type inside defineExtension() does not include the raw
// query methods, although every real PrismaClient has them. Describe just what we use.
interface RawCapableClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $transaction<T>(queries: Promise<T>[]): Promise<T[]>;
}

/**
 * Prisma Client extension that runs every model query inside a short
 * transaction which first sets the tenant for that transaction:
 *
 *   BEGIN; SELECT set_config('app.tenant_id', $1, true); <query>; COMMIT;
 *
 * Both statements run on the same pooled connection, so the RLS policy
 * sees the tenant. `true` = local to the transaction, so it can't leak
 * to the next user of that connection.
 */
export function rowguardExtension() {
  return Prisma.defineExtension((client) => {
    const raw = client as unknown as RawCapableClient;
    return client.$extends({
      name: 'rowguard',
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            // Throws before touching the database if there is no tenant.
            const tenantId = getTenantId();
            // Batch $transaction: Prisma sends both on one connection, in order.
            // ${tenantId} becomes a bind parameter ($1), not string concatenation.
            const [, result] = await raw.$transaction<unknown>([
              raw.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
              query(args),
            ]);
            return result;
          },
        },
      },
    });
  });
}
