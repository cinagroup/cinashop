import { describe, expect, it } from 'vitest';
import { offlineRuntimeGrantPlan, OFFLINE_RUNTIME_READ_TABLES, OFFLINE_RUNTIME_INSERT_TABLES,
  OFFLINE_RUNTIME_UPDATE_TABLES, OFFLINE_RUNTIME_UPDATE_COLUMNS, OFFLINE_RUNTIME_SEQUENCES } from '../src/migrations/offlineOrderRuntimeContract';
import { OFFLINE_TABLES, OFFLINE_DISPATCH_COLUMNS } from '../src/migrations/offlineOrderCatalog';

describe('offline runtime grant plan is pure and explicitly bounded', () => {
  it.each(['', 'app\n', ' app', 'app ', 'app-role', 'a'.repeat(64), 'app";DROP ROLE app;--', 'PUBLIC; GRANT ALL', '角色', '1app'])('rejects invalid role %j', role => {
    expect(() => offlineRuntimeGrantPlan(role)).toThrow('Invalid explicit runtime role');
  });
  it.each(['app_runtime', '_runtime2', 'a'.repeat(63)])('quotes the explicit role %s without broad authority', role => {
    const plan = offlineRuntimeGrantPlan(role);
    expect(plan.trim().split('\n')).toHaveLength(10);
    expect(plan.trim().split('\n').every(line => line.startsWith('GRANT ') && line.endsWith(' TO "'+role+'";'))).toBe(true);
    expect(plan).not.toMatch(/\b(?:ALL|DELETE|TRUNCATE|TRIGGER|CREATE|ALTER|DROP|REVOKE|CONNECT|TEMP|WITH GRANT OPTION)\b/);
    expect(plan).toContain('GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing()');
    expect(plan).not.toMatch(/GRANT (?:UPDATE|SELECT) ON SEQUENCE/);
  });
  it('names each scoped object once and permits only dispatch column updates on the immutable ledgers', () => {
    for (const tables of [OFFLINE_RUNTIME_READ_TABLES, OFFLINE_RUNTIME_INSERT_TABLES, OFFLINE_RUNTIME_UPDATE_TABLES])
      expect(new Set(tables).size).toBe(tables.length);
    expect(OFFLINE_RUNTIME_READ_TABLES).toHaveLength(21);
    expect(OFFLINE_RUNTIME_INSERT_TABLES).toHaveLength(15);
    expect(OFFLINE_RUNTIME_SEQUENCES).toHaveLength(7);
    expect(OFFLINE_RUNTIME_UPDATE_TABLES.some(table => OFFLINE_TABLES.some(ledger => table === String(ledger)))).toBe(false);
    expect(Object.keys(OFFLINE_RUNTIME_UPDATE_COLUMNS).filter(table => OFFLINE_TABLES.some(ledger => ledger === table))).toEqual(['offline_order_payment_dispatch']);
    expect(OFFLINE_RUNTIME_UPDATE_COLUMNS.offline_order_payment_dispatch).toEqual(OFFLINE_DISPATCH_COLUMNS);
  });
});
