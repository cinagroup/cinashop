import {describe,it,expect} from 'vitest';
import {CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION,parseCustomerManualOfflineOrigin} from '../src/services/order/CustomerManualOfflineOrigin';
import {outRequestHash} from '../src/services/out/OutIdempotency';
import {customerManualManagerOriginReadiness,customerManualManagerOriginReadGrantSql} from '../src/migrations/customerManualOfflineOriginCatalog';
const version=CUSTOMER_MANUAL_OFFLINE_ORIGIN_VERSION;
async function manager(staff_id=901){
 const intent={version:'merchant-order-operation-v1',store_id:1,order_id:7,scope_key:'a'.repeat(64),expected_order_revision:'b'.repeat(64),payload:{}};
 const receipt={actor_uid:401,request_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',request_hash:await outRequestHash({version:intent.version,actor_uid:401,kind:'confirm_offline',input:intent}),store_id:1,staff_id,order_id:7,kind:'confirm_offline',outcome:'offline-paid',scope_key:intent.scope_key,expected_revision:intent.expected_order_revision,intent,evidence:{order_id:7,outbox_id:12},created_at:'2026-10-12T01:02:03.456789Z'};
 return{version,kind:'manager_order_offline',primary_audit_id:9,actor_uid:401,receipt};
}
describe('versioned manual offline original payment evidence',()=>{
 it('round trips the complete original manager intent and exact microsecond timestamp through JSON',async()=>{
  const original=await manager();expect(await parseCustomerManualOfflineOrigin(JSON.parse(JSON.stringify(original)))).toEqual(original);
  expect(await parseCustomerManualOfflineOrigin(await manager(0))).toMatchObject({receipt:{staff_id:0}});
  const differentClock={...original,receipt:{...original.receipt,created_at:'1999-01-01T00:00:00.000001Z'}};
  expect(await parseCustomerManualOfflineOrigin(differentClock)).toEqual(differentClock);
 });
 it('keeps the admin source explicit without inventing an operator UUID receipt',async()=>{
  const source={version,kind:'admin_order_offline',primary_audit_id:9,admin_id:801};expect(await parseCustomerManualOfflineOrigin(source)).toEqual(source);
  for(const extra of[{receipt:{}},{actor_uid:801},{request_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}])await expect(parseCustomerManualOfflineOrigin({...source,...extra})).rejects.toThrow();
 });
 it('refuses actor, store, root, revision, evidence and original request hash contradictions',async()=>{
  const original=await manager();
  for(const change of[{actor_uid:402},{store_id:2},{order_id:8},{scope_key:'c'.repeat(64)},{expected_revision:'c'.repeat(64)},{request_hash:'c'.repeat(64)},{kind:'refund_execute'},{outcome:'abandoned'},{staff_id:-1},{request_key:original.receipt.request_key.toUpperCase()},{evidence:{order_id:7,outbox_id:null}},{evidence:{order_id:8,outbox_id:12}},{evidence:{order_id:7,outbox_id:12,forged:true}},{intent:{...original.receipt.intent,payload:{fake:true}}}])await expect(parseCustomerManualOfflineOrigin({...original,receipt:{...original.receipt,...change}})).rejects.toThrow();
  await expect(parseCustomerManualOfflineOrigin({...original,actor_uid:402})).rejects.toThrow();
 });
 it('refuses unknown versions, extra fields, noncanonical timestamps and invalid admin identities',async()=>{
  const original=await manager();
  for(const created_at of[new Date(),null,'2026-10-12T01:02:03.456Z','2026-02-30T01:02:03.456789Z','2026-10-12T01:02:03.456789+00:00'])await expect(parseCustomerManualOfflineOrigin({...original,receipt:{...original.receipt,created_at}})).rejects.toThrow();
  for(const source of[{...original,version:'v3'},{...original,extra:true},{version,kind:'admin_order_offline',primary_audit_id:9,admin_id:0},{version,kind:'admin_order_offline',primary_audit_id:0,admin_id:801},{version,kind:'offline',primary_audit_id:9,admin_id:801}])await expect(parseCustomerManualOfflineOrigin(source)).rejects.toThrow();
 });
 it('reports an absent manager realm as unavailable before reading its rows and compiles only a fixed SELECT grant',async()=>{
  let calls=0;const state=await customerManualManagerOriginReadiness({execute:async()=>{calls++;return[];}} as never);
  expect(state.ready).toBe(false);expect(state.reason).toBe('customer_manual_manager_origin_not_installed');expect(calls).toBe(1);
  expect(customerManualManagerOriginReadGrantSql('actual_customer_login')).toBe('GRANT SELECT ON TABLE public.manager_order_operation_request TO "actual_customer_login";');
  expect(()=>customerManualManagerOriginReadGrantSql('unsafe;DROP ROLE x')).toThrow();
 });
});
