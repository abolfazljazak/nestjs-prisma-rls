# Changelog

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
