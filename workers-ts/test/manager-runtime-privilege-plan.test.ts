import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/models/schema';
import { managerRuntimeGrantSql, managerRuntimePrivilegePlan, MANAGER_RUNTIME_ROLE } from '../src/migrations/managerRuntimePrivilegePlan';

describe('dedicated manager profile', () => {
  it('matches real table/column/serial definitions, including conditional business branches', () => {
    const tables = new Map(Object.values(schema).filter(value => is(value, PgTable)).map(table => {
      const definition = getTableConfig(table); return [definition.name, definition] as const;
    }));
    const plan = managerRuntimePrivilegePlan();
    for (const name of Object.keys(plan.tables)) {
      if (name === 'manager_order_operation_request') continue; // published external append-only protocol
      expect(tables.has(name), name).toBe(true);
    }
    for (const [name, columns] of Object.entries(plan.updateColumns))
      for (const column of columns) expect(tables.get(name)?.columns.some(value => value.name === column), `${name}.${column}`).toBe(true);
    for (const sequence of plan.standaloneSequences) {
      const name = sequence.replace(/_id_seq$/, '');
      expect(plan.tables[name]?.includes('INSERT'), sequence).toBe(true);
      expect(tables.get(name)?.columns.some(value => value.name === 'id' && ['serial', 'bigserial'].includes(value.getSQLType())), sequence).toBe(true);
    }
  });
  it('denies account-password, staff, carrier, pricing and platform authority writes', () => {
    const plan = managerRuntimePrivilegePlan();
    for (const name of ['system_store_staff', 'express_company', 'member_right', 'system_config']) {
      expect(plan.tables[name]).toEqual(['SELECT']); expect(plan.updateColumns[name]).toBeUndefined();
    }
    for (const name of ['system_admin', 'system_role', 'system_menus', 'admin_refund_operation_request', 'customer_financial_operation_request'])
      expect(plan.tables[name]).toBeUndefined();
    expect(plan.tables.user).toEqual(['SELECT']);
    for (const column of ['pwd', 'status', 'is_del', 'delete_time', 'is_promoter']) expect(plan.updateColumns.user).not.toContain(column);
  });
  it('keeps original operation and materialization evidence append-only with exact lock capabilities', () => {
    const plan = managerRuntimePrivilegePlan();
    for (const name of ['manager_order_operation_request', 'store_order_refund_split', 'store_order_fulfillment_branch', 'store_order_invoice_allocation']) {
      expect(plan.tables[name]).toEqual(['SELECT', 'INSERT']); expect(plan.updateColumns[name]).toBeUndefined();
    }
    expect(plan.tables.store_order_invoice_evidence).toEqual(['SELECT']);
    expect(plan.tables.store_order_promotions).toEqual(['SELECT','INSERT']);
    expect(plan.tables.order_waybill_job).toEqual(['SELECT']);expect(plan.updateColumns.order_waybill_job).toBeUndefined();
    expect(plan.tables.store_order_invoice).toEqual(['SELECT','INSERT','UPDATE','DELETE']);
    expect(plan.functions).toEqual(['checkout_lock_pricing_v1()', 'manager_lock_scope_v1(integer,integer)', 'manager_lock_carrier_v1(text)',
      'manager_lock_waybill_v1()','manager_lock_delivery_agents_v1(integer,integer)','manager_delete_order_promotions_v1(integer,jsonb)']);
  });
  it('compiles only the fixed role and never grants defaults, delegation or all objects', () => {
    const statements = managerRuntimeGrantSql();
    expect(statements.every(statement => statement.endsWith(`TO "${MANAGER_RUNTIME_ROLE}";`))).toBe(true);
    expect(statements.join('\n')).not.toMatch(/GRANT ALL|ALL TABLES|ALL SEQUENCES|WITH GRANT OPTION|DEFAULT PRIVILEGES|system_admin|system_role|ooa_lock_pricing/);
    const first = managerRuntimePrivilegePlan(); first.updateColumns.user = ['pwd'];
    expect(managerRuntimePrivilegePlan().updateColumns.user).not.toContain('pwd');
  });
  it('has only the explicit gift-receipt read difference between complete current and legacy profiles',()=>{
    const current=managerRuntimePrivilegePlan(),legacy=managerRuntimePrivilegePlan('legacy-without-promotion-gift-receipt');
    const expected={...current,tables:{...current.tables}};delete expected.tables.store_order_promotion_gift_coupon_reward;
    expect(legacy).toEqual(expected);
    expect(managerRuntimeGrantSql('legacy-without-promotion-gift-receipt').join('\n')).not.toContain('store_order_promotion_gift_coupon_reward');
    expect(()=>managerRuntimePrivilegePlan('unreviewed' as never)).toThrow('Unknown fixed manager profile');
  });
});
