import { asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { assertSupplierProactiveRefundReady } from '@/migrations/supplierProactiveRefund';
import { lockAtomicRefundOrder } from '@/services/order/RefundAtomicMaterialization';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { assertSupplierVideoAuthority, type SupplierVideoActor } from './SupplierVideoAuthority';
import { readSupplierProactiveRefundSource } from './SupplierProactiveRefundSource';
import { parseSupplierProactiveRefundIntent, assertSupplierProactiveRefundCash, supplierProactiveRefundConflict, type SupplierProactiveRefundIntent } from './SupplierProactiveRefundInput';

type Order=typeof storeOrder.$inferSelect;type Cart=typeof storeOrderCartInfo.$inferSelect;
type Context={phase:'quote'}|{phase:'application'|'execution';intent:SupplierProactiveRefundIntent;hash:string};
export interface SupplierProactiveRefundAuthorization {
  readonly phase:'quote'|'application'|'execution';readonly sourceHash:string;
  readonly operationId:string|null;readonly requestHash:string|null;readonly intent:SupplierProactiveRefundIntent|null;
}
interface Transaction extends Record<string,unknown> {transaction_id:string;backend_id:number}
declare const brand:unique symbol;
export type SupplierProactiveRefundApplicationCapability={readonly[brand]:true};
const states=new WeakMap<object,{actor:SupplierVideoActor;orderId:number;transaction:Transaction;authorization:SupplierProactiveRefundAuthorization}>();
const fact=(condition:unknown):void=>{if(!condition)throw supplierProactiveRefundConflict('主动退款能力与当前真实事务、经营身份或完整来源不一致');};
async function transaction(tx:DbClient) {
  fact(!Object.hasOwn(tx,'$client'));
  const [row]=await tx.execute<Transaction>(sql`SELECT txid_current()::text AS transaction_id,pg_backend_pid() AS backend_id`);
  fact(row&&/^[1-9][0-9]*$/.test(row.transaction_id)&&Number.isSafeInteger(row.backend_id)&&row.backend_id>0);return row;
}
async function authority(tx:DbClient,actor:SupplierVideoActor) {
  await tx.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_supplier,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  await assertSupplierVideoAuthority(tx,actor,'supplier.order.manage');
}
export async function prepareSupplierProactiveRefundApplication(tx:DbClient,actorValue:SupplierVideoActor,orderValue:Order,context:Context) {
  // Detach every caller-owned identity/intent before the first await. A later
  // source reread must never bless a request replaced while SQL was pending.
  const actor=Object.freeze({...actorValue}),order=Object.freeze({...orderValue}),phase=context.phase;
  fact(['quote','application','execution'].includes(phase));
  let intent:SupplierProactiveRefundIntent|null=null,requestHash:string|null=null;
  if(context.phase!=='quote') {
    const p=Object.freeze({...context.intent}),hash=context.hash;
    const parsed=await parseSupplierProactiveRefundIntent(order.id,{operation_id:p.operation_id,revision:p.revision,refund_price:p.refund_price,type:p.type,
      ...(Object.hasOwn(p,'cash_returned')?{cash_returned:p.cash_returned}:{})},actor);
    fact(parsed.hash===hash&&parsed.hash===await outRequestHash(p)&&p.type===1);
    intent=parsed.intent;requestHash=parsed.hash;
  }
  const identity=await transaction(tx);
  await authority(tx,actor);await assertSupplierProactiveRefundReady(tx);
  const locked=await lockAtomicRefundOrder(tx,order.id);
  fact(order.supplierId===actor.supplierId&&await outRequestHash(locked)===await outRequestHash(order));
  const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201).for('update');
  const sourceHash=await outRequestHash(await readSupplierProactiveRefundSource(tx,locked,carts));
  if(intent)assertSupplierProactiveRefundCash(intent,intent.refund_price==='0.00'?'zero':
    ['cash','offline'].includes(locked.payType)?'cash':locked.payType==='yue'?'balance':locked.payType==='integral'?'zero':'provider');
  const authorization=Object.freeze({phase,sourceHash,operationId:intent?.operation_id??null,requestHash,intent});
  const cap=Object.freeze({}) as SupplierProactiveRefundApplicationCapability;
  await assertSupplierVideoAuthority(tx,actor,'supplier.order.manage');
  states.set(cap,{actor,orderId:order.id,transaction:identity,authorization});return cap;
}
export async function assertSupplierProactiveRefundAuthority(tx:DbClient,cap:SupplierProactiveRefundApplicationCapability,order:Order) {
  const state=states.get(cap);fact(state&&state.orderId===order.id&&state.actor.supplierId===order.supplierId);
  if(!state)throw supplierProactiveRefundConflict();
  const current=await transaction(tx);fact(current.transaction_id===state.transaction.transaction_id&&current.backend_id===state.transaction.backend_id);
  await authority(tx,state.actor);await assertSupplierProactiveRefundReady(tx);return state.authorization;
}
export async function authorizeSupplierProactiveRefundApplication(tx:DbClient,cap:SupplierProactiveRefundApplicationCapability,order:Order,carts:Cart[]) {
  const authorization=await assertSupplierProactiveRefundAuthority(tx,cap,order);
  fact(authorization.sourceHash===await outRequestHash(await readSupplierProactiveRefundSource(tx,order,carts)));return authorization;
}
