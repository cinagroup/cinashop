import { describe, expect, it, vi } from 'vitest';
import { capturePurchasedLabelRuntimeAddon, capturePurchasedLabelRuntimeBinding, purchasedLabelNamedBinding,
  applyPurchasedLabelRuntimePlan } from '@/migrations/purchasedProductLabelRuntime';
import { capturePurchasedLabelRuntimeDeclaration, purchasedLabelRuntimeFromEnv } from '@/services/order/PurchasedProductLabelRuntimeDeclaration';
import { purchasedLabelExpectedAcl } from '@/migrations/purchasedProductLabelPermissions';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from '@/migrations/managerRuntimePrivilegePlan';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
const peers = () => ({ target: { database: 'label_db', maintenance: 'label_owner', app: 'label_app', admin: 'label_admin',
  local: [CUSTOMER_FINANCIAL_RUNTIME_ROLE, MANAGER_RUNTIME_ROLE, 'label_cashier'] }, financial: {}, manager: true as const,
  cashierSecondCard: { role: 'label_cashier', abandon: true as const }, purchasedProductLabels: { purchasedProductLabels: true as const } });
describe('purchased label explicit runtime declaration', () => {
  it('captures and freezes the complete target before asynchronous work', () => {
    const value = peers(), captured = capturePurchasedLabelRuntimeDeclaration(value);
    value.target.app = 'other_app'; value.target.local.splice(0); value.cashierSecondCard.role = 'other_cashier';
    expect(captured.target.app).toBe('label_app'); expect(captured.target.local).toHaveLength(3);
    expect(captured.cashierSecondCard?.role).toBe('label_cashier');
    expect(Object.isFrozen(captured.target)).toBe(true); expect(Object.isFrozen(captured.target.local)).toBe(true);
  });
  it('refuses incomplete or aliased five-profile authority', () => {
    const value = peers();
    for (const bad of [{ ...value, purchasedProductLabels: undefined }, { ...value, financial: undefined },
      { ...value, manager: undefined }, { ...value, cashierSecondCard: undefined },
      { ...value, target: { ...value.target, app: value.target.admin } },
      { ...value, target: { ...value.target, local: [MANAGER_RUNTIME_ROLE, 'label_cashier'] } }])
      expect(() => capturePurchasedLabelRuntimeDeclaration(bad)).toThrow();
  });
  it('does not invoke nested getters, toJSON, symbols, sparse arrays or inherited config', async () => {
    let calls = 0; const value = peers();
    for (const bad of [{ ...value, get target() { calls++; return value.target; } },
      { ...value, target: { ...value.target, get app() { calls++; return 'label_app'; } } },
      { ...value, toJSON() { calls++; return value; } }, { ...value, [Symbol('extra')]: true },
      { ...value, target: { ...value.target, local: Array(3) } }])
      expect(() => capturePurchasedLabelRuntimeDeclaration(bad)).toThrow();
    expect(() => purchasedLabelRuntimeFromEnv({ get PURCHASED_PRODUCT_LABEL_RUNTIME() { calls++; return value; } })).toThrow();
    expect(() => purchasedLabelRuntimeFromEnv(Object.create({ PURCHASED_PRODUCT_LABEL_RUNTIME: value }))).toThrow();
    const execute = vi.fn();
    await expect(purchasedLabelNamedBinding({ execute } as never, { ...value.target, get app() { calls++; return 'label_app'; } })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled(); expect(calls).toBe(0);
    expect(purchasedLabelRuntimeFromEnv({})).toBeUndefined();
    expect(purchasedLabelRuntimeFromEnv({ PURCHASED_PRODUCT_LABEL_RUNTIME: value })?.target.app).toBe('label_app');
  });
  it('keeps the runtime binding closed and versioned rather than accepting matching grant names', () => {
    const binding = { version: 'purchased-label-runtime-v1', database: 'label_db', databaseOid: '1', maintenance: 'label_owner',
      maintenanceOid: '2', app: 'label_app', appOid: '3', admin: 'label_admin', adminOid: '4' };
    expect(capturePurchasedLabelRuntimeBinding(binding)).toEqual(binding);
    for (const bad of [{ ...binding, appOid: '2' }, { ...binding, admin: 'label_app' }, { ...binding, databaseOid: '01' },
      { ...binding, appOid: '4294967296' }, { ...binding, extra: true }, { ...binding, version: 'old' }])
      expect(() => capturePurchasedLabelRuntimeBinding(bad)).toThrow();
    for (const bad of [{}, { purchasedProductLabels: false }, { purchasedProductLabels: true, extra: true }])
      expect(() => capturePurchasedLabelRuntimeAddon(bad as never)).toThrow();
  });
  it('adds only the fixed table and mutable-state columns to a fresh current profile', () => {
    for (const kind of ['app', 'admin'] as const) {
      const before = runtimeBusinessPrivilegePlan(kind), plan = runtimeBusinessPrivilegePlan(kind);
      applyPurchasedLabelRuntimePlan(plan, kind);
      expect(plan.functions).toEqual(before.functions); expect(plan.standaloneSequences).toEqual(before.standaloneSequences);
      expect(plan.tables.purchased_product_label_intent).toEqual(['SELECT', 'INSERT']);
      expect(plan.tables.purchased_product_label_result).toEqual(kind === 'app' ? ['SELECT', 'INSERT'] : ['SELECT']);
      expect(plan.updateColumns.purchased_product_label_state).not.toContain('task_id');
      expect(plan.updateColumns.purchased_product_label_state.includes('replay_count')).toBe(kind === 'admin');
      delete plan.tables.purchased_product_label_intent; delete plan.tables.purchased_product_label_state;
      delete plan.tables.purchased_product_label_result; delete plan.updateColumns.purchased_product_label_state;
      expect(plan).toEqual(before);
    }
    expect(purchasedLabelExpectedAcl()).toEqual([]);
    expect(new Set(purchasedLabelExpectedAcl({ app: 'label_app', admin: 'label_admin' })).size).toBe(40);
  });
});
