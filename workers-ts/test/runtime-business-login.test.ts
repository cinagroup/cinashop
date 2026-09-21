import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { createContainerFromDb } from '../src/lib/di';
import { installRuntimeLockOnlyBoundaryInTransaction, inspectRuntimeLockOnlyBoundary } from '../src/migrations/runtimeLockOnlyBoundary';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { payOfflineOrderBalance } from '../src/services/order/OfflineOrderBalanceService';
import { DatabaseCacheService } from '../src/services/system/DatabaseCacheService';
import { OutCouponService } from '../src/services/out/OutCouponService';
import { auditCheckoutRuntimePermissions } from '../src/migrations/auditPaidOrderRuntimePermissions';
import { auditOfflineOrderRuntimePermissions } from '../src/migrations/auditOfflineOrderRuntimePermissions';
import { auditWorkParentIdentityPermissions } from '../src/migrations/auditWorkParentIdentityPermissions';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { installRuntimeBusinessInTransaction, runRuntimeBusinessCommissioning, runRuntimeShippingPrerequisite } from '../src/migrations/runRuntimeBusinessCommissioning';
import { exerciseRuntimeBusiness } from './integration/RuntimeBusinessProbe';

describe('business profiles with two independent real LOGINs (isolated native acceptance)',()=>{
  let f:Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f=await refundRuntimeFixture();
    await f.exec(`INSERT INTO system_admin(id,account,pwd,admin_type,level) VALUES(1,'local-admin','local-hash',1,0);
      UPDATE "user" SET now_money=100 WHERE uid=11;
      INSERT INTO system_config(menu_name,value) VALUES('balance_func_status','1'),('yue_pay_status','1'),('order_give_integral','0');`);
  },60_000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30_000);
  type Role=Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (r:infer R)=>unknown?R:never;
  it('reports empty independent LOGINs and an absent shipping receipt as unready without throwing',async()=>{
    await f.exec('DROP TABLE public.shipping_template_create_replay');
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const names={app:app.role,admin:admin.role,maintenance:'finance_test',database:'finance_test',pricingOwner:f.pricingOwner};
      for(const [kind,peer] of [['app',app],['admin',admin]] as const){
        const result=await auditRuntimeBusinessPrivileges(peer.db,kind,names);
        expect(result.ready).toBe(false);
        expect(result.failures).toContain('missing:shipping_template_create_replay');
        expect(result.failures).toContain('staff_boundary');
        expect(result.failures).toContain('lock_only_boundary');
      }
      const [identity]=await f.exec('SELECT current_database() AS database');
      const target={...names,database:String(identity.database)};
      const installed=await runRuntimeShippingPrerequisite(f.db,target);
      expect(installed).toMatchObject({applied:true,before:{present:false},after:{complete:true},businessGrantsApplied:false});
      expect(await runRuntimeShippingPrerequisite(f.db,target)).toMatchObject({applied:false,after:installed.after});
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names)).failures).toContain('table:shipping_template_create_replay:INSERT');
    }));
  },60_000);
  async function profiles(run:(app:Role,admin:Role)=>Promise<void>){
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [identity]=await f.exec('SELECT current_database() AS database');
      const target={database:String(identity.database),maintenance:'finance_test',app:app.role,admin:admin.role,pricingOwner:f.pricingOwner};
      await expect(runRuntimeBusinessCommissioning(f.db,{...target,database:'wrong_target'})).rejects.toThrow('target requires review');
      expect(await runRuntimeBusinessCommissioning(f.db,target)).toMatchObject({grantsApplied:true,businessValidationRequired:true});
      await expect(f.db.transaction(tx=>installRuntimeBusinessInTransaction(tx,target))).rejects.toThrow('preflight refused');
      const names={app:app.role,admin:admin.role,maintenance:'finance_test'};
      expect(await auditRuntimeBusinessPrivileges(app.db,'app',names)).toMatchObject({ready:true,failures:[]});
      expect(await auditRuntimeBusinessPrivileges(admin.db,'admin',names)).toMatchObject({ready:true,failures:[]});
      await run(app,admin);
    }));
  }
  it('rolls back both boundaries and every grant on late column drift',async()=>{
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [identity]=await f.exec('SELECT current_database() AS database');
      const target={database:String(identity.database),maintenance:'finance_test',app:app.role,admin:admin.role,pricingOwner:f.pricingOwner};
      await f.exec('ALTER TABLE public.system_menus RENAME COLUMN id TO fixture_renamed_id');
      await expect(f.db.transaction(tx=>installRuntimeBusinessInTransaction(tx,target))).rejects.toMatchObject({cause:{code:'42703'}});
      const [remaining]=await f.exec(`SELECT
        has_table_privilege('${app.role}','public.store_order','SELECT,INSERT,UPDATE,DELETE') AS app_grants,
        has_table_privilege('${admin.role}','public.system_config','SELECT,INSERT,UPDATE,DELETE') AS admin_grants,
        to_regprocedure('public.cinashop_runtime_admin_boundary_v1()') IS NULL AS no_staff_boundary,
        to_regprocedure('public.cinashop_runtime_lock_only_v1()') IS NULL AS no_lock_boundary`);
      expect(remaining).toEqual({app_grants:false,admin_grants:false,no_staff_boundary:true,no_lock_boundary:true});
    }));
  },60_000);
  it('executes checkout, offline wallet/replay and cache upsert under the exact app profile',async()=>{
    await profiles(async(app,admin)=>{
      expect(await exerciseRuntimeBusiness(app.db,'app',app.role)).toMatchObject({passed:true,rolledBack:true,wallet:'passed',remainingSyntheticRows:0});
      expect(await exerciseRuntimeBusiness(admin.db,'admin',admin.role)).toMatchObject({passed:true,rolledBack:true,remainingSyntheticRows:0});
      expect(await auditCheckoutRuntimePermissions(app.db,'public','shared-shop')).toMatchObject({ready:true,failures:[]});
      expect(await auditOfflineOrderRuntimePermissions(app.db,'shared-shop')).toMatchObject({ready:true,failures:[]});
      expect(await auditWorkParentIdentityPermissions(app.db,'public','shared-shop')).toMatchObject({ready:true,failures:[]});
      const container=createContainerFromDb(app.db);
      const input={uid:11,key:'business-profile',cartIds:[1,2],addressId:11,userIp:'127.0.0.1',useIntegral:true};
      const create=()=>StoreOrderCreateService.createWithRuntime(container,{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'business_profile_order'},input);
      expect(await create()).toEqual({orderId:'business_profile_order',key:'business-profile'});
      expect(await create()).toEqual({orderId:'business_profile_order',key:'business-profile'});
      const admission=await admitOfflineOrder(container,{uid:11,requestKey:crypto.randomUUID(),orderNo:'xx'+'b'.repeat(30),
        money:'10.00',expectedPayPrice:'10.00',from:'h5'});
      expect(await payOfflineOrderBalance(container,{uid:11,orderNo:admission.order_id})).toMatchObject({paid:true,balance_after:'90.00',replayed:false});
      expect(await payOfflineOrderBalance(container,{uid:11,orderNo:admission.order_id})).toMatchObject({paid:true,replayed:true});
      const cache=new DatabaseCacheService(container);
      await cache.set('profile-fixture',{version:1});await cache.set('profile-fixture',{version:2});
      expect(await cache.get('profile-fixture',null)).toEqual({version:2});
      await admin.exec("UPDATE system_config SET value=value WHERE menu_name='balance_func_status'");
      await expect(app.exec("UPDATE system_config SET value='0'")).rejects.toMatchObject({code:'42501'});
      await expect(admin.exec('SELECT public.checkout_lock_pricing_v1()')).rejects.toMatchObject({code:'42501'});
    });
  },60_000);
  it('allows Out coupon create/retire with readonly configuration and no catalog-edit escape',async()=>{
    await profiles(async(app,admin)=>{
      const coupons=new OutCouponService(createContainerFromDb(app.db));
      const created=await coupons.create({id:7},{coupon_title:'Local profile coupon',coupon_price:'1.00',use_min_price:'0.00',
        coupon_time:7,receive_type:1,is_permanent:1,type:0,coupon_type:1,status:0},crypto.randomUUID());
      expect(created.id).toBeGreaterThan(0);
      expect(await coupons.delete({id:7},created.id,crypto.randomUUID())).toMatchObject({id:created.id,status:-1});
      await app.exec('BEGIN; SELECT id FROM member_ship FOR SHARE; LOCK TABLE luck_lottery,store_promotions IN SHARE ROW EXCLUSIVE MODE; ROLLBACK');
      await expect(app.exec('UPDATE system_store SET id=id+100 WHERE id=1')).rejects.toMatchObject({code:'42501'});
      await app.exec('UPDATE system_store SET id=id WHERE id=1');
      await expect(app.exec("UPDATE system_admin SET pwd='forbidden' WHERE id=1")).rejects.toMatchObject({code:'42501'});
      await expect(app.exec('DELETE FROM store_order_status')).rejects.toMatchObject({code:'42501'});
      await expect(app.exec('TRUNCATE store_cart')).rejects.toMatchObject({code:'42501'});
      await expect(app.exec("SELECT setval('store_order_id_seq',1)")).rejects.toMatchObject({code:'42501'});
      await expect(app.exec('SET ROLE "'+admin.role+'"')).rejects.toMatchObject({code:'42501'});
      await expect(app.exec("SET session_replication_role='replica'")).rejects.toMatchObject({code:'42501'});
      const names={app:app.role,admin:admin.role,maintenance:'finance_test'};
      await f.exec(`GRANT SELECT ON public.data_migration_run TO "${app.role}"`);
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names)).failures).toContain('table:data_migration_run:SELECT');
      await f.exec(`REVOKE SELECT ON public.data_migration_run FROM "${app.role}"`);
      await f.exec(`GRANT UPDATE(value) ON public.system_config TO "${app.role}"`);
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names)).failures).toContain('column:system_config.value:UPDATE');
      await f.exec(`REVOKE UPDATE(value) ON public.system_config FROM "${app.role}"`);
      expect(await auditRuntimeBusinessPrivileges(app.db,'app',names)).toMatchObject({ready:true,failures:[]});
      await f.exec(`GRANT USAGE ON SEQUENCE public.store_order_id_seq TO "${app.role}" WITH GRANT OPTION`);
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names)).failures).toContain('sequence:store_order_id_seq');
      await f.exec(`REVOKE GRANT OPTION FOR USAGE ON SEQUENCE public.store_order_id_seq FROM "${app.role}"`);
      await f.exec(`CREATE SCHEMA outside_runtime; CREATE TABLE outside_runtime.hidden(value integer);
        GRANT SELECT ON outside_runtime.hidden TO "${app.role}"`);
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names)).failures).toContain('no_other_schema_data');
      await f.exec(`REVOKE SELECT ON outside_runtime.hidden FROM "${app.role}"`);
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${app.role}"`);
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names)).failures).toContain('default_grants');
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM "${app.role}"`);
      const before=await inspectRuntimeLockOnlyBoundary(f.db,app.role,admin.role,'finance_test');expect(before.ready).toBe(true);
      expect(await f.db.transaction(tx=>installRuntimeLockOnlyBoundaryInTransaction(tx,app.role,admin.role,'finance_test'))).toMatchObject({applied:false,ready:true});
      await f.exec('ALTER FUNCTION public.cinashop_runtime_lock_only_v1() RESET search_path');
      await expect(f.db.transaction(tx=>installRuntimeLockOnlyBoundaryInTransaction(tx,app.role,admin.role,'finance_test'))).rejects.toThrow('drift');
    });
  },60_000);
});
