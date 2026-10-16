import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { systemAdmin, systemRole, systemMenus, systemSupplier, storeProduct, storeProductAttrValue,
  storeOrder, storeOrderCartInfo, storeOrderStatus, storeOrderOutbox } from '@/models/schema';
import { storeOrderWriteoff,storeServiceRecord,supplierFlowingWater,supplierTransactions,
  storeOrderRefund,storeOrderRefundSplit,user,userBill,userExtract,capitalFlow,
  orderNotificationDelivery,systemMessage } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { installSupplierOrderEditOperation } from '@/migrations/supplierOrderEditOperation';
import { installSupplierOrderPriceRevision } from '@/migrations/supplierOrderPriceRevision';
import { SUPPLIER_ORDER_PRICE_REVISION_CHECK_DEFINITION } from '@/migrations/supplierOrderPriceRevision';
import { SECOND_CARD_REMINDER_MIGRATION_SQL } from '@/migrations/secondCardReminderIndexes';
import { runWithdrawalReplayUpgrade } from '@/migrations/runWithdrawalReplayUpgrade';
import { runWithdrawalEffectsUpgrade } from '@/migrations/runWithdrawalEffectsUpgrade';
import { runPresaleDeliveryOutbox } from '@/migrations/runPresaleDeliveryOutbox';
import { runPinkSuccessNotice } from '@/migrations/runPinkSuccessNotice';
import { runProductStockEffects } from '@/migrations/runProductStockEffects';
import { runProductRecycleEffects } from '@/migrations/runProductRecycleEffects';
import { runProductSaveEffects } from '@/migrations/runProductSaveEffects';
import { PRODUCT_SAVE_EFFECTS_CHECK_DEFINITION,PRODUCT_SAVE_EFFECTS_EVENTS } from '@/migrations/productSaveEffects';
import { SupplierUnpaidOrderEditService } from '@/services/supplier/SupplierUnpaidOrderEditService';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { readCashierOrdinaryPaidOrigin } from '@/services/order/CashierOrdinaryOrigin';
import { readCashierSecondCardOrigin } from '@/services/order/CashierSecondCardOrigin';
import { CustomerWorkCashierReadService } from '@/services/customer-work/CustomerWorkCashierReadService';
import { manualRefundPaymentFacts } from '@/services/order/CustomerManualRefund';
import { loadUnpaidOrderCashierEditProof } from '@/services/order/UnpaidOrderCashierEditProof';
import { installCustomerManualRefund } from '@/migrations/runCustomerManualRefund';
import { customerManualRefundRuntimeGrantSql,customerManualRefundRuntimePrivilegePlan } from '@/migrations/customerManualRefundRuntimePlan';
import { CUSTOMER_FINANCIAL_FUNCTIONS } from '@/migrations/customerFinancialRuntimePlan';
import { CUSTOMER_WORK_LOCK_FUNCTIONS } from '@/migrations/customerWorkRuntimePrivilegePlan';
import { cashierSecondCardPromotionLockGrantSql } from '@/migrations/cashierSecondCardPromotionLock';
import { auditCheckoutPricingLockRuntime } from '@/migrations/checkoutPricingLock';
import { runInvoiceEvidence } from '@/migrations/runInvoiceEvidence';
import { runRefundOrderSplit } from '@/migrations/runRefundOrderSplit';
import { customerWriteoffRuntimePrivilegePlan } from '@/migrations/customerWriteoffRuntimePlan';
import { CustomerWorkWriteoffService } from '@/services/customer-work/CustomerWorkWriteoffService';
import { CUSTOMER_WRITEOFF_VERSION } from '@/services/customer-work/CustomerWorkWriteoffProtocol';
import { CustomerWorkFinancialService } from '@/services/customer-work/CustomerWorkFinancialService';
import { financialRevisions } from '@/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_VERSION,CUSTOMER_FINANCIAL_QUOTE_VERSION } from '@/services/customer-work/CustomerWorkFinancialProtocol';
import { authorizeCustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import type { CustomerJson } from '@/services/customer-work/CustomerWorkOperationRequest';
import { customerCashierOrdinaryFixture } from './helpers/customerCashierOrdinaryFixture';
import { customerCashierSecondCardFixture } from './helpers/customerCashierSecondCardFixture';

const wiring=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:wiring.open}));
const app=createApp(),password='owned-cashier-supplier-edit-password';
type Ordinary=Awaited<ReturnType<typeof customerCashierOrdinaryFixture>>;
type Second=Awaited<ReturnType<typeof customerCashierSecondCardFixture>>;
type Fixture=Ordinary|Second;
const actor=(id=21)=>({id,supplierId:88,authVersion:md5(password),expiresAt:Math.floor(Date.now()/1000)+3600});
type Seed={values:{order_id:string;total_price:string;total_postage:string;pay_postage:string;pay_price:string;gain_integral:string};revision:string};
type Reply<T>={status:number;msg:string;data:T};

/** Genuine current cashier producers, two independent non-owner realms and the
 * actual Supplier JWT/permission/controller/service. Only this owned fixture
 * commissions SELECT access to the new financial evidence; frozen production
 * privilege profiles are never broadened. Queue/provider execution is absent. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['ordinary','second-card'] as const)('Supplier edits genuine %s cashier origin',kind=>{
  let f:Fixture,manualOwner:string|undefined,financialRole:string|undefined,
    financialClient:ReturnType<typeof postgres>|undefined,financialDb:DbClient|undefined;
  async function closeFinancial(){
    await financialClient?.end({timeout:5});financialClient=undefined;financialDb=undefined;
    if(financialRole){await f.exec(`DROP OWNED BY "${financialRole}";DROP ROLE "${financialRole}"`);financialRole=undefined;}
  }
  beforeAll(async()=>{
    f=kind==='ordinary'?await customerCashierOrdinaryFixture():await customerCashierSecondCardFixture();
    try{
      const models={systemAdmin,systemRole,systemMenus,storeOrderWriteoff,storeServiceRecord,
        userExtract,capitalFlow,orderNotificationDelivery,systemMessage},missing:Partial<typeof models>={};
      for(const [name,table]of Object.entries(models)){
        const [row]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT to_regclass(${'public.'+getTableConfig(table).name}) IS NOT NULL AS present`);
        if(!row.present)Object.assign(missing,{[name]:table});
      }
      if(Object.keys(missing).length){const kit=await import('drizzle-kit/api');
        for(const ddl of await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson(missing)))await f.exec(ddl);}
      const kit=await import('drizzle-kit/api');
      for(const ddl of await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson({supplierFlowingWater,supplierTransactions,storeOrderWriteoff}))){
        const name=/^CREATE (?:UNIQUE )?INDEX "([^"]+)"/.exec(ddl.trim())?.[1];
        if(name){const [existing]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT to_regclass(${'public.'+name}) IS NOT NULL AS present`);if(!existing.present)await f.exec(ddl);}
      }
      // Ordinary catalogue creation and generic financial actions intentionally
      // have separate reviewed DB capability realms. The ordinary LOGIN keeps
      // its product/user catalogue EXECUTEs; generic financial pricing must not
      // silently broaden that scope or revoke the creator's real capabilities.
      // This independent financial LOGIN uses the same actual Customer101 and
      // original order, the existing financial/manual DML plan and SELECT-only
      // ordinary origin/0191 evidence. It does not certify a combined runtime.
      let financialSecret:string|undefined;
      if(kind==='ordinary'){
        financialRole='cashier_financial_'+randomUUID().replaceAll('-','');financialSecret=randomUUID().replaceAll('-','');
        await f.exec(`CREATE ROLE "${financialRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${financialSecret}'`);
        await f.exec(`GRANT USAGE ON SCHEMA public TO "${financialRole}"`);
        const profile=customerManualRefundRuntimePrivilegePlan();
        const tables=await f.maintenanceDb.execute<{name:string}>(sql`SELECT relname AS name FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`);
        for(const {name}of tables){const rights=profile.tables[name];if(rights?.length)await f.exec(`GRANT ${rights.join(',')} ON public."${name}" TO "${financialRole}"`);
          const columns=profile.updateColumns[name];if(columns?.length&&name!=='store_order_promotions')await f.exec(`GRANT UPDATE(${columns.map(column=>'"'+column+'"').join(',')}) ON public."${name}" TO "${financialRole}"`);}
        const sequences=await f.maintenanceDb.execute<{name:string;table:string}>(sql`SELECT s.relname AS name,t.relname AS "table" FROM pg_catalog.pg_class s JOIN pg_catalog.pg_depend d ON d.objid=s.oid AND d.deptype IN('a','i') JOIN pg_catalog.pg_class t ON t.oid=d.refobjid WHERE s.relkind='S'`);
        for(const item of sequences)if(profile.tables[item.table]?.includes('INSERT'))await f.exec(`GRANT USAGE ON SEQUENCE public."${item.name}" TO "${financialRole}"`);
        // Match the mature financial fixture's exact routine slice; the two
        // ordinary catalogue definers belong exclusively to the creator realm.
        for(const signature of [...CUSTOMER_WORK_LOCK_FUNCTIONS,...CUSTOMER_FINANCIAL_FUNCTIONS,'checkout_lock_pricing_v1()'])
          await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${financialRole}"`);
        await runInvoiceEvidence(f.maintenanceDb,financialRole);await runRefundOrderSplit(f.maintenanceDb,financialRole);
        // This checked stage-one grant runs before the manual DELETE definer
        // is installed; it proves the real existing promotion trigger first.
        await f.exec(cashierSecondCardPromotionLockGrantSql(financialRole));
      }
      manualOwner='cashier_edit_manual_'+randomUUID().replaceAll('-','');
      await f.exec(`CREATE ROLE "${manualOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await installCustomerManualRefund(f.maintenanceDb,manualOwner);
      for(const grant of customerManualRefundRuntimeGrantSql(f.role,[]).filter(value=>value.includes('customer_financial_manual_refund_v1')||value.includes('customer_manual_refund_promotion_delete_v1')))await f.exec(grant);
      if(financialRole)for(const grant of customerManualRefundRuntimeGrantSql(financialRole,[]).filter(value=>value.includes('customer_financial_manual_refund_v1')||value.includes('customer_manual_refund_promotion_delete_v1')))await f.exec(grant);
      const writeoff=customerWriteoffRuntimePrivilegePlan();
      for(const table of ['store_service_record','store_order_writeoff','agent_level_task','agent_level_task_record']){
        const rights=writeoff.tables[table];if(!rights?.length)throw Error('Existing writeoff capability absent: '+table);
        await f.exec(`GRANT ${rights.join(',')} ON public.${table} TO "${f.role}"`);
        if(rights.includes('INSERT')){const [sequence]=await f.maintenanceDb.execute<{name:string|null}>(sql`SELECT pg_get_serial_sequence(${'public.'+table},'id') AS name`);
          if(sequence.name)await f.exec(`GRANT USAGE ON SEQUENCE ${sequence.name} TO "${f.role}"`);}
      }
      // The genuine parent uses a column/default/PK fixture: no outbox CHECK is
      // installed. Prove that fresh initial state before the historical five-
      // event constructor, then use only the reviewed owner upgrade chain.
      // An unknown existing CHECK must never be dropped or repaired here.
      const eventDefinition=async()=>{
        const rows=await f.maintenanceDb.execute<{definition:string}>(sql`SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_catalog.pg_constraint WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
        if(rows.length>1)throw Error('Owned cashier fixture outbox CHECK is ambiguous');
        return rows[0]?.definition??null;
      };
      const initialCheck=await eventDefinition();
      console.log('SUPPLIER_CASHIER_EDIT_OUTBOX_INITIAL '+JSON.stringify({kind,definition:initialCheck}));
      expect(initialCheck).toBeNull();
      await withTx(createContainerFromDb(f.maintenanceDb),async tx=>{await tx.execute(sql.raw(SECOND_CARD_REMINDER_MIGRATION_SQL));});
      const fiveCheck=await eventDefinition();
      expect(fiveCheck).toBe(`CHECK (((event_type)::text = ANY ((ARRAY[${PRODUCT_SAVE_EFFECTS_EVENTS.slice(0,5).map(event=>`'${event}'::character varying`).join(', ')}])::text[])))`);
      await runWithdrawalReplayUpgrade(f.maintenanceDb);
      await runWithdrawalEffectsUpgrade(f.maintenanceDb);
      const nineCheck=await eventDefinition();
      expect(nineCheck).toBe(`CHECK (((event_type)::text = ANY ((ARRAY[${PRODUCT_SAVE_EFFECTS_EVENTS.slice(0,9).map(event=>`'${event}'::character varying`).join(', ')}])::text[])))`);
      await runPresaleDeliveryOutbox(f.maintenanceDb);
      await runPinkSuccessNotice(f.maintenanceDb);
      await runProductStockEffects(f.maintenanceDb);
      await runProductRecycleEffects(f.maintenanceDb);
      await runProductSaveEffects(f.maintenanceDb);
      const fourteenCheck=await eventDefinition();expect(fourteenCheck).toBe(PRODUCT_SAVE_EFFECTS_CHECK_DEFINITION);
      await withTx(createContainerFromDb(f.maintenanceDb),async tx=>{await installSupplierOrderEditOperation(tx);await installSupplierOrderPriceRevision(tx);});
      const finalCheck=await eventDefinition();expect(finalCheck).toBe(SUPPLIER_ORDER_PRICE_REVISION_CHECK_DEFINITION);
      console.log('SUPPLIER_CASHIER_EDIT_OUTBOX_COMMISSIONED '+JSON.stringify({kind,
        initial:initialCheck,five:fiveCheck,nine:nineCheck,fourteen:fourteenCheck,fifteen:finalCheck}));
      await f.maintenanceDb.insert(systemAdmin).values([21,22,29].map(id=>({id,account:'owned-cashier-edit-'+id,pwd:password,
        adminType:4,relationId:88,roles:id===29?'':String(id),level:id===29?0:1}))).onConflictDoNothing();
      await f.maintenanceDb.insert(systemRole).values([21,22].map(id=>({id,type:4,relationId:88,rules:'supplier.order.manage'}))).onConflictDoNothing();
      // customerWorkFinancialFixture reuses only the reader's TABLE list; it
      // never runs customerWorkReadFixture's Supplier seed. Commission this
      // actual tenant here rather than silently updating an absent row.
      const suppliers=await f.maintenanceDb.insert(systemSupplier).values({id:88,supplierName:'Owned cashier edit Supplier',
        adminId:29,isShow:1,isDel:0}).returning({id:systemSupplier.id,adminId:systemSupplier.adminId,
          isShow:systemSupplier.isShow,isDel:systemSupplier.isDel});
      expect(suppliers).toEqual([{id:88,adminId:29,isShow:1,isDel:0}]);
      await f.exec(`GRANT SELECT ON public.supplier_order_edit_operation_v1 TO "${f.role}"`);
      if(financialRole&&financialSecret){
        await f.exec(`GRANT SELECT ON public.supplier_order_edit_operation_v1,public.cashier_ordinary_draft_v1,public.cashier_ordinary_cart_v1,public.cashier_ordinary_operation_v1,public.cashier_ordinary_origin_v1 TO "${financialRole}"`);
        const url=new URL(f.connectionString);url.username=financialRole;url.password=financialSecret;
        financialClient=postgres(url.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,
          connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=3000'}});
        financialDb=drizzle(financialClient) as unknown as DbClient;
        const [identity]=await financialDb.execute<{direct:boolean;owner:boolean;origin_mutable:boolean;edit_mutable:boolean;product_catalog:boolean;user_catalog:boolean}>(sql`SELECT current_user=session_user AS direct,
          (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS owner,
          has_table_privilege(current_user,'public.cashier_ordinary_origin_v1','INSERT,UPDATE,DELETE,TRUNCATE') AS origin_mutable,
          has_table_privilege(current_user,'public.supplier_order_edit_operation_v1','INSERT,UPDATE,DELETE,TRUNCATE') AS edit_mutable,
          has_function_privilege(current_user,'public.customer_product_lock_catalog_v1(text,integer[])','EXECUTE') AS product_catalog,
          has_function_privilege(current_user,'public.customer_user_lock_catalog_v1(text,integer[])','EXECUTE') AS user_catalog`);
        expect(identity).toEqual({direct:true,owner:false,origin_mutable:false,edit_mutable:false,product_catalog:false,user_catalog:false});
        const pricing=await auditCheckoutPricingLockRuntime(financialDb,'public','customer-work');
        console.log('SUPPLIER_CASHIER_EDIT_FINANCIAL_PRICING '+JSON.stringify({identity,pricing}));
        expect(pricing).toEqual({ready:true,catalogReady:true,callerSafe:true,requiredPrivileges:true,noUnreviewedDefinerRoutine:true});
      }
      f.runtime.nextOrderId=async()=> 'wx'+randomUUID().replaceAll('-','').slice(0,28);
    }catch(error){try{await closeFinancial();if(manualOwner){await f.exec(`DROP OWNED BY "${manualOwner}";DROP ROLE "${manualOwner}"`);manualOwner=undefined;}}finally{await f.close();}throw error;}
  },180000);
  beforeEach(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Cashier edit fixture forbids external provider I/O'));
    await f.maintenanceDb.delete(storeOrderWriteoff);await f.exec('TRUNCATE public.customer_financial_manual_refund_v1');
    await f.reset();
    const suppliers=await f.maintenanceDb.select({id:systemSupplier.id,adminId:systemSupplier.adminId,
      isShow:systemSupplier.isShow,isDel:systemSupplier.isDel}).from(systemSupplier).where(eq(systemSupplier.id,88));
    expect(suppliers).toEqual([{id:88,adminId:29,isShow:1,isDel:0}]);
    await f.exec('ALTER TABLE public.supplier_order_edit_operation_v1 DISABLE TRIGGER USER; TRUNCATE public.supplier_order_edit_operation_v1; ALTER TABLE public.supplier_order_edit_operation_v1 ENABLE TRIGGER USER');
    await f.maintenanceDb.update(storeProduct).set({type:2,relationId:88,giveIntegral:'0.00'}).where(eq(storeProduct.id,70));
    await f.maintenanceDb.update(storeProductAttrValue).set({settlePrice:'1.00'}).where(eq(storeProductAttrValue.productId,70));
  },60000);
  afterEach(()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();}});
  afterAll(async()=>{try{await closeFinancial();if(manualOwner)await f.exec(`DROP OWNED BY "${manualOwner}";DROP ROLE "${manualOwner}"`);}finally{await f?.close();}},30000);
  const originTable=()=>kind==='ordinary'?'cashier_ordinary_origin_v1':'cashier_second_card_origin_v1';
  const original=()=>f.db.execute(sql.raw(`SELECT * FROM public.${originTable()} ORDER BY order_id`));
  const state=async(id:number)=>({order:(await f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0],
    carts:await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,id)).orderBy(asc(storeOrderCartInfo.id)),
    statuses:await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid,id)).orderBy(asc(storeOrderStatus.id)),
    outbox:await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.aggregateId,id)).orderBy(asc(storeOrderOutbox.id)),
    edits:await f.db.execute(sql`SELECT * FROM public.supplier_order_edit_operation_v1 WHERE order_id=${id} ORDER BY operation_id`)});
  async function withSupplier<T>(run:(db:DbClient,service:SupplierUnpaidOrderEditService,role:string)=>Promise<T>){
    const role='cashier_supplier_'+randomUUID().replaceAll('-',''),secret=randomUUID().replaceAll('-','');let client:ReturnType<typeof postgres>|undefined;
    await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`);
    try{
      await f.exec(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      const plan=runtimeBusinessPrivilegePlan('app'),tables=await f.maintenanceDb.execute<{name:string}>(sql`SELECT relname AS name FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`);
      for(const {name}of tables){const rights=plan.tables[name];if(rights?.length)await f.exec(`GRANT ${rights.join(',')} ON public."${name}" TO "${role}"`);
        const columns=plan.updateColumns[name];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(column=>'"'+column+'"').join(',')}) ON public."${name}" TO "${role}"`);}
      const sequences=await f.maintenanceDb.execute<{name:string;table:string}>(sql`SELECT s.relname AS name,t.relname AS "table" FROM pg_catalog.pg_class s JOIN pg_catalog.pg_depend d ON d.objid=s.oid AND d.deptype IN('a','i') JOIN pg_catalog.pg_class t ON t.oid=d.refobjid WHERE s.relkind='S'`);
      for(const item of sequences)if(plan.tables[item.table]?.includes('INSERT'))await f.exec(`GRANT USAGE ON SEQUENCE public."${item.name}" TO "${role}"`);
      await f.exec(`GRANT SELECT,UPDATE ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.store_order,public.store_order_cart_info,public.store_order_refund,public.payment_reconciliation_case TO "${role}"`);
      await f.exec(`GRANT SELECT,INSERT ON public.supplier_order_edit_operation_v1 TO "${role}"; GRANT SELECT ON public.store_order_promotions TO "${role}"; GRANT UPDATE(id) ON public.store_order_promotions TO "${role}"`);
      const realm=kind==='ordinary'?['cashier_ordinary_draft_v1','cashier_ordinary_cart_v1','cashier_ordinary_operation_v1','cashier_ordinary_origin_v1']:['cashier_second_card_cart_v1','cashier_second_card_origin_v1','cashier_second_card_payment_v1'];
      for(const table of realm)await f.exec(`GRANT SELECT ON public.${table} TO "${role}"`);
      const url=new URL(f.connectionString);url.username=role;url.password=secret;
      client=postgres(url.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,
        connection:{options:'-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=3000'}});
      const db=drizzle(client) as unknown as DbClient;
      const [identity]=await db.execute<{direct:boolean;owner:boolean}>(sql`SELECT current_user=session_user AS direct,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS owner`);
      expect(identity).toEqual({direct:true,owner:false});
      return await run(db,new SupplierUnpaidOrderEditService(createContainerFromDb(db),f.env.APP_KEY),role);
    }finally{await client?.end({timeout:5});await f.exec(`DROP OWNED BY "${role}";DROP ROLE "${role}"`);}
  }
  async function http<T>(db:DbClient,method:string,id:number,body?:unknown,operator=21):Promise<Reply<T>>{
    wiring.open.mockImplementation(()=>createContainerFromDb(db));
    const token=(await createToken(operator,'supplier',md5(password),f.env.APP_KEY)).token;
    const response=await app.request('/supplierapi/order/'+(method==='GET'?'edit/':'update/')+id,{method,
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
    return response.json<Reply<T>>();
  }
  async function edit(db:DbClient,id:number,pay:string,points:string,operator=21){
    const seed=await http<Seed>(db,'GET',id,undefined,operator);expect(seed.status,seed.msg).toBe(200);
    const body={...seed.data.values,revision:seed.data.revision,operation_id:randomUUID(),pay_price:pay,gain_integral:points};
    const reply=await http<{state:string;operation_id:string}>(db,'PUT',id,body,operator);expect(reply.status,reply.msg).toBe(200);
    expect(reply.data).toMatchObject({state:'committed',operation_id:body.operation_id});return body;
  }
  async function payAndConsume(id:number){
    await f.cash((await f.actual(id)).order);
    const [paid]=await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,`order.paid:${id}`));expect(paid).toBeTruthy();
    expect(await new OrderOutboxService(f.container,f.env).processMessage({action:'processOrderPaidOutbox',outboxId:paid.id,eventKey:paid.eventKey})).toBe('completed');
  }
  async function redeem(id:number,amount?:number){
    const service=new CustomerWorkWriteoffService(f.container,f.env),scope=await authorizeCustomerWorkActor(f.db,f.actor()),current=await f.actual(id);
    const target=(await service.reader.order(f.actor(),id,{scope_key:scope.scope_key,order_no:current.order.orderId})).data;
    const body={version:CUSTOMER_WRITEOFF_VERSION,scope_key:scope.scope_key,order_id:id,expected_order_revision:target.order_revision,
      expected_writeoff_revision:target.writeoff_revision,payload:{order_no:target.order_no,root_order_id:target.root_order_id,root_order_no:target.root_order_no,
        code:target.code,target_fingerprint:target.target_fingerprint,items:target.carts.filter(row=>row.write_surplus_times>0).map(row=>({cart_row_id:row.cart_row_id,writeoff_num:amount??row.write_surplus_times}))}};
    const context={actor:f.actor(),request_key:randomUUID()},result=await service.execute(context,body);
    expect(result.execution?.verified).toBe(true);return{service,context,body,result};
  }
  async function refundOne(id:number,db:DbClient=f.db){
    const service=new CustomerWorkFinancialService(createContainerFromDb(db),f.env),scope=await authorizeCustomerWorkActor(db,f.actor());
    const input=async(orderId:number,payload:CustomerJson)=>{const current=(await f.actual(orderId)).order,revisions=await financialRevisions(db,current);
      return{version:CUSTOMER_FINANCIAL_VERSION,scope_key:scope.scope_key,order_id:orderId,expected_order_revision:revisions.order_revision,
        expected_financial_revision:revisions.financial_revision,payload};};
    const cart=(await f.actual(id)).carts[0],items=[{cart_row_id:cart.id,cart_num:1}],base=await input(id,{});
    const quote=(await service.reader.quote(f.actor(),{version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:scope.scope_key,order_id:id,
      expected_order_revision:base.expected_order_revision,expected_financial_revision:base.expected_financial_revision,mode:'items',items})).data;
    const created=await service.create({actor:f.actor(),request_key:randomUUID()},await input(id,{mode:'items',items,quoted_price:quote.quoted_price,
      refund_price:quote.quoted_price,quote_fingerprint:quote.quote_fingerprint,reason:'已按修改后实际现金核对退款'}));
    expect(created.receipt?.outcome).toBe('refund-created');const refundId=Number(created.receipt!.evidence.refund_id);
    const [refund]=await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId));
    const review=(await service.reader.review(f.actor(),refundId,{refund_no:refund.orderId})).data;
    const body=await input(review.order_id,{refund_id:refundId,refund_no:review.refund_no,expected_refund_revision:review.refund_revision,
      review_fingerprint:review.review_fingerprint,refund_price:review.refund_price,
      decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false,cash_returned:true}});
    const context={actor:f.actor(),request_key:randomUUID()},completed=await service.execute('refund_execute',context,body);
    expect(completed.execution).toMatchObject({completed:true,verified:true});
    const [partition]=await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,refundId));
    expect(partition.remainingOrderId).toBeGreaterThan(0);return{service,context,body,partition};
  }
  it('preserves the original full origin through cash-only, gift-only and repeated edits by different genuine Supplier actors',async()=>{
    const {order}=await f.create();expect(order.supplierId).toBe(88);const beforeOrigin=await original(),before=await f.actual(order.id);
    await withSupplier(async db=>{
      await edit(db,order.id,'12.00','0');await edit(db,order.id,'12.00','7',22);await edit(db,order.id,'13.00','9');
      expect(await original()).toEqual(beforeOrigin);
      const rows=await f.db.execute<{actor_id:number;evidence:Record<string,unknown>}>(sql`SELECT actor_id,evidence FROM public.supplier_order_edit_operation_v1 ORDER BY evidence->>'status_id'`);
      expect(rows.map(row=>row.actor_id)).toEqual([21,22,21]);
      const current=await f.actual(order.id);for(const [index,row]of current.carts.entries())expect(JSON.parse(row.cartInfo!).product).toEqual(JSON.parse(before.carts[index].cartInfo!).product);
      const [access]=await f.db.execute<{readable:boolean;writable:boolean}>(sql`SELECT has_table_privilege(current_user,'public.supplier_order_edit_operation_v1','SELECT') AS readable,has_table_privilege(current_user,'public.supplier_order_edit_operation_v1','INSERT') AS writable`);
      expect(access).toEqual({readable:true,writable:false});
    });
    await payAndConsume(order.id);const current=await f.actual(order.id);
    expect(current.order).toMatchObject({paid:1,payPrice:'13.00',gainIntegral:'9.00'});
    if(kind==='ordinary')expect((await readCashierOrdinaryPaidOrigin(f.db,current.order,current.carts)).origin_hash).toBe(beforeOrigin[0].origin_hash);
    else{
      expect((await readCashierSecondCardOrigin(f.db,current.order,current.carts))?.origin_hash).toBe(beforeOrigin[0].origin_hash);
      const projected=await new CustomerWorkCashierReadService(f.container,f.env).record(f.actor(),order.id,{order_no:current.order.orderId});
      expect(projected.data.record).toMatchObject({id:order.id,amount:'13.00'});
      expect(current.carts[0].writeStart).toBe(current.order.payTime);
    }
    expect((await manualRefundPaymentFacts(f.db,current.order)).origin_hash).toBe(beforeOrigin[0].origin_hash);
    expect(await original()).toEqual(beforeOrigin);
    if(kind==='second-card'){
      const before=(await f.db.select().from(user).where(eq(user.uid,11)))[0].integral;
      const beforeBills=await f.db.select().from(userBill).orderBy(asc(userBill.id));
      const partial=await redeem(order.id,1);expect(partial.result.execution?.order_completed).toBe(false);
      expect((await f.db.select().from(user).where(eq(user.uid,11)))[0].integral).toBe(before);
      expect(await f.db.select().from(userBill).orderBy(asc(userBill.id))).toEqual(beforeBills);
      const final=await redeem(order.id);expect(final.result.execution?.order_completed).toBe(true);
      expect((await f.db.select().from(user).where(eq(user.uid,11)))[0].integral).toBe(before+9);
      const bills=await f.db.select().from(userBill).orderBy(asc(userBill.id));
      const grants=bills.filter(row=>row.eventKey==='pay_give_integral');expect(grants).toHaveLength(1);
      expect(grants).toMatchObject([{uid:11,linkId:String(order.id),eventKey:'pay_give_integral',type:'gain',
        category:'integral',number:'9.00',balance:(before+9).toFixed(2),pm:1,status:1}]);
      expect((await final.service.execute(final.context,final.body)).replayed).toBe(true);
      expect(await f.db.select().from(userBill).orderBy(asc(userBill.id))).toEqual(bills);expect(await original()).toEqual(beforeOrigin);
    }
  },120000);
  it('refuses a missing origin table or removed origin SELECT before an edited root, line or receipt can commit',async()=>{
    const {order}=await f.create(),before=await state(order.id),table=originTable();
    await withSupplier(async(_db,service,role)=>{
      const seed=await service.seed(order.id,actor()),body={...seed.values,revision:seed.revision,operation_id:randomUUID(),pay_price:'12.00',gain_integral:'7'};
      await f.exec(`ALTER TABLE public.${table} RENAME TO owned_missing_cashier_origin`);
      try{await expect(service.save(order.id,body,actor())).rejects.toMatchObject({httpStatus:503});}finally{await f.exec(`ALTER TABLE public.owned_missing_cashier_origin RENAME TO ${table}`);}
      expect(await state(order.id)).toEqual(before);
      await f.exec(`REVOKE SELECT ON public.${table} FROM "${role}"`);
      await expect(service.save(order.id,body,actor())).rejects.toMatchObject({httpStatus:503});expect(await state(order.id)).toEqual(before);
    });
  },120000);
  it('rejects an unrelated SQL/cart mutation and missing immutable edit proof instead of accepting a marker or an amount bound',async()=>{
    const {order}=await f.create();
    await withSupplier(async db=>{await edit(db,order.id,'12.00','7');});
    const current=await f.actual(order.id),facts=(await original())[0];
    const origin=kind==='ordinary'?JSON.parse(String(facts.origin_json)):facts.origin;
    if(!origin||typeof origin!=='object'||Array.isArray(origin))throw Error('Actual protected origin shape missing');
    const origins=(origin as {cart_facts:Parameters<typeof loadUnpaidOrderCashierEditProof>[3]}).cart_facts;
    await expect(loadUnpaidOrderCashierEditProof(f.db,current.order,current.carts.map((row,index)=>index?row:{...row,settlePrice:'9.99'}),origins,
      kind==='ordinary'?String((origin as {creation_pay_price:string}).creation_pay_price):undefined)).rejects.toThrow();
    await f.exec(`REVOKE SELECT ON public.supplier_order_edit_operation_v1 FROM "${f.role}"`);
    try{await expect(loadUnpaidOrderCashierEditProof(f.db,current.order,current.carts,origins,
      kind==='ordinary'?String((origin as {creation_pay_price:string}).creation_pay_price):undefined)).rejects.toMatchObject({httpStatus:503});}
    finally{await f.exec(`GRANT SELECT ON public.supplier_order_edit_operation_v1 TO "${f.role}"`);}
    expect(await original()).toEqual([facts]);
  },120000);
  it('refuses a missing protected predecessor before a new edit and rolls back every proposed business effect',async()=>{
    const {order}=await f.create();
    await withSupplier(async(db,service)=>{
      const first=await edit(db,order.id,'12.00','7');await edit(db,order.id,'13.00','9',22);
      const seed=await service.seed(order.id,actor()),body={...seed.values,revision:seed.revision,operation_id:randomUUID(),pay_price:'11.00',gain_integral:'8'};
      // Explicit owned corruption proves absence is rejected. Runtime retains
      // SELECT/INSERT only and cannot remove its own protected predecessor.
      await f.exec('ALTER TABLE public.supplier_order_edit_operation_v1 DISABLE TRIGGER USER');
      try{await f.maintenanceDb.execute(sql`DELETE FROM public.supplier_order_edit_operation_v1 WHERE operation_id=${first.operation_id}::uuid`);}
      finally{await f.exec('ALTER TABLE public.supplier_order_edit_operation_v1 ENABLE TRIGGER USER');}
      const before=await state(order.id);await expect(service.save(order.id,body,actor())).rejects.toThrow();expect(await state(order.id)).toEqual(before);
    });
  },120000);
  it('executes a real cash refund and proves its physical remainder through the original edited purchase',async()=>{
    const {order}=await f.create(),beforeOrigin=await original();
    await withSupplier(async db=>{await edit(db,order.id,'12.00','7');await edit(db,order.id,'13.00','9',22);});
    await payAndConsume(order.id);const completed=await refundOne(order.id,financialDb??f.db),remaining=await f.actual(completed.partition.remainingOrderId!);
    expect(remaining.order.supplierId).toBe(88);expect(remaining.order.gainIntegral).toBe(kind==='second-card'?'5.00':'6.00');
    if(kind==='second-card')expect((await readCashierSecondCardOrigin(f.db,remaining.order,remaining.carts))?.origin_hash).toBe(beforeOrigin[0].origin_hash);
    expect((await completed.service.status(f.actor(),completed.context.request_key)).execution).toMatchObject({completed:true,verified:true});
    const bills=await f.db.select().from(userBill).orderBy(asc(userBill.id));
    expect((await completed.service.execute('refund_execute',completed.context,completed.body)).replayed).toBe(true);
    expect(await f.db.select().from(userBill).orderBy(asc(userBill.id))).toEqual(bills);expect(await original()).toEqual(beforeOrigin);
  },120000);
});
