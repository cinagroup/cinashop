import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {financePostgres} from './helpers/financePostgres';
import {storeCart,storeOrder,storeOrderCartInfo} from '../src/models/schema';
import {runCashierOrdinary,inspectCashierOrdinary,cashierOrdinaryReadiness,CASHIER_ORDINARY_CATALOG_SHA256,CASHIER_ORDINARY_CATALOG_SQL} from '../src/migrations/runCashierOrdinary';

/** Drizzle preserves the native PG error as cause; the outer query wrapper is
 * intentionally not the database policy error. Assert the exact real policy. */
async function rejectsNativePolicy(action:()=>Promise<unknown>,message:string){
 let caught:unknown;try{await action();}catch(error){caught=error;}
 expect(caught).toBeDefined();let current=caught;
 const visited=new Set<unknown>();
 while(current&&typeof current==='object'&&!visited.has(current)){
  visited.add(current);const error=current as {code?:unknown;message?:unknown;cause?:unknown};
  if(error.code==='P0001'){expect(error.message).toBe(message);return;}
  current=error.cause;
 }
 throw Error('The native PG P0001 policy refusal was not found in the preserved error chain');
}

/** Exact fresh, registered, owned native PG16 source tables. These cases only
 * certify the new maintenance/catalog boundary, never checkout readiness. */
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('ordinary cashier literal native PG16 catalog',()=>{
 let f:Awaited<ReturnType<typeof financePostgres>>;
 beforeAll(async()=>{f=await financePostgres([storeCart,storeOrder,storeOrderCartInfo],{namespace:'public'});await runCashierOrdinary(f.db);},180000);
 afterAll(async()=>{await f?.close();},30000);
 it('records the independently generated literal DDL fingerprint and remains closed for maintenance identity',async()=>{
  const catalog=await inspectCashierOrdinary(f.db),shape=await f.db.execute(sql.raw(CASHIER_ORDINARY_CATALOG_SQL));
  console.log('ORDINARY_CASHIER_LITERAL_PG16_CATALOG '+JSON.stringify({fingerprint:catalog.fingerprint,shape:shape[0],commissionedPin:CASHIER_ORDINARY_CATALOG_SHA256}));
  expect(catalog.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(catalog.complete).toBe(/^[a-f0-9]{64}$/.test(CASHIER_ORDINARY_CATALOG_SHA256));
  expect((await cashierOrdinaryReadiness(f.db)).ready).toBe(false);
  const[count]=await f.db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM public.cashier_ordinary_operation_v1`);expect(count.n).toBe(0);
 });
 it('rejects UPDATE, DELETE, TRUNCATE even on the real table owner and refuses reinstall',async()=>{
  const original=await inspectCashierOrdinary(f.db);
  for(const statement of ['UPDATE public.cashier_ordinary_draft_v1 SET buyer_uid=buyer_uid','DELETE FROM public.cashier_ordinary_origin_v1','TRUNCATE public.cashier_ordinary_operation_v1']){
    await rejectsNativePolicy(()=>f.db.execute(sql.raw(statement)),'ordinary cashier source and operation receipts are append-only');
    expect(await inspectCashierOrdinary(f.db)).toEqual(original);
  }
  await rejectsNativePolicy(()=>runCashierOrdinary(f.db),'Existing ordinary cashier protocol requires exact review; no reinstall');
  expect(await inspectCashierOrdinary(f.db)).toEqual(original);
  const[count]=await f.db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM public.cashier_ordinary_operation_v1`);expect(count.n).toBe(0);
 });
 it('detects a disabled real trigger even though table, constraint and trigger counts are unchanged',async()=>{
  const original=await inspectCashierOrdinary(f.db);
  await f.db.execute(sql`ALTER TABLE public.cashier_ordinary_origin_v1 DISABLE TRIGGER cashier_ordinary_origin_v1_append_only`);
  try{const changed=await inspectCashierOrdinary(f.db);expect(changed.fingerprint).not.toBe(original.fingerprint);expect(changed.complete).toBe(false);}
  finally{await f.db.execute(sql`ALTER TABLE public.cashier_ordinary_origin_v1 ENABLE TRIGGER cashier_ordinary_origin_v1_append_only`);}
  expect((await inspectCashierOrdinary(f.db)).fingerprint).toBe(original.fingerprint);
 });
});
