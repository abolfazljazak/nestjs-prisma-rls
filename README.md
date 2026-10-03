# rowguard

Postgres Row-Level Security (RLS) multi-tenancy for NestJS + Prisma.
You never write `where: { tenantId }`: Postgres enforces tenant isolation itself.

> Status: work in progress (v0.1 not released yet).

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

### 3. Database roles

RLS does **not** apply to superusers or to the table owner. Use two roles:

- a migration role that owns the tables;
- an app role (`NOSUPERUSER NOBYPASSRLS`, not the owner) with only
  `SELECT, INSERT, UPDATE, DELETE` grants, plus `USAGE` on the schema.

## Usage

```ts
import { rowguardExtension, runWithTenant } from 'rowguard';

const prisma = new PrismaClient({ adapter }).$extends(rowguardExtension());

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

- **Add rowguard as the last extension.** `tx` comes from the client below
  rowguard, so extensions added after it are missing on `tx` at runtime.
  `base.$extends(other).$extends(rowguardExtension())` is correct.
- **Use `tx`, not `prisma`, inside the callback.** A query on the outer
  `prisma` still gets the right tenant, but runs in its own transaction and
  is not rolled back with yours.
- **The batch form `prisma.$transaction([...])` is not supported** (a type error,
  and rejected at runtime). Use the interactive form.

## NestJS

```ts
@Module({
  imports: [
    RowguardModule.forRoot({
      tenantFrom: (req) => req.user?.tenantId, // set by your AuthGuard
      client: () => new PrismaClient({ adapter }),
    }),
  ],
})
export class AppModule {}
```

`forRootAsync({ imports, inject, useFactory })` is available too (e.g. with `ConfigService`).
rowguard adds its Prisma extension itself, always last. Add your own extensions
inside `client()`.

```ts
const extend = (c: PrismaClient) => c.$extends(rowguardExtension());
export type AppPrisma = ReturnType<typeof extend>;

@Injectable()
export class NotesService {
  constructor(@InjectRowguard() private readonly prisma: AppPrisma) {}
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

### Admin (bypass) client

For admin panels, cross-tenant reports and maintenance jobs, use a **separate
connection** as a role with `BYPASSRLS`. Postgres enforces the bypass by role,
so normal app code (even with SQL injection) cannot turn itself into it.

```sql
CREATE ROLE rowguard_admin LOGIN PASSWORD '...' NOSUPERUSER BYPASSRLS;
GRANT USAGE ON SCHEMA public TO rowguard_admin;
GRANT SELECT, UPDATE ON "Note" TO rowguard_admin; -- only what admin code needs
```

`BYPASSRLS` skips policies, not privileges: grant the least you need.

```ts
@Module({
  imports: [
    RowguardModule.forRoot({
      tenantFrom: (req) => req.user?.tenantId,
      client: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
    }),
    RowguardAdminModule.forRoot({
      client: () =>
        new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.ROWGUARD_ADMIN_DATABASE_URL }) }),
    }),
  ],
})
export class AppModule {}

@Injectable()
export class AdminReportService {
  constructor(@InjectRowguardAdmin() private readonly adminDb: PrismaClient) {}
}
```

- Keep the admin credentials in their own variable (`ROWGUARD_ADMIN_DATABASE_URL`),
  never in `DATABASE_URL`.
- **Never return admin client results directly to tenant users.** The admin
  client sees every tenant. The main remaining risk is a human using
  `@InjectRowguardAdmin()` in a normal endpoint; review every use of it.
- `RowguardAdminModule` is opt-in. Without it, `@InjectRowguardAdmin()` makes
  the app fail at boot, not at runtime.
- It works inside a tenant request (it is not tenant-scoped at all).
- Without Nest: create a second `PrismaClient` with `ROWGUARD_ADMIN_DATABASE_URL`
  and do not add `rowguardExtension()` to it.

## Known limitations (v0.1, in progress)

- Batch `$transaction([...])` is not supported; use the interactive form.
- `$queryRaw` / `$executeRaw` are not wrapped: outside a transaction they run
  without a tenant, so RLS returns no rows (fails closed). Run them on `tx`.
- Each query costs extra round trips (`BEGIN`, `set_config`, query, `COMMIT`).

## Development

Requires Node 24.9+ (NestJS 12 is ESM-only; Jest needs `--experimental-vm-modules`
on Node 24.9+ to `require()` it, which `npm test` passes for you).

```bash
npm run db:up      # Postgres in Docker on port 54329
npm test           # applies pending migrations, then runs Jest
npm run db:reset   # DESTRUCTIVE: drops the local test DB schema; run it yourself when a migration changes
```
