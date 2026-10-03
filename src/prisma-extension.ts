import { Prisma } from '@prisma/client/extension';
import { getTenantId } from './context';

// The generic client type inside defineExtension() does not include the raw
// query methods, although every real PrismaClient has them. Describe just what we use.
interface RawCapableClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $transaction<T>(queries: Promise<T>[]): Promise<T[]>;
  $transaction<R>(fn: (tx: RawCapableClient) => Promise<R>, options?: unknown): Promise<R>;
}

// Same shape as Prisma's own transaction options.
export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
}

// What `tx` looks like: the client without the methods Prisma removes inside
// an interactive transaction (same list as Prisma's ITXClientDenyList).
export type TransactionClient<C> = Omit<C, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use'>;

/** The Postgres setting the RLS policies read. */
export const TENANT_SETTING = 'app.tenant_id';

const setTenant = (client: RawCapableClient, tenantId: string) =>
  // ${tenantId} becomes a bind parameter ($1), not string concatenation.
  // `true` = local to the current transaction.
  client.$executeRaw`SELECT set_config(${TENANT_SETTING}, ${tenantId}, true)`;

/**
 * Prisma Client extension for tenant isolation with Postgres RLS.
 *
 * - Model queries: each runs in a short transaction that first sets the tenant:
 *   BEGIN; SELECT set_config('app.tenant_id', $1, true); <query>; COMMIT;
 * - prisma.$transaction(async (tx) => ...): sets the tenant once at the start
 *   of the user's transaction. `tx` comes from the client *below* nestjs-prisma-rls,
 *   so its queries skip our hook and run inside that same transaction.
 *   Add nestjs-prisma-rls as the last extension, or later extensions won't be on `tx`.
 * - prisma.$transaction([...]) (batch form) is not supported.
 */
export function prismaRlsExtension() {
  return Prisma.defineExtension((client) => {
    const raw = client as unknown as RawCapableClient;
    return client.$extends({
      name: 'nestjs-prisma-rls',
      client: {
        // Replaces Prisma's overloaded $transaction; only the interactive form remains.
        $transaction<This, R>(
          this: This,
          fn: (tx: TransactionClient<This>) => Promise<R>,
          options?: TransactionOptions,
        ): Promise<R> {
          if (typeof fn !== 'function') {
            // Array form, e.g. from plain JS or a cast. Must return a rejected promise.
            return Promise.reject(
              new Error('nestjs-prisma-rls: batch transactions are not supported; use the interactive form: prisma.$transaction(async (tx) => ...)'),
            );
          }
          let tenantId: string;
          try {
            tenantId = getTenantId(); // fail closed before BEGIN
          } catch (err) {
            return Promise.reject(err);
          }
          return raw.$transaction(async (tx) => {
            await setTenant(tx, tenantId);
            return fn(tx as unknown as TransactionClient<This>);
          }, options);
        },
      },
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            // Throws before touching the database if there is no tenant.
            const tenantId = getTenantId();
            // Batch $transaction: Prisma sends both on one connection, in order.
            const [, result] = await raw.$transaction<unknown>([setTenant(raw, tenantId), query(args)]);
            return result;
          },
        },
      },
    });
  });
}
