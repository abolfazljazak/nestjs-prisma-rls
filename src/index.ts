// Public API of nestjs-prisma-rls.
export { runWithTenant, getTenantId, MissingTenantError, TenantSwitchError } from './context';
export { prismaRlsExtension } from './prisma-extension';
export type { TransactionClient, TransactionOptions } from './prisma-extension';
export { PrismaRlsModule, PrismaRlsInterceptor, InjectPrismaRls, PRISMA_RLS_CLIENT } from './prisma-rls.module';
export type { PrismaRlsModuleOptions } from './prisma-rls.module';
export { PrismaRlsAdminModule, InjectPrismaRlsAdmin, PRISMA_RLS_ADMIN_CLIENT } from './admin.module';
export type { PrismaRlsAdminModuleOptions } from './admin.module';
export { checkPrismaRlsSetup, checkPrismaRlsAdminSetup } from './startup-check';
export type { SetupIssue, SetupCheckOptions, SetupCheckResult, IssueLevel } from './startup-check';
