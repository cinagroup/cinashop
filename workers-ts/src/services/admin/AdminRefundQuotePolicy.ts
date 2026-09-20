import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrderCartInfo, systemConfig } from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { normalizeConfigScalar } from '@/utils/config';
import { outRequestHash } from '@/services/out/OutIdempotency';
import type { OrderRefundApplicationQuote } from '@/services/order/StoreOrderRefundService';

export async function limitAdminRefundQuoteTransaction(tx:DbClient) {
  if(Object.hasOwn(tx,'$client'))throw Error('Refund policy requires a transaction');
  await tx.execute(sql`SET LOCAL row_security = off`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text || 'ms',true)`);
}

/** Read the global authority directly after the order lock, never CONFIG_KV.
 * Match SystemConfigDao's sort/id precedence and the PHP missing/blank=0
 * default. NOWAIT avoids a config-writer/order-lock cycle. */
export async function lockAdminRefundWindow(tx:DbClient):Promise<number> {
  if(Object.hasOwn(tx,'$client'))throw Error('Refund policy requires a transaction');
  const rows=await tx.select({value:systemConfig.value}).from(systemConfig)
    .where(and(eq(systemConfig.isStore,0),eq(systemConfig.menuName,'refund_time_available')))
    .orderBy(desc(systemConfig.sort),desc(systemConfig.id)).limit(1).for('share',{noWait:true});
  const value=normalizeConfigScalar(rows[0]?.value) || '0';
  if(!/^\d+$/.test(value))throw new HttpApiException('全局售后期限配置无效',503,503);
  const days=Number(value);
  if(!Number.isSafeInteger(days) || days>36500)throw new HttpApiException('全局售后期限配置无效',503,503);
  return days;
}

/** Order is already locked. Bound both row count and source JSON before the
 * shared quote core loads it. These are database facts, not client hints. */
export async function lockAdminRefundQuoteCarts(tx:DbClient,orderId:number,items:readonly {cartId:number}[]) {
  const carts=await tx.select({cartId:storeOrderCartInfo.cartId,size:sql<number>`octet_length(coalesce(${storeOrderCartInfo.cartInfo},''))`})
    .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,orderId)).orderBy(asc(storeOrderCartInfo.id)).limit(101).for('share');
  if(carts.length>100)throw new ValidateException('主动退款最多支持100条订单商品');
  if(carts.reduce((sum,row)=>sum+row.size,0)>1024*1024)throw new ValidateException('订单商品快照过大，请人工核对');
  const ids=new Set(carts.map(row=>row.cartId));
  if(items.some(row=>!ids.has(String(row.cartId))))throw new ValidateException('主动退款只接受当前订单的原始商品标识');
}

/** Full source facts are hashed, never exposed. Mode/selection/requested cash
 * are separately bound by the creation-intent hash and recalculated by SQL.
 * This fingerprint is a stale-review guard, not an authorization credential. */
export async function adminRefundQuoteFingerprint(quote:OrderRefundApplicationQuote):Promise<string> {
  if(quote.receivedAt!==null && (!Number.isSafeInteger(quote.receivedAt) || quote.receivedAt<0))throw new ValidateException('订单收货时间无效');
  return outRequestHash({version:'admin-refund-quote-source-v1',order:quote.order,carts:quote.carts,
    refunds:quote.previousRefunds,refundTimeDays:quote.refundTimeDays,receivedAt:quote.receivedAt});
}
