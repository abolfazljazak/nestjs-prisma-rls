import { AsyncLocalStorage } from 'async_hooks';

export interface TenantStore {
  tenantId: string;
}

// One storage instance for the whole process. Each async call chain started
// with `tenantStorage.run()` sees its own store, so concurrent requests never mix.
export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export class MissingTenantError extends Error {
  constructor() {
    super(
      'rowguard: no tenant in context. Wrap the code in runWithTenant() ' +
        'or make sure the request passed through RowguardModule.',
    );
    this.name = 'MissingTenantError';
  }
}

export class TenantSwitchError extends Error {
  constructor(current: string, requested: string) {
    super(
      `rowguard: cannot switch tenant inside an existing tenant context ` +
        `("${current}" -> "${requested}"). Run tenants sequentially, ` +
        `or use the admin bypass API for cross-tenant work.`,
    );
    this.name = 'TenantSwitchError';
  }
}

/**
 * Runs `fn` with `tenantId` as the current tenant.
 * Nested calls: same tenant reuses the context, a different tenant throws.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  // Runtime check too: callers from plain JS (or `any`) bypass the type.
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new TypeError('rowguard: tenantId must be a non-empty string');
  }

  const current = tenantStorage.getStore();
  if (current) {
    if (current.tenantId !== tenantId) {
      throw new TenantSwitchError(current.tenantId, tenantId);
    }
    return fn(); // same tenant: keep the existing context
  }

  return tenantStorage.run({ tenantId }, fn);
}

/** Current tenant id, or throws: there is no "unfiltered" fallback. */
export function getTenantId(): string {
  const store = tenantStorage.getStore();
  if (!store) throw new MissingTenantError();
  return store.tenantId;
}
