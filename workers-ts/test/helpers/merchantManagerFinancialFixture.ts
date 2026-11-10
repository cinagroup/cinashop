import { is,sql } from 'drizzle-orm';
import { PgDialect,PgTable,getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../src/models/schema';
import { createContainerFromDb } from '../../src/lib/di';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { installManagerScopeLock } from '../../src/migrations/runManagerScopeLock';
import { inspectCheckoutPricingLock } from '../../src/migrations/checkoutPricingLock';
import { pricingCatalogReady } from '../../src/migrations/checkoutPricingLockCatalog';
import { runInvoiceEvidence } from '../../src/migrations/runInvoiceEvidence';
import { runRefundOrderSplit } from '../../src/migrations/runRefundOrderSplit';
import { PAYMENT_CALLBACK_PIPELINE_SQL } from '../../src/migrations/paymentCallbackPipeline';
import { PAYMENT_RECONCILIATION_SQL } from '../../src/migrations/paymentReconciliation';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '../../src/migrations/routinePaymentAttempt';
import { installLocalPaymentCaseLock } from '../../src/migrations/localPaymentCaseLock';
import { adminRefundEvidenceFixture } from './adminRefundEvidenceFixture';
import { createManagerFinancialRuntime } from './managerRuntimePrivilegeFixture';

/** Actual constrained application LOGIN on the registered newly owned PG16
 * database. The Admin rows in the historical fixture are never granted to it.
 * Each permitted table/column/sequence comes from the current application plan. */
export async function merchantManagerFinancialFixture(){
 const f=await adminRefundEvidenceFixture(undefined,[schema.systemStoreStaff,schema.userBrokerage,schema.printDocument,schema.orderWaybillJob,schema.supplierExtract,schema.supplierTransactions,schema.supplierFlowingWater,schema.systemUserLevel,schema.storeCouponIssue,schema.storeSeckill,schema.storeBargain,schema.storeCombination,schema.storeProductLog,schema.storeConfig,schema.storePink,schema.deliveryService]);
 let runtime:Awaited<ReturnType<typeof createManagerFinancialRuntime>>|undefined;
 const close=async()=>{try{await runtime?.close();}finally{await f.close();}};
 try{
  // The inherited read fixture omits SQL CHECKs and payment protocol storage.
  // Install the unchanged definitions before exercising real settlement. The
  // historical outbox generation remains inactive for success notifications.
  const dialect=new PgDialect();
  for(const check of getTableConfig(schema.storeOrderOutbox).checks)
   await f.exec(`ALTER TABLE public.store_order_outbox ADD CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`);
  await f.exec(PAYMENT_CALLBACK_PIPELINE_SQL+PAYMENT_RECONCILIATION_SQL+ROUTINE_PAYMENT_ATTEMPT_SQL);
  const migration=await import('drizzle-kit/api');const invoiceSql=await migration.generateMigration(migration.generateDrizzleJson({}),migration.generateDrizzleJson({storeOrderInvoice:schema.storeOrderInvoice}));for(const statement of invoiceSql)if(statement.trim().startsWith('CREATE INDEX'))await f.exec(statement);
  const {runManagerOrderOperation}=await import('../../src/migrations/runManagerOrderOperation');await runManagerOrderOperation(f.db);
  const rows=await f.db.execute<{name:string}>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`),names=new Set(rows.map(row=>row.name)),plan=runtimeBusinessPrivilegePlan('app');
  const tables=(Object.values(schema) as unknown[]).filter((value):value is PgTable=>is(value,PgTable)).filter(table=>{const name=getTableConfig(table).name;return names.has(name)&&plan.tables[name]?.includes('SELECT');});
  runtime=await createManagerFinancialRuntime(f.db,tables,{installLockProtocol:async(owner,role)=>{
   const lockOwner=`manager_scope_${crypto.randomUUID().replaceAll('-','')}`,
    caseLockOwner=`manager_case_${crypto.randomUUID().replaceAll('-','')}`,created:string[]=[];
   let installed=false;
   const cleanup=async()=>{if(installed)await owner.execute(sql.raw('DROP FUNCTION public.manager_lock_scope_v1(integer,integer); DROP FUNCTION public.manager_lock_carrier_v1(text)'));for(const name of created)await owner.execute(sql.raw(`DROP OWNED BY "${name}"; DROP ROLE "${name}"`));};
   try{
    for(const name of [lockOwner,caseLockOwner]){
     await owner.execute(sql.raw(`CREATE ROLE "${name}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));created.push(name);
    }
    await installManagerScopeLock(owner,lockOwner);installed=true;
    await owner.execute(sql.raw(`GRANT EXECUTE ON FUNCTION public.manager_lock_scope_v1(integer,integer),public.manager_lock_carrier_v1(text) TO "${role}"`));
    if(!pricingCatalogReady(await inspectCheckoutPricingLock(owner)))throw Error('Actual checkout lock catalog is unreviewed');
    await owner.execute(sql.raw(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${role}"`));
    // Match the Manager payment addon: SELECT-only evidence, with row locking
    // delegated to its audited NOLOGIN capability instead of granting UPDATE.
    await owner.execute(sql.raw(`GRANT SELECT ON public.routine_payment_attempt,public.payment_reconciliation_action,public.payment_reconciliation_case TO "${role}"`));
    const [identity]=await owner.execute<{database:string;maintenance:string}>(sql`SELECT current_database() AS database,current_user AS maintenance`);
    if(!identity)throw Error('Owned Manager payment maintenance identity missing');
    await owner.transaction(tx=>installLocalPaymentCaseLock(tx,{...identity,owner:caseLockOwner,runtimeRoles:[role]}),{isolationLevel:'read committed',accessMode:'read write'});
    return cleanup;
   }catch(error){await cleanup();throw error;}
  }});
  await runInvoiceEvidence(f.db,runtime.role);await runRefundOrderSplit(f.db,runtime.role);
  return{...f,close,runtime,container:createContainerFromDb(runtime.db),ownerContainer:f.container};
 }catch(error){await close();throw error;}
}
