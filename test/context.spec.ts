import { setTimeout as sleep } from 'timers/promises';
import {
  getTenantId,
  MissingTenantError,
  runWithTenant,
  TenantSwitchError,
} from '../src/context';

it('throws outside any tenant context (fail closed)', () => {
  expect(() => getTenantId()).toThrow(MissingTenantError);
});

it('keeps the tenant across awaits', async () => {
  const seen = await runWithTenant('A', async () => {
    await sleep(5);
    return getTenantId();
  });
  expect(seen).toBe('A');
  expect(() => getTenantId()).toThrow(MissingTenantError); // context ended
});

it('does not mix concurrent tenants', async () => {
  const work = (id: string, ms: number) =>
    runWithTenant(id, async () => {
      await sleep(ms); // B finishes first, so contexts interleave
      return getTenantId();
    });
  expect(await Promise.all([work('A', 20), work('B', 5)])).toEqual(['A', 'B']);
});

it('sequential calls with different tenants are allowed', async () => {
  const seen: string[] = [];
  for (const id of ['A', 'B', 'C']) {
    await runWithTenant(id, async () => {
      seen.push(getTenantId());
    });
  }
  expect(seen).toEqual(['A', 'B', 'C']);
});

it('nested call with the same tenant reuses the context', async () => {
  const seen = await runWithTenant('A', () => runWithTenant('A', async () => getTenantId()));
  expect(seen).toBe('A');
});

it('nested call with a different tenant throws', async () => {
  await expect(
    runWithTenant('A', async () => runWithTenant('B', async () => 'leak')),
  ).rejects.toThrow(TenantSwitchError);
});

it.each(['', '   ', undefined, 42])('rejects invalid tenantId %p', (bad) => {
  expect(() => runWithTenant(bad as any, () => 0)).toThrow(TypeError);
});
