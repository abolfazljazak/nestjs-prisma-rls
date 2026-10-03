# Changelog

## Unreleased

- **Security (docs):** foreign keys between tenant tables must be composite,
  `(childFk, tenantId) -> parent(id, tenantId)`. Postgres checks foreign keys
  without RLS, so a plain FK let one tenant reference another tenant's rows and
  detect which ids exist. If you use 0.1.0, check your schema.
- Startup check: an app role that owns a tenant table now gets a warning even
  with `FORCE ROW LEVEL SECURITY` (the owner can disable RLS or drop policies).
- Peer dependency ranges narrowed to what CI tests: `@prisma/client` `^7.10.0`
  (was `^7.0.0`), `rxjs` `^7` (was `>=7`).

## 0.1.0 (2026-10-04)

First early release.

- `PrismaRlsModule.forRoot` / `forRootAsync`: tenant-aware Prisma client for
  NestJS, with a global interceptor that reads the tenant after guards (HTTP only).
- `prismaRlsExtension()`: Prisma Client extension that sets `app.tenant_id`
  for each query's transaction; interactive `$transaction` support (batch form
  rejected).
- `runWithTenant()` / `getTenantId()` for code outside requests; fails closed
  without a tenant and rejects switching tenants inside a context.
- `PrismaRlsAdminModule`: opt-in admin client on a separate `BYPASSRLS` role.
- Startup check of roles, RLS and policies (`startupCheck: 'error'` by default),
  also available as `checkPrismaRlsSetup()` / `checkPrismaRlsAdminSetup()`.
- Supports Node.js 22.12+, NestJS 11 and 12, Prisma 7.
