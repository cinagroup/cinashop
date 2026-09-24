import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { orderConfirm, orderCreate, orderCancel, orderDel } from '../src/controllers/api/v1/OrderController';
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
import { inspectRuntimeBusinessCommissioning, type RuntimeCommissionTarget } from '../src/migrations/runRuntimeBusinessCommissioning';
import { inspectRuntimePurchaseEvidence, lockRuntimePurchaseEvidenceForGrants } from '../src/migrations/runtimePurchaseEvidence';
import { runPurchaseOriginEvidence } from '../src/migrations/runPurchaseOriginEvidence';
import { runPurchaseCancellationEvidence } from '../src/migrations/runPurchaseCancellationEvidence';
import { ScheduledMaintenanceService } from '../src/services/order/ScheduledMaintenanceService';
import { storeOrderPurchaseCancellation } from '../src/models/schema/purchase_cancellation_evidence';

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
  const names=(app:Role,admin:Role)=>({app:app.role,admin:admin.role,maintenance:'finance_test'});
  const identities=()=>f.exec(`SELECT 'relation' AS kind,oid::text,relowner::text AS owner,relacl::text AS acl FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
    UNION ALL SELECT 'trigger',oid::text,NULL,NULL FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    ORDER BY kind,oid`);
  async function emptyProfiles(run:(app:Role,admin:Role,target:RuntimeCommissionTarget)=>Promise<void>){
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [identity]=await f.exec('SELECT current_database() AS database');
      await run(app,admin,{...names(app,admin),database:String(identity.database),pricingOwner:f.pricingOwner});
    }));
  }
  function publicHttp(role:Role){
    const http=new Hono<{Bindings:Env;Variables:AppVariables}>();
    // Identity/KV/Sequence are synthetic. Actual HTTP controllers, SQL service
    // and independently authenticated full-profile LOGIN are exercised here.
    http.use('*',async(c,next)=>{c.set('container',createContainerFromDb(role.db));c.set('uid',11);await next();});
    http.onError((error,c)=>c.json({status:400,msg:error.message,data:null}));
    http.post('/confirm',orderConfirm);http.post('/create/:key',orderCreate);
    http.post('/cancel',orderCancel);http.post('/delete',orderDel);
    const sequence=vi.fn(async()=>new Response('full-profile-public-order'));
    Object.assign(f.env,{SEQUENCE:{idFromName:()=> 'local',get:()=>({fetch:sequence})}});
    const post=async(path:string,body:object)=>(await http.request(path,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(body)},f.env)).json<{status:number;msg:string;data:{orderKey:string;quoteToken:string;orderId:string}}>();
    return {post,sequence};
  }
  async function publicCreate(role:Role,presale=false,points=true){
    const http=publicHttp(role),input={cartIds:presale?[1]:[1,2],addressId:11,useIntegral:points,type:presale?6:0};
    const before=await f.state(),quote=await http.post('/confirm',input);
    expect(quote.status,quote.msg).toBe(200);expect(await f.state()).toEqual(before);expect(http.sequence).not.toHaveBeenCalled();
    const created=await http.post(`/create/${quote.data.orderKey}`,{...input,quoteToken:quote.data.quoteToken,requirePurchaseOrigin:false});
    expect(created.status,created.msg).toBe(200);
    const [root]=await role.exec('SELECT id,order_id,add_time FROM public.store_order');
    expect(root).toBeTruthy();return {http,input,quote,root};
  }
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
        has_table_privilege('${app.role}','public.store_order_purchase_origin','SELECT,INSERT')
          OR has_table_privilege('${app.role}','public.store_order_purchase_cancellation','SELECT,INSERT') AS evidence_grants,
        to_regprocedure('public.cinashop_runtime_admin_boundary_v1()') IS NULL AS no_staff_boundary,
        to_regprocedure('public.cinashop_runtime_lock_only_v1()') IS NULL AS no_lock_boundary`);
      expect(remaining).toEqual({app_grants:false,admin_grants:false,evidence_grants:false,no_staff_boundary:true,no_lock_boundary:true});
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
      // Match the public createOrder requirement; bypassing capture here would
      // certify a profile that cannot run the actual storefront entry point.
      const create=()=>StoreOrderCreateService.createWithRuntime(container,{CONFIG_KV:f.env.CONFIG_KV,requirePurchaseOrigin:true,nextOrderId:async()=>'business_profile_order'},input);
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

  it.each([
    [false,'cancel'],[false,'delete'],[false,'scheduled'],[true,'cancel'],[true,'delete'],[true,'scheduled'],
  ] as const)('runs public confirmation/create and %s presale / %s cancellation under the exact app LOGIN',async(presale,action)=>{
    if(presale)await f.exec('UPDATE store_product SET is_presale_product=1,presale_start_time=0,presale_end_time=2147483647,is_limit=0 WHERE id=70; UPDATE store_cart SET type=6 WHERE id=1');
    else await f.exec('UPDATE store_product SET type=1,relation_id=0 WHERE id=71');
    await profiles(async(app,admin)=>{
      const before=await f.state(),{http,input,quote,root}=await publicCreate(app,presale);
      expect(await app.exec('SELECT order_id,buyer_id,order_type,used_points FROM public.store_order_purchase_origin'))
        .toEqual([{order_id:root.id,buyer_id:11,order_type:presale?6:0,used_points:'100'}]);
      const made=await f.state();
      expect((await http.post(`/create/${quote.data.orderKey}`,{...input,quoteToken:quote.data.quoteToken})).status).toBe(200);
      expect(await f.state()).toEqual(made);
      if(action==='scheduled')expect(await new ScheduledMaintenanceService(createContainerFromDb(app.db),f.env).processOrder({
        action:'processScheduledOrder',job:'unpaid_order_cancel',runId:'full-profile-cancel',scheduledAt:(Number(root.add_time)+7200)*1000,
        threshold:Number(root.add_time)+3600,orderId:Number(root.id)})).toMatchObject({completed:true});
      else expect((await http.post('/'+action,{order_id:root.order_id})).status).toBe(200);
      expect(await app.exec('SELECT order_id,buyer_id,restored_points FROM public.store_order_purchase_cancellation'))
        .toEqual([{order_id:root.id,buyer_id:11,restored_points:'100'}]);
      const done=await f.state();
      for(const table of ['store_product','store_product_attr_value','store_cart','user'])expect(done[table],table).toEqual(before[table]);
      expect((await http.post('/cancel',{order_id:root.order_id})).status).toBe(400);expect(await f.state()).toEqual(done);
      for(const table of ['store_order_purchase_origin','store_order_purchase_cancellation']){
        await expect(admin.exec(`SELECT * FROM public.${table} LIMIT 0`)).rejects.toMatchObject({code:'42501'});
        for(const statement of [`UPDATE public.${table} SET buyer_id=buyer_id`,`DELETE FROM public.${table}`,`TRUNCATE public.${table}`])
          await expect(app.exec(statement)).rejects.toMatchObject({code:'42501'});
      }
      expect(await f.state()).toEqual(done);
    });
  },60_000);
  it('keeps presale points opt-out at zero through actual public creation and cancellation',async()=>{
    await f.exec('UPDATE store_product SET is_presale_product=1,presale_start_time=0,presale_end_time=2147483647,is_limit=0 WHERE id=70; UPDATE store_cart SET type=6 WHERE id=1');
    await profiles(async(app)=>{
      const {http,root}=await publicCreate(app,true,false);
      expect((await http.post('/cancel',{order_id:root.order_id})).status).toBe(200);
      expect(await app.exec('SELECT restored_points FROM store_order_purchase_cancellation')).toEqual([{restored_points:'0'}]);
      expect(await app.exec('SELECT integral FROM public."user" WHERE uid=11')).toEqual([{integral:100}]);
    });
  },60_000);
  it.each([
    ['create','store_order_purchase_origin','SELECT'],['create','store_order_purchase_origin','INSERT'],
    ['cancel','store_order_purchase_origin','SELECT'],['cancel','store_order_purchase_cancellation','INSERT'],
  ] as const)('rolls back real public %s when required %s %s is revoked',async(operation,table,privilege)=>{
      await profiles(async(app)=>{
        const http=publicHttp(app),input={cartIds:[1,2],addressId:11,useIntegral:true};
        const quote=await http.post('/confirm',input);expect(quote.status).toBe(200);
        const create=()=>http.post(`/create/${quote.data.orderKey}`,{...input,quoteToken:quote.data.quoteToken});
        if(operation==='cancel')expect((await create()).status).toBe(200);
        await f.exec(`REVOKE ${privilege} ON public.${table} FROM "${app.role}"`);
        const before=await f.state();
        const act=()=>operation==='create'?create():http.post('/cancel',{order_id:'full-profile-public-order'});
        expect((await act()).status).toBe(400);expect(await f.state()).toEqual(before);
        if(table==='store_order_purchase_origin')await runPurchaseOriginEvidence(f.db,app.role);else await runPurchaseCancellationEvidence(f.db,app.role);
        expect((await act()).status).toBe(200);
      });
    },60_000);
  it('distinguishes cancellation receipt read access from the invoker trigger write path',async()=>{
    await profiles(async(app,admin)=>{
      const {http,root}=await publicCreate(app);
      await f.exec(`REVOKE SELECT ON public.store_order_purchase_cancellation FROM "${app.role}"`);
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names(app,admin))).failures)
        .toContain('table:store_order_purchase_cancellation:SELECT');
      await expect(app.exec('SELECT * FROM public.store_order_purchase_cancellation')).rejects.toMatchObject({code:'42501'});
      // The deferred validator uses NEW and reads source rows, not its receipt
      // table. Do not invent a SELECT dependency to make a negative test pass.
      expect((await http.post('/cancel',{order_id:root.order_id})).status).toBe(200);
      expect(await f.exec('SELECT order_id,restored_points FROM store_order_purchase_cancellation'))
        .toEqual([{order_id:root.id,restored_points:'100'}]);
      const done=await f.state();
      await runPurchaseCancellationEvidence(f.db,app.role);
      expect(await auditRuntimeBusinessPrivileges(app.db,'app',names(app,admin))).toMatchObject({ready:true,failures:[]});
      expect(await f.state()).toEqual(done);
    });
  },60_000);
  it.each([
    'DROP TABLE public.store_order_purchase_cancellation',
    'ALTER TABLE public.store_order_purchase_origin DISABLE TRIGGER sopo_no_rewrite',
    'ALTER TABLE public.store_order DISABLE TRIGGER sopc_order_transition',
    'ALTER FUNCTION public.validate_purchase_cancellation_v1() SECURITY DEFINER',
    'DROP INDEX public.ub_cat_type_link_idx',
    'GRANT SELECT ON public.store_order_purchase_cancellation TO PUBLIC',
  ])('refuses missing/drifted purchase protocol before any commissioning: %s',async(mutation)=>{
    await f.exec(mutation);
    await emptyProfiles(async(app,admin,target)=>{
      const before=await identities();
      expect((await inspectRuntimeBusinessCommissioning(f.db,target)).purchaseEvidence.ready).toBe(false);
      await expect(runRuntimeBusinessCommissioning(f.db,target)).rejects.toThrow('already be installed');
      expect(await identities()).toEqual(before);
      for(const [kind,peer] of [['app',app],['admin',admin]] as const)
        expect((await auditRuntimeBusinessPrivileges(peer.db,kind,names(app,admin))).failures).toContain('purchase_evidence_protocols');
    });
  },60_000);
  it('refuses an exact empty but unprotected ORM receipt without completing it',async()=>{
    await f.exec(`DROP TRIGGER sopc_order_transition ON public.store_order; DROP TABLE public.store_order_purchase_cancellation;
      DROP FUNCTION public.begin_purchase_cancellation_v1(),public.capture_purchase_cancellation_v1(),public.validate_purchase_cancellation_v1(),public.protect_purchase_cancellation_v1()`);
    const api=await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson({storeOrderPurchaseCancellation}))).join('\n'));
    await emptyProfiles(async(_app,_admin,target)=>{
      const before=await identities();
      expect((await inspectRuntimeBusinessCommissioning(f.db,target)).purchaseEvidence).toMatchObject({origin:'v1',cancellation:'orm-pending',ready:false});
      await expect(runRuntimeBusinessCommissioning(f.db,target)).rejects.toThrow('already be installed');expect(await identities()).toEqual(before);
    });
  },60_000);
  it.each([
    'ALTER TABLE public.store_order DISABLE TRIGGER sopc_order_transition',
    'ALTER TABLE public.store_order_purchase_origin DISABLE TRIGGER sopo_no_rewrite',
    'ALTER FUNCTION public.validate_purchase_cancellation_v1() SECURITY DEFINER',
    'GRANT EXECUTE ON FUNCTION public.capture_purchase_origin_v1() TO PUBLIC',
  ])('readonly audits refuse protocol drift after exact commissioning: %s',async(mutation)=>{
    await profiles(async(app,admin)=>{
      await f.exec(mutation);const before=await identities(),data=await f.state();
      for(const [kind,peer] of [['app',app],['admin',admin]] as const){
        const result=await auditRuntimeBusinessPrivileges(peer.db,kind,names(app,admin));
        expect(result.ready).toBe(false);expect(result.failures).toContain('purchase_evidence_protocols');
      }
      expect(await identities()).toEqual(before);expect(await f.state()).toEqual(data);
    });
  },60_000);
  it('holds the shared evidence fence and six NOWAIT locks before granting either profile',async()=>{
    await emptyProfiles(async(_app,_admin,target)=>{
      const before=await identities();
      for(const command of ['SELECT pg_advisory_xact_lock(731611,0)',...['store_order','store_order_cart_info','store_order_purchase_origin',
        'store_order_status','user_bill','store_order_purchase_cancellation'].map(table=>`LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`)]){
        await f.withPeer!(async peer=>{
          await peer.exec(`BEGIN; ${command}`);
          try{await expect(runRuntimeBusinessCommissioning(f.db,target)).rejects.toThrow();}
          finally{await peer.exec('ROLLBACK');}
        });
        expect(await identities()).toEqual(before);
      }
      expect(await runRuntimeBusinessCommissioning(f.db,target)).toMatchObject({grantsApplied:true});
    });
  },60_000);
  it('keeps root/owner/isolation boundaries and never changes the inspecting runtime identity',async()=>{
    await expect(lockRuntimePurchaseEvidenceForGrants(f.db,'finance_test')).rejects.toThrow('requires a transaction');
    await expect(f.db.transaction(tx=>lockRuntimePurchaseEvidenceForGrants(tx,'finance_test'),{isolationLevel:'repeatable read'})).rejects.toThrow('requires review');
    await expect(f.db.transaction(tx=>lockRuntimePurchaseEvidenceForGrants(tx,'finance_test'),{accessMode:'read only'})).rejects.toThrow('requires review');
    await emptyProfiles(async(app,admin)=>{
      const before=await identities();
      for(const peer of [app,admin]){
        expect(await inspectRuntimePurchaseEvidence(peer.db,'finance_test')).toMatchObject({origin:'v1',cancellation:'v1',ready:true});
        expect((await inspectRuntimePurchaseEvidence(peer.db,peer.role)).ready).toBe(false);
        expect(await peer.exec('SELECT current_user=session_user AND current_user=\''+peer.role+'\' AS same')).toEqual([{same:true}]);
        await expect(peer.db.transaction(tx=>lockRuntimePurchaseEvidenceForGrants(tx,'finance_test'))).rejects.toThrow('requires review');
      }
      expect(await identities()).toEqual(before);
    });
  },60_000);
  it('requires both explicit evidence upgrades on an already commissioned profile without replaying whole-shop grants',async()=>{
    await profiles(async(app,admin)=>{
      await f.exec(`REVOKE SELECT,INSERT ON public.store_order_purchase_origin,public.store_order_purchase_cancellation FROM "${app.role}"`);
      const original=await identities();
      const [identity]=await f.exec('SELECT current_database() AS database');
      await expect(runRuntimeBusinessCommissioning(f.db,{...names(app,admin),database:String(identity.database),pricingOwner:f.pricingOwner})).rejects.toThrow('preflight refused');
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names(app,admin))).ready).toBe(false);
      await runPurchaseOriginEvidence(f.db,app.role);
      expect((await auditRuntimeBusinessPrivileges(app.db,'app',names(app,admin))).ready).toBe(false);
      await runPurchaseCancellationEvidence(f.db,app.role);
      expect(await auditRuntimeBusinessPrivileges(app.db,'app',names(app,admin))).toMatchObject({ready:true,failures:[]});
      const installed=await identities();
      const receipts=await f.exec("SELECT oid::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN('store_order_purchase_origin','store_order_purchase_cancellation')");
      const isReceipt=(r:Record<string,unknown>)=>r.kind==='relation'&&receipts.some(p=>p.oid===r.oid);
      expect(installed.filter(r=>!isReceipt(r))).toEqual(original.filter(r=>!isReceipt(r)));
      await runPurchaseOriginEvidence(f.db,app.role);await runPurchaseCancellationEvidence(f.db,app.role);expect(await identities()).toEqual(installed);
      expect(await auditRuntimeBusinessPrivileges(admin.db,'admin',names(app,admin))).toMatchObject({ready:true,failures:[]});
      await publicCreate(app);
    });
  },60_000);
});
