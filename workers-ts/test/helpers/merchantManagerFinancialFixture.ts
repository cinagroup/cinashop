import { is,sql } from 'drizzle-orm';
import { PgTable,getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../src/models/schema';
import { createContainerFromDb } from '../../src/lib/di';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { installManagerScopeLock } from '../../src/migrations/runManagerScopeLock';
import { inspectCheckoutPricingLock } from '../../src/migrations/checkoutPricingLock';
import { pricingCatalogReady } from '../../src/migrations/checkoutPricingLockCatalog';
import { runInvoiceEvidence } from '../../src/migrations/runInvoiceEvidence';
import { runRefundOrderSplit } from '../../src/migrations/runRefundOrderSplit';
import { adminRefundEvidenceFixture } from './adminRefundEvidenceFixture';
import { createMerchantManagerRuntime } from './merchantManagerRuntime';

/** Actual constrained application LOGIN on the registered newly owned PG16
 * database. The Admin rows in the historical fixture are never granted to it.
 * Each permitted table/column/sequence comes from the current application plan. */
export async function merchantManagerFinancialFixture(){
 const f=await adminRefundEvidenceFixture(undefined,[schema.systemStoreStaff,schema.userBrokerage,schema.paymentReconciliationCase,schema.printDocument,schema.orderWaybillJob,schema.supplierExtract,schema.supplierTransactions,schema.supplierFlowingWater,schema.systemUserLevel,schema.storeCouponIssue,schema.storeSeckill,schema.storeBargain,schema.storeCombination,schema.storeProductLog,schema.storeConfig,schema.storePink,schema.deliveryService]);
 let runtime:Awaited<ReturnType<typeof createMerchantManagerRuntime>>|undefined;
 const close=async()=>{try{await runtime?.close();}finally{await f.close();}};
 try{
  const migration=await import('drizzle-kit/api');const invoiceSql=await migration.generateMigration(migration.generateDrizzleJson({}),migration.generateDrizzleJson({storeOrderInvoice:schema.storeOrderInvoice}));for(const statement of invoiceSql)if(statement.trim().startsWith('CREATE INDEX'))await f.exec(statement);
  const {runManagerOrderOperation}=await import('../../src/migrations/runManagerOrderOperation');await runManagerOrderOperation(f.db);
  const rows=await f.db.execute<{name:string}>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`),names=new Set(rows.map(row=>row.name)),plan=runtimeBusinessPrivilegePlan('app');
  const tables=(Object.values(schema) as unknown[]).filter((value):value is PgTable=>is(value,PgTable)).filter(table=>{const name=getTableConfig(table).name;return names.has(name)&&plan.tables[name]?.includes('SELECT');});
  runtime=await createMerchantManagerRuntime(f.db,tables,{installLockProtocol:async(owner,role)=>{
   const lockOwner=`manager_scope_${crypto.randomUUID().replaceAll('-','')}`;
   await owner.execute(sql.raw(`CREATE ROLE "${lockOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
   let installed=false;
   const cleanup=async()=>{if(installed)await owner.execute(sql.raw('DROP FUNCTION public.manager_lock_scope_v1(integer,integer); DROP FUNCTION public.manager_lock_carrier_v1(text)'));await owner.execute(sql.raw(`DROP OWNED BY "${lockOwner}"; DROP ROLE "${lockOwner}"`));};
   try{await installManagerScopeLock(owner,lockOwner);installed=true;
    await owner.execute(sql.raw(`GRANT EXECUTE ON FUNCTION public.manager_lock_scope_v1(integer,integer),public.manager_lock_carrier_v1(text) TO "${role}"`));
    if(!pricingCatalogReady(await inspectCheckoutPricingLock(owner)))throw Error('Actual checkout lock catalog is unreviewed');
    await owner.execute(sql.raw(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${role}"`));
    return cleanup;
   }catch(error){await cleanup();throw error;}
  }});
  await runInvoiceEvidence(f.db,runtime.role);await runRefundOrderSplit(f.db,runtime.role);
  return{...f,close,runtime,container:createContainerFromDb(runtime.db),ownerContainer:f.container};
 }catch(error){await close();throw error;}
}
