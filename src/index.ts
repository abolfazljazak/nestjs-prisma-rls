// Public API of rowguard.
export { runWithTenant, getTenantId, MissingTenantError, TenantSwitchError } from './context';
export { rowguardExtension } from './prisma-extension';
export type { TransactionClient, TransactionOptions } from './prisma-extension';
export { RowguardModule, RowguardInterceptor, InjectRowguard, ROWGUARD_CLIENT } from './rowguard.module';
export type { RowguardModuleOptions } from './rowguard.module';
