# nestjs-prisma-rls

> **v0.1 — early release.** The API may change before 1.0. Test tenant
> isolation in your own app before relying on it in production.

Postgres Row-Level Security (RLS) multi-tenancy for NestJS + Prisma.
You never write `where: { tenantId }`: Postgres enforces tenant isolation itself.

- **Isolation in the database.** A forgotten filter can't leak data: the RLS
  policy filters every query, and writes for another tenant are rejected.
- **Fails closed.** No tenant context means queries throw, never run unfiltered.
- **Checks your setup at startup.** Refuses to start if RLS would be silently off
  (superuser, `BYPASSRLS`, table owner, RLS disabled, an open policy).

## Supported versions

| | Versions (each tested in CI) |
|---|---|
| Node.js | 22.12+, 24 |
| NestJS | 11, 12 |
| Prisma | 7 (with `@prisma/adapter-pg`) |
| PostgreSQL | tested on 17 |

## Install

```bash
npm install nestjs-prisma-rls
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `@prisma/client`, `rxjs`.

## Quick start

1. Give every tenant table a `tenantId` column with a database default
   ([details](#1-tenantid-column-with-a-database-default)):

   ```prisma
   model Note {
     id       Int    @id @default(autoincrement())
     tenantId String @default(dbgenerated("(NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid")) @db.Uuid
     title    String

     @@index([tenantId])
   }
   ```

2. Enable RLS with a policy in the migration SQL
   ([details](#2-rls-policy-add-by-hand-to-the-migration-sql)):

   ```sql
   ALTER TABLE "Note" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "Note"
     USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
   ```

3. Relations between tenant tables use composite foreign keys on `(id, tenantId)`
   ([details](#3-relations-between-tenant-tables-composite-foreign-keys-required)).

4. Connect the app as a role that is **not** a superuser, not the table owner,
   and has no `BYPASSRLS` ([details](#4-database-roles)).

5. Register the module:

   ```ts
   @Module({
     imports: [
       PrismaRlsModule.forRoot({
         tenantFrom: (req) => req.user?.tenantId, // set by your AuthGuard
         client: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
       }),
     ],
   })
   export class AppModule {}
   ```

6. Inject and query, with no tenant filter:

   ```ts
   constructor(@InjectPrismaRls() private readonly prisma: AppPrisma) {}

   findAll() {
     return this.prisma.note.findMany(); // only the current tenant's notes
   }
   ```

For jobs, cron and scripts, wrap the code in `runWithTenant(tenantId, () => ...)`.

## Security model

What this package does:

- Sets `app.tenant_id` for the current transaction before every query, on the
  same connection, so the RLS policy filters by the current tenant.
- Throws instead of querying when there is no tenant (`MissingTenantError`),
  and refuses to switch tenants inside a tenant context (`TenantSwitchError`).
- Checks roles, RLS and policies at startup.

What it does **not** do, and you must:

- **Authenticate the tenant.** RLS protects the tenant it is given. `tenantFrom`
  must return a verified value (e.g. from a validated JWT), never a raw header.
- **Write correct policies.** The startup check is a text heuristic; test that
  tenant A cannot read, update, delete or insert tenant B's rows in your app.
- **Cover every table.** Each tenant table needs its own `tenantId` column and policy.
- **Use composite foreign keys between tenant tables.** Foreign key checks
  ignore RLS: with `Comment.noteId -> Note.id` alone, one tenant can reference
  another tenant's rows and probe which ids exist. Reference `(id, tenantId)`
  instead ([details](#3-relations-between-tenant-tables-composite-foreign-keys-required)).
- **Use the admin client carefully.** `@InjectPrismaRlsAdmin()` bypasses
  isolation; never return its results directly to tenant users.
- Raw SQL outside a transaction runs without a tenant (it returns no rows rather
  than leaking). Run raw SQL on `tx` inside `prisma.$transaction`.


## Schema setup

### 1. `tenantId` column with a database default

Postgres fills `tenantId` from the current transaction's tenant, so creates
(including nested creates, `createMany`, `upsert` and raw SQL) don't need it.

```prisma
model Note {
  id       Int    @id @default(autoincrement())
  tenantId String @default(dbgenerated("(NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid")) @db.Uuid
  tenant   Tenant @relation(fields: [tenantId], references: [id])
  title    String

  @@index([tenantId])
}
```

`prisma.note.create({ data: { title } })` type-checks: because the foreign key
has a default, Prisma makes the `tenant` relation optional in create inputs.

**Use exactly this expression.** Postgres stores defaults in a normalized form
(`'app.tenant_id'::text`, `''::text`, extra parentheses). Prisma compares your
`dbgenerated(...)` string with what Postgres reports, so the short form

```prisma
@default(dbgenerated("NULLIF(current_setting('app.tenant_id', true), '')::uuid"))
```

works but makes `prisma migrate dev` generate a new `ALTER COLUMN ... SET DEFAULT`
migration on every run. For a `text` column, use:

```prisma
tenantId String @default(dbgenerated("current_setting('app.tenant_id'::text, true)"))
```

### 2. RLS policy (add by hand to the migration SQL)

Prisma schema cannot express policies. Run `prisma migrate dev --create-only`,
then append to the generated `migration.sql`:

```sql
ALTER TABLE "Note" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Note"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

- Cast the setting, never the column, so the index on `"tenantId"` is used.
- `NULLIF`: on a reused pooled connection the setting is `''`, not `NULL`,
  and `''::uuid` throws. For `text` columns `NULLIF` is not needed.

### 3. Relations between tenant tables: composite foreign keys (required)

**Postgres checks foreign keys without applying RLS.** With a plain foreign key
`Comment.noteId -> Note.id`, tenant B can create a comment on tenant A's note,
and the error/no-error difference reveals which ids exist in other tenants.

Every relation between two tenant tables must include `tenantId` in the
foreign key, so the parent row must belong to the same tenant:

```prisma
model Note {
  id       Int       @id @default(autoincrement())
  tenantId String    @default(dbgenerated("...")) @db.Uuid
  comments Comment[]

  @@unique([id, tenantId]) // target of the composite foreign key
}

model Comment {
  id       Int    @id @default(autoincrement())
  tenantId String @default(dbgenerated("...")) @db.Uuid
  noteId   Int
  note     Note   @relation(fields: [noteId, tenantId], references: [id, tenantId])
}
```

Nested creates still work: Prisma copies the parent's `tenantId` into the child.

### 4. Database roles

RLS does **not** apply to superusers or to the table owner. Use two roles:

- a migration role that owns the tables;
- an app role (`NOSUPERUSER NOBYPASSRLS`, not the owner) with only
  `SELECT, INSERT, UPDATE, DELETE` grants, plus `USAGE` on the schema.

## Usage

```ts
import { prismaRlsExtension, runWithTenant } from 'nestjs-prisma-rls';

const prisma = new PrismaClient({ adapter }).$extends(prismaRlsExtension());

await runWithTenant(tenantId, () => prisma.note.findMany()); // only this tenant's rows
```

Without a tenant context every query throws `MissingTenantError`.

### Transactions

```ts
await runWithTenant(tenantId, () =>
  prisma.$transaction(async (tx) => {
    await tx.note.create({ data: { title: 'a' } });
    return tx.$queryRaw`SELECT count(*) FROM "Note"`; // raw SQL is tenant-scoped here too
  }),
);
```

The tenant is set once at the start of your transaction. Rules:

- **Add nestjs-prisma-rls as the last extension.** `tx` comes from the client below
  nestjs-prisma-rls, so extensions added after it are missing on `tx` at runtime.
  `base.$extends(other).$extends(prismaRlsExtension())` is correct.
- **Use `tx`, not `prisma`, inside the callback.** A query on the outer
  `prisma` still gets the right tenant, but runs in its own transaction and
  is not rolled back with yours.
- **The batch form `prisma.$transaction([...])` is not supported** (a type error,
  and rejected at runtime). Use the interactive form.

## NestJS

```ts
@Module({
  imports: [
    PrismaRlsModule.forRoot({
      tenantFrom: (req) => req.user?.tenantId, // set by your AuthGuard
      client: () => new PrismaClient({ adapter }),
    }),
  ],
})
export class AppModule {}
```

`forRootAsync({ imports, inject, useFactory })` is available too (e.g. with `ConfigService`).
nestjs-prisma-rls adds its Prisma extension itself, always last. Add your own extensions
inside `client()`.

```ts
const extend = (c: PrismaClient) => c.$extends(prismaRlsExtension());
export type AppPrisma = ReturnType<typeof extend>;

@Injectable()
export class NotesService {
  constructor(@InjectPrismaRls() private readonly prisma: AppPrisma) {}
  findAll() {
    return this.prisma.note.findMany(); // no tenantId anywhere
  }
}
```

- `tenantFrom` runs in a global interceptor, **after guards**, so `req.user` exists.
  It must return a verified value. Never read the tenant from a raw,
  client-controlled header: RLS protects the tenant it is given, nothing more.
- `null`, `undefined` or `''` = no tenant: public routes work, database queries throw.
- If `tenantFrom` throws, the request fails before the handler runs.
- Guards, middleware and exception filters run **outside** the tenant context.
  A guard that queries a tenant-scoped table must use `runWithTenant`.
- v0.1 supports HTTP only (not GraphQL or microservices).

### Startup check

At startup `PrismaRlsModule` inspects the database (read-only, catalog queries)
and by default **refuses to start** if tenant isolation is off:

| Problem | Level |
|---|---|
| App role is a superuser or has `BYPASSRLS` | error |
| App role owns a tenant table (or inherits from its owner) without `FORCE ROW LEVEL SECURITY` | error |
| A tenant table has RLS disabled | error |
| A permissive policy that applies to the app role doesn't reference `app.tenant_id` (e.g. `USING (true)`): permissive policies are OR-ed, so it opens the table | error |
| RLS enabled but no policy (every query denied) | warn |
| A restrictive policy doesn't reference `app.tenant_id` (AND-ed: harmless but odd) | warn |
| No tenant tables found (wrong `tenantColumn` or schema?) | warn |

```ts
PrismaRlsModule.forRoot({
  tenantFrom: (req) => req.user?.tenantId,
  client: () => new PrismaClient({ adapter }),
  startupCheck: 'error',      // default; 'warn' only logs, 'off' skips
  tenantColumn: 'tenantId',   // default
  excludeTables: ['User'],    // has tenantId but intentionally no RLS
})
```

- **The policy check is a text heuristic, not a proof.** It only checks that
  `app.tenant_id` is mentioned. A policy like
  `USING (current_setting('app.tenant_id', true) IS NOT NULL)` passes the check
  but lets every tenant see every row. Write your own isolation tests
  (tenant A cannot read, update, delete or insert tenant B's rows).
- A **tenant table** is any table with the `tenantColumn`. **Every tenant table
  must have its own `tenantId` column**, even child tables (e.g. `Comment`
  linked through `noteId`): a table without it is invisible to the check *and*
  has no isolation.
- `excludeTables` is for tables like `User` that guards read before the tenant
  is known. Excluded tables are skipped but logged once at startup.
- `PrismaRlsAdminModule` logs a warning if the admin role lacks `BYPASSRLS`
  (or is a superuser).
- Without Nest: `checkPrismaRlsSetup(prisma)` and `checkPrismaRlsAdminSetup(adminPrisma)`
  return the issues, e.g. for a CI step.

### Admin (bypass) client

For admin panels, cross-tenant reports and maintenance jobs, use a **separate
connection** as a role with `BYPASSRLS`. Postgres enforces the bypass by role,
so normal app code (even with SQL injection) cannot turn itself into it.

```sql
CREATE ROLE rls_admin LOGIN PASSWORD '...' NOSUPERUSER BYPASSRLS;
GRANT USAGE ON SCHEMA public TO rls_admin;
GRANT SELECT, UPDATE ON "Note" TO rls_admin; -- only what admin code needs
```

`BYPASSRLS` skips policies, not privileges: grant the least you need.

```ts
@Module({
  imports: [
    PrismaRlsModule.forRoot({
      tenantFrom: (req) => req.user?.tenantId,
      client: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
    }),
    PrismaRlsAdminModule.forRoot({
      client: () =>
        new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.PRISMA_RLS_ADMIN_DATABASE_URL }) }),
    }),
  ],
})
export class AppModule {}

@Injectable()
export class AdminReportService {
  constructor(@InjectPrismaRlsAdmin() private readonly adminDb: PrismaClient) {}
}
```

- Keep the admin credentials in their own variable (`PRISMA_RLS_ADMIN_DATABASE_URL`),
  never in `DATABASE_URL`.
- **Never return admin client results directly to tenant users.** The admin
  client sees every tenant. The main remaining risk is a human using
  `@InjectPrismaRlsAdmin()` in a normal endpoint; review every use of it.
- `PrismaRlsAdminModule` is opt-in. Without it, `@InjectPrismaRlsAdmin()` makes
  the app fail at boot, not at runtime.
- It works inside a tenant request (it is not tenant-scoped at all).
- Without Nest: create a second `PrismaClient` with `PRISMA_RLS_ADMIN_DATABASE_URL`
  and do not add `prismaRlsExtension()` to it.

## Performance

Measured with `npm run bench` (full results: [bench/results.md](bench/results.md)).
Localhost Docker on a laptop (i7-1185G7), Postgres 17, Node 24, 100k rows.
**On localhost round trips are cheap; against a real database server the
overhead below grows with your network latency.**

Every model query outside your own `$transaction` becomes 4 statements instead
of 1 (counted at the driver): `BEGIN`, `set_config`, the query, `COMMIT`.

| Scenario | p50 per query | vs. plain Prisma |
|---|---|---|
| Plain Prisma read (no RLS) | 0.98 ms | baseline |
| RLS policy only (tenant already set) | 0.99 ms | +0.00 ms (within noise) |
| nestjs-prisma-rls read, one query per call | 3.76 ms | **+2.78 ms, ~3.8x** |
| nestjs-prisma-rls read, 10 queries in one `$transaction` | 1.46 ms | +0.48 ms (within noise) |
| Plain Prisma create | 2.96 ms | baseline |
| nestjs-prisma-rls create, one per call | 5.29 ms | **+2.34 ms** |
| nestjs-prisma-rls create, 10 in one `$transaction` | 1.99 ms | faster than baseline* |

* Not a nestjs-prisma-rls speedup: 10 inserts share one `COMMIT` (one disk flush) instead of 10.

Throughput (50 concurrent workers, pool of 10): plain reads **7700/s**, nestjs-prisma-rls
one-query-per-call **542/s** (about 14x lower), nestjs-prisma-rls in `$transaction`
batches of 10 **2227/s**. The drop is larger than the latency ratio. A Prisma
batch transaction of two statements *without* nestjs-prisma-rls reached a similar rate
in a separate run, so the cost comes from the transaction-per-query mechanism
nestjs-prisma-rls relies on; the exact reason it is worse than linear was not determined.

What this means:

- The RLS policy itself is effectively free when the tenant column is indexed
  (the plan uses `Bitmap Index Scan on "Note_tenantId_idx"`). Casting the
  column instead of the setting turns it into a sequential scan.
- The cost is round trips and connection hold time. Rough rule:
  **extra latency per query ≈ 3 × your network round-trip time.**
- To reduce it, group related queries in one `prisma.$transaction(async (tx) => ...)`:
  one `set_config` and one `BEGIN`/`COMMIT` for all of them.
- Size your connection pool for connections being held ~4x longer.
- `set_config(..., true)` is transaction-scoped: the tenant is gone after
  `COMMIT` (tested). This makes nestjs-prisma-rls compatible with **PgBouncer in
  transaction mode**, where consecutive transactions may run on different
  server connections.

## Known limitations (v0.1)

- Batch `$transaction([...])` is not supported; use the interactive form.
- `$queryRaw` / `$executeRaw` are not wrapped: outside a transaction they run
  without a tenant, so RLS returns no rows (fails closed). Run them on `tx`.
- Each query outside a `$transaction` costs 3 extra round trips; see Performance.

## Development

Requires Node 24.9+ (NestJS 12 is ESM-only; Jest needs `--experimental-vm-modules`
on Node 24.9+ to `require()` it, which `npm test` passes for you).

```bash
npm run db:up      # Postgres in Docker on port 54329
npm test           # applies pending migrations, then runs Jest
npm run db:reset   # DESTRUCTIVE: drops the local test DB schema; run it yourself when a migration changes
```
