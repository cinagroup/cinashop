import {describe,it,expect} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {URL} from 'node:url';
import {CUSTOMER_FINANCIAL_INTENT_BODY,CUSTOMER_FINANCIAL_EVIDENCE_BODY} from '../src/migrations/customerFinancialOperation';
import {CUSTOMER_MANUAL_REFUND_INTENT_BODY,CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY,CUSTOMER_MANUAL_REFUND_INSTALLATION_SQL} from '../src/migrations/customerManualRefund';
import {customerManualRefundRuntimePrivilegePlan,customerManualRefundRuntimeGrantSql,customerManualRefundPromotionGrantSql} from '../src/migrations/customerManualRefundRuntimePlan';
import {customerManualRefundReadiness,CUSTOMER_MANUAL_REFUND_CATALOG_SQL} from '../src/migrations/runCustomerManualRefund';
import {financialDecision} from '../src/services/customer-work/CustomerWorkFinancialProtocol';
import {REFUND_ENTITY_CATALOG_PROFILES,refundEntityCatalogProfile} from '../src/migrations/guestRefundEntityCatalog';
import {CUSTOMER_MANUAL_GUEST_IDENTITY_CONSTRAINTS} from '../src/migrations/customerManualRefundGuestIdentity';
import {CUSTOMER_ROW_REFUND_VERSION,MATERIALIZED_REFUND_VERSION,readRefundQuantityReservation} from '../src/services/order/RefundQuantityReservation';
import {refundOrderSplitFingerprint} from '../src/services/order/RefundOrderSplitIdentity';
const decision={refund_id:1,refund_no:'actual-refund',expected_refund_revision:'a'.repeat(64),review_fingerprint:'b'.repeat(64),decision:{apply_type:4,refund_type:0,received:false},refund_price:'7.00'};
describe('additive ordinary manual cash refund protocol',()=>{
 it('accepts one complete entity catalog generation and refuses every four-table hybrid or uncommissioned profile',()=>{
  const legacy=new Map(Object.entries(REFUND_ENTITY_CATALOG_PROFILES.legacy));expect(refundEntityCatalogProfile(legacy)).toBe('legacy');
  const guest=new Map(Object.entries(REFUND_ENTITY_CATALOG_PROFILES.guest));expect(refundEntityCatalogProfile(guest)).toBe([...guest.values()].every(pin=>/^[a-f0-9]{64}$/.test(pin))?'guest':'drift');
  for(const part of CUSTOMER_MANUAL_GUEST_IDENTITY_CONSTRAINTS){const mixed=new Map<string,string>(legacy);mixed.set(part.table,REFUND_ENTITY_CATALOG_PROFILES.guest[part.table as keyof typeof REFUND_ENTITY_CATALOG_PROFILES.guest]);expect(refundEntityCatalogProfile(mixed)).toBe('drift');}
  const deleted=new Map<string,string>(legacy);deleted.delete('capture_invoice_evidence');expect(refundEntityCatalogProfile(deleted)).toBe('drift');
 });
 it('allows accountless buyer zero only under the server-selected physical-row refund reservation and split identity',async()=>{
  const item={rowId:1,cartId:1,cartNum:1,beforeRefundNum:0,totalNum:2,sourceCartId:'immutable-opaque'},selection={cartId:1,cartNum:1,sourceCartId:'immutable-opaque'};
  const row={id:1,storeOrderId:7,uid:0,supplierId:0,storeId:1,orderId:'actual-guest-refund',refundPrice:'7.00',refundNum:1,cartInfo:JSON.stringify({cartIds:[selection],quantityReservation:{version:CUSTOMER_ROW_REFUND_VERSION,orderId:7,uid:0,items:[item]}})};
  expect(readRefundQuantityReservation(row)).toMatchObject({version:CUSTOMER_ROW_REFUND_VERSION,uid:0});expect(await refundOrderSplitFingerprint(row)).toMatch(/^[a-f0-9]{64}$/);
  for(const version of['refund-quantity-reservation-v1',MATERIALIZED_REFUND_VERSION]){const{sourceCartId:_source,...oldItem}=item,{sourceCartId:_key,...oldSelection}=selection,old={...row,cartInfo:JSON.stringify({cartIds:[oldSelection],quantityReservation:{version,orderId:7,uid:0,items:[oldItem]}})};expect(()=>readRefundQuantityReservation(old)).toThrow();await expect(refundOrderSplitFingerprint(old)).rejects.toThrow();}
 });
 it('retains historical SQL and changes only execution decision and new evidence arms',()=>{
  const first=CUSTOMER_FINANCIAL_INTENT_BODY.indexOf(" WHEN 'refund_execute'"),last=CUSTOMER_FINANCIAL_INTENT_BODY.indexOf(" WHEN 'refund_remark'",first);
  expect(CUSTOMER_MANUAL_REFUND_INTENT_BODY.slice(0,first)).toBe(CUSTOMER_FINANCIAL_INTENT_BODY.slice(0,first));
  expect(CUSTOMER_MANUAL_REFUND_INTENT_BODY.endsWith(CUSTOMER_FINANCIAL_INTENT_BODY.slice(last))).toBe(true);
  expect(CUSTOMER_MANUAL_REFUND_INTENT_BODY.slice(first)).toContain("['apply_type','refund_type','received','cash_returned']".replace('[','ARRAY['));
  expect(CUSTOMER_MANUAL_REFUND_INTENT_BODY).toContain("->'cash_returned'='true'::jsonb");
  expect(CUSTOMER_FINANCIAL_INTENT_BODY).not.toContain('cash_returned');
  expect(CUSTOMER_FINANCIAL_EVIDENCE_BODY).not.toContain('cash-settled');
  expect(CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY).toContain("WHEN $2='cash-settled'");
  expect(CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY).toContain("WHEN $2='zero-settled'");
  expect(CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY).toContain("!~ '^[1-9][0-9]{0,9}$'");
  expect(CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY).toContain("!~ '^(0|[1-9][0-9]{0,9})$'");
  expect(CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY).toContain("~ '^[a-f0-9]{64}$'");
  expect(CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY.match(/WHEN \$2='provider-admitted'/g)).toHaveLength(1);
  expect(CUSTOMER_MANUAL_REFUND_EVIDENCE_BODY).toContain("->'cash_returned'='true'::jsonb AND $2<>'cash-settled' THEN false");
 });
 it('accepts explicit true only for positive execution and retains old bodies',()=>{
  expect(financialDecision('refund_execute',decision).decision).not.toHaveProperty('cash_returned');
  expect(financialDecision('refund_execute',{...decision,decision:{...decision.decision,cash_returned:true}}).decision.cash_returned).toBe(true);
  for(const flag of[false,0,'true',null])expect(()=>financialDecision('refund_execute',{...decision,decision:{...decision.decision,cash_returned:flag}})).toThrow();
  expect(()=>financialDecision('refund_execute',{...decision,refund_price:'0.00',decision:{...decision.decision,cash_returned:true}})).toThrow();
  const {refund_price:_price,...other}=decision;
  expect(()=>financialDecision('refund_return',{...other,decision:{apply_type:2,refund_type:0,received:false,cash_returned:true}})).toThrow();
 });
 it('bounds promotion deletion to current transaction physical source and keeps runtime append only',()=>{
  const plan=customerManualRefundRuntimePrivilegePlan();expect(plan.tables.customer_financial_manual_refund_v1).toEqual(['SELECT','INSERT']);
  expect(plan.tables.store_order_promotions??[]).not.toContain('DELETE');
  expect(plan.tables.store_order_promotions).toEqual(['SELECT','INSERT']);expect(plan.updateColumns.store_order_promotions).toEqual(['id']);
  const first=customerManualRefundPromotionGrantSql('actual_customer_login',[{name:'store_order_promotions_id_seq',table:'store_order_promotions'}]).join('\n');expect(first).toContain('Cashier promotion lock guard must be verified before UPDATE(id) grant');expect(first).toContain('UPDATE(id)');expect(first).toContain('GRANT USAGE ON SEQUENCE');
  const grants=customerManualRefundRuntimeGrantSql('actual_customer_login',[]).join('\n');expect(grants).toContain('customer_manual_refund_promotion_delete_v1');expect(grants).not.toMatch(/GRANT DELETE ON[^\n]*store_order_promotions/);
  expect(()=>customerManualRefundRuntimeGrantSql('unsafe;DROP ROLE x',[])).toThrow();
  expect(CUSTOMER_MANUAL_REFUND_INSTALLATION_SQL).toContain('saved.transaction_id<>pg_catalog.txid_current()');
  expect(CUSTOMER_MANUAL_REFUND_INSTALLATION_SQL).toContain("actual IS DISTINCT FROM saved.source->'promotion_rows'");
  expect(CUSTOMER_MANUAL_REFUND_INSTALLATION_SQL).toContain('r.refunded_price=r.refund_price');
  expect(CUSTOMER_MANUAL_REFUND_INSTALLATION_SQL).toContain('DELETE FROM public.store_order_promotions WHERE oid=$2');
  expect(CUSTOMER_MANUAL_REFUND_CATALOG_SQL).toContain("'argument_modes'");expect(CUSTOMER_MANUAL_REFUND_CATALOG_SQL).toContain("'promotion_function'");
 });
 it('refuses writes when new ledger is absent without falling back to older financial readiness',async()=>{
  let calls=0;const db={execute:async()=>{calls++;return[];}};
  const result=await customerManualRefundReadiness(db as never);expect(result.ready).toBe(false);expect(result.reason).toBe('customer_manual_refund_not_installed');expect(calls).toBe(1);
 });
 it('ships explicit candidate owner SQL without registering or rewriting historical migrations',()=>{
  const ddl=readFileSync(new URL('../src/migrations/maintenance/0180_customer_manual_refund.sql',import.meta.url),'utf8');expect(ddl.endsWith(CUSTOMER_MANUAL_REFUND_INSTALLATION_SQL)).toBe(true);
  expect(existsSync(new URL('../migrations/0180_customer_manual_refund.sql',import.meta.url))).toBe(false);
  const migrations=readFileSync(new URL('../src/services/MigrationService.ts',import.meta.url),'utf8');expect(migrations).not.toContain('CUSTOMER_MANUAL_REFUND');
 });
});
