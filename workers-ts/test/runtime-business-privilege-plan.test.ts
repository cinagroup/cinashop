import { describe, expect, it } from 'vitest';
import { is, getTableName } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as models from '../src/models/schema';
import { OFFLINE_TABLES, OFFLINE_DISPATCH_COLUMNS } from '../src/migrations/offlineOrderCatalog';
import { runtimeBusinessPrivilegePlan, RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY } from '../src/migrations/runtimeBusinessPrivilegePlan';

describe('explicitly reviewed business privilege inventory', () => {
  it('enables only the separately authenticated fixed commissioning executor', () => {
    expect(RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY).toBe(true);
  });
  it.each(['app','admin'] as const)('%s references only actual named tables and columns', kind => {
    const tables=new Map<string,readonly string[]>();
    for(const table of Object.values(models))if(is(table,PgTable))tables.set(getTableName(table),getTableConfig(table).columns.map(c=>c.name));
    const plan=runtimeBusinessPrivilegePlan(kind);
    for(const [table,privileges] of Object.entries(plan.tables)) {
      expect(tables.has(table),table).toBe(true);
      expect(privileges.every(p=>['SELECT','INSERT','UPDATE','DELETE'].includes(p))).toBe(true);
    }
    for(const [table,columns] of Object.entries(plan.updateColumns)) {
      expect(plan.tables[table],table).toContain('SELECT');
      expect(plan.tables[table],table).not.toContain('UPDATE');
      for(const column of columns)expect(tables.get(table),table+'.'+column).toContain(column);
    }
  });
  it.each(['app','admin'] as const)('%s preserves ledger, parent-key, sequence-reset and schema boundaries', kind => {
    const plan=runtimeBusinessPrivilegePlan(kind);
    for(const table of [...OFFLINE_TABLES,'store_order_invoice_allocation','store_order_refund_split','store_order_fulfillment_branch'])
      expect(plan.tables[table]).toEqual(['SELECT','INSERT']);
    expect(plan.tables.store_order_invoice_evidence).toEqual(['SELECT']);
    expect(plan.updateColumns.offline_order_payment_dispatch).toEqual(OFFLINE_DISPATCH_COLUMNS);
    expect(plan.tables.shipping_templates).not.toContain('DELETE');
    for(const table of ['work_client_current','work_callback_event']) {
      expect(plan.tables[table]).not.toContain('UPDATE');expect(plan.tables[table]).not.toContain('DELETE');
      for(const key of ['id','corp_id','event_key','subject_key_hash','event_time','sequence_rank'])
        expect(plan.updateColumns[table]).not.toContain(key);
    }
    expect(plan.tables.data_migration_run).toBeUndefined();expect(plan.tables.data_migration_checkpoint).toBeUndefined();
  });
  it('does not grant ordinary callers configuration writes or admin operation receipt access', () => {
    const app=runtimeBusinessPrivilegePlan('app'),admin=runtimeBusinessPrivilegePlan('admin');
    for(const table of ['system_config','member_right']) {
      expect(app.tables[table]).toEqual(['SELECT']);expect(app.updateColumns[table]).toBeUndefined();
      expect(admin.tables[table]).toContain('UPDATE');
    }
    for(const table of ['admin_refund_operation','admin_refund_creation','admin_user_write_replay']) {
      expect(app.tables[table]).toBeUndefined();expect(admin.tables[table]).toEqual(['SELECT','INSERT']);
    }
    expect(admin.functions).toEqual([]);
    expect(app.functions).toEqual(['checkout_lock_pricing_v1()','ooa_lock_pricing()']);
  });
});
