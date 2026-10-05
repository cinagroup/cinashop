import { describe, expect, it } from 'vitest';
import { is, getTableName } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as models from '../src/models/schema';
import { OFFLINE_TABLES, OFFLINE_DISPATCH_COLUMNS } from '../src/migrations/offlineOrderCatalog';
import { runtimeBusinessPrivilegePlan, runtimeBusinessPrivilegePlanAtStage, RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { RUNTIME_COMMISSION_OPERATION } from '../src/migrations/runRuntimeBusinessCommissioning';

describe('explicitly reviewed business privilege inventory', () => {
  it('enables only the separately authenticated fixed commissioning executor', () => {
    expect(RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY).toBe(true);
    expect(RUNTIME_COMMISSION_OPERATION).toBe('isolated-business-runtime-v5-agent-levels');
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
    expect(admin.functions).toEqual(['admin_lock_seckill_time_references_v1()']);
    expect(app.functions).toEqual(['checkout_lock_pricing_v1()','ooa_lock_pricing()']);
  });
  it('keeps app schedule edits guarded and gives Admin parent management no physical deletion', () => {
    const app=runtimeBusinessPrivilegePlan('app'),admin=runtimeBusinessPrivilegePlan('admin');
    expect(app.tables.store_seckill_time).toEqual(['SELECT']);
    expect(admin.tables.store_seckill_time).toEqual(['SELECT','INSERT','UPDATE','DELETE']);
    expect(app.updateColumns.store_activity).toEqual(['id']);
    expect(app.updateColumns.store_seckill_time).toEqual(['id']);
    expect(admin.updateColumns.store_activity).toBeUndefined();
    expect(app.tables.store_activity).toEqual(['SELECT']);
    expect(admin.tables.store_activity).toEqual(['SELECT','INSERT','UPDATE']);
    expect(app.functions).not.toContain('admin_lock_seckill_time_references_v1()');
  });
  it('pins separate old, schedule and parent stages rather than replaying a caller-selected plan',()=>{
    const oldApp=runtimeBusinessPrivilegePlanAtStage('app','legacy-seckill-schedule'),scheduleApp=runtimeBusinessPrivilegePlanAtStage('app','seckill-schedule');
    const oldAdmin=runtimeBusinessPrivilegePlanAtStage('admin','legacy-seckill-schedule'),scheduleAdmin=runtimeBusinessPrivilegePlanAtStage('admin','seckill-schedule');
    expect(oldApp.updateColumns.store_activity).toBeUndefined();expect(oldApp.updateColumns.store_seckill_time).toBeUndefined();
    expect(scheduleApp).toEqual(runtimeBusinessPrivilegePlanAtStage('app','pre-full-gifts'));
    expect(oldAdmin).toEqual(scheduleAdmin);expect(scheduleAdmin.tables.store_activity).toEqual(['SELECT']);
    const columns={...scheduleApp.updateColumns};delete columns.store_activity;delete columns.store_seckill_time;
    expect({...scheduleApp,updateColumns:columns}).toEqual(oldApp);
    const priorAdmin=runtimeBusinessPrivilegePlanAtStage('admin','pre-coupon-templates');
    expect({...priorAdmin,tables:{...priorAdmin.tables,store_activity:['SELECT']}}).toEqual(scheduleAdmin);
    const currentAdmin=runtimeBusinessPrivilegePlanAtStage('admin','pre-full-gifts');
    const tables={...currentAdmin.tables},updates={...currentAdmin.updateColumns};
    delete tables.store_coupon_template;delete tables.store_coupon_template_issue;delete updates.store_coupon_template;
    expect({...currentAdmin,tables,updateColumns:updates}).toEqual(priorAdmin);
  });
  it('keeps templates Admin-only and issued provenance immutable in every historical profile',()=>{
    for(const stage of ['legacy-seckill-schedule','seckill-schedule','pre-coupon-templates','pre-full-gifts','pre-sign-day','pre-agent-levels','current'] as const) {
      const app=runtimeBusinessPrivilegePlanAtStage('app',stage),admin=runtimeBusinessPrivilegePlanAtStage('admin',stage);
      for(const table of ['store_coupon_template','store_coupon_template_issue']) {
        expect(app.tables[table]).toBeUndefined();expect(app.updateColumns[table]).toBeUndefined();
        expect(admin.tables[table]).toEqual(['current','pre-agent-levels','pre-sign-day','pre-full-gifts'].includes(stage)?['SELECT','INSERT']:undefined);
      }
      expect(admin.updateColumns.store_coupon_template).toEqual(['current','pre-agent-levels','pre-sign-day','pre-full-gifts'].includes(stage)?['status','is_del']:undefined);
      expect(admin.updateColumns.store_coupon_template_issue).toBeUndefined();
    }
  });
  it('isolates promotion management and immutable gift receipts from every prior forward',()=>{
    for(const stage of ['legacy-seckill-schedule','seckill-schedule','pre-coupon-templates','pre-full-gifts'] as const) {
      for(const kind of ['app','admin'] as const) {
        const plan=runtimeBusinessPrivilegePlanAtStage(kind,stage);
        expect(plan.tables.store_promotions).toEqual(['SELECT','UPDATE']);
        expect(plan.tables.store_promotions_auxiliary).toEqual(['SELECT','UPDATE']);
        expect(plan.updateColumns.store_promotions_auxiliary).toBeUndefined();
        expect(plan.tables.store_order_promotion_gift_coupon_reward).toBeUndefined();
      }
    }
    const app=runtimeBusinessPrivilegePlan('app'),admin=runtimeBusinessPrivilegePlan('admin');
    expect(admin.tables.store_promotions).toEqual(['SELECT','INSERT','UPDATE']);
    expect(admin.tables.store_promotions_auxiliary).toEqual(['SELECT','INSERT','UPDATE','DELETE']);
    expect(app.tables.store_promotions).toEqual(['SELECT','UPDATE']);
    expect(app.tables.store_promotions_auxiliary).toEqual(['SELECT','UPDATE']);
    expect(app.updateColumns.store_promotions_auxiliary).toBeUndefined();
    expect(app.tables.store_order_promotion_gift_coupon_reward).toEqual(['SELECT','INSERT']);
    expect(admin.tables.store_order_promotion_gift_coupon_reward).toEqual(['SELECT']);
    for(const plan of [app,admin])expect(plan.updateColumns.store_order_promotion_gift_coupon_reward).toBeUndefined();
  });
  it('allows only the application identity to capture purchase evidence, never to rewrite it', () => {
    const app=runtimeBusinessPrivilegePlan('app'),admin=runtimeBusinessPrivilegePlan('admin');
    for(const table of ['store_order_purchase_origin','store_order_purchase_cancellation']) {
      expect(app.tables[table]).toEqual(['SELECT','INSERT']);
      expect(app.updateColumns[table]).toBeUndefined();
      expect(admin.tables[table]).toBeUndefined();
      expect(admin.updateColumns[table]).toBeUndefined();
    }
    expect([...app.functions,...admin.functions].some(name=>name.includes('purchase_'))).toBe(false);
  });
  it('freezes the complete gift-era profile and adds only two Admin group capabilities', () => {
    const previous=runtimeBusinessPrivilegePlanAtStage('admin','pre-sign-day'),current=runtimeBusinessPrivilegePlanAtStage('admin','pre-agent-levels');
    expect(previous.tables.system_group).toEqual(['SELECT']);
    expect(previous.tables.system_group_data).toEqual(['SELECT']);
    expect(previous.updateColumns.system_group).toBeUndefined();
    expect(previous.updateColumns.system_group_data).toBeUndefined();
    expect(current.tables.system_group).toEqual(['SELECT','INSERT']);
    expect(current.updateColumns.system_group).toEqual(['id']);
    expect(current.tables.system_group_data).toEqual(['SELECT','INSERT','DELETE']);
    expect(current.updateColumns.system_group_data).toEqual(['value','sort','status']);
    const tables={...current.tables,system_group:['SELECT'],system_group_data:['SELECT']},columns={...current.updateColumns};
    delete columns.system_group;delete columns.system_group_data;
    expect({...current,tables,updateColumns:columns}).toEqual(previous);
    expect(runtimeBusinessPrivilegePlan('app')).toEqual(runtimeBusinessPrivilegePlanAtStage('app','pre-sign-day'));
    for(const kind of ['app','admin'] as const) {
      const plan=runtimeBusinessPrivilegePlanAtStage(kind,'pre-sign-day');
      expect(plan.tables.store_order_promotion_gift_coupon_reward).toEqual(kind==='app'?['SELECT','INSERT']:['SELECT']);
      expect(plan.tables.system_log).toEqual(['SELECT','INSERT']);
    }
    for(const table of ['system_group','system_group_data']) {
      expect(runtimeBusinessPrivilegePlan('app').tables[table]).toEqual(['SELECT']);
      expect(runtimeBusinessPrivilegePlan('app').updateColumns[table]).toBeUndefined();
    }
  });
  it('freezes the entire sign-day profile and adds only Admin distributor INSERT and eight semantic UPDATE columns',()=>{
    const prior=runtimeBusinessPrivilegePlanAtStage('admin','pre-agent-levels'),current=runtimeBusinessPrivilegePlan('admin');
    expect(prior.tables.agent_level).toEqual(['SELECT']);expect(prior.updateColumns.agent_level).toEqual(['id']);
    expect(current.tables.agent_level).toEqual(['SELECT','INSERT']);
    expect(current.updateColumns.agent_level).toEqual(['id','name','image','color','one_brokerage','two_brokerage','grade','status','is_del']);
    expect({...current,tables:{...current.tables,agent_level:prior.tables.agent_level},
      updateColumns:{...current.updateColumns,agent_level:prior.updateColumns.agent_level}}).toEqual(prior);
    expect(runtimeBusinessPrivilegePlan('app')).toEqual(runtimeBusinessPrivilegePlanAtStage('app','pre-agent-levels'));
    expect(runtimeBusinessPrivilegePlan('app').updateColumns.agent_level).toEqual(['id']);
  });
});
