/** Public, bounded materialization provenance only. Provider SUCCESS, original
 * payment and recipient authority are independently required by the App reader. */
import { getTableColumns, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrderRefund } from '@/models/schema';
import { refundEntityAcceptedPairSql } from '@/migrations/guestRefundEntityCatalog';
import { readMaterializedRefundSnapshot } from '@/services/order/RefundReadSnapshot';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { amountToCents } from '@/services/payment/RefundGateway';
import { routineSubscriptionUnavailable } from './RoutineSubscriptionAccount';
import { captureRoutineSubscriptionMaterializedRefundSuccessBusiness,
  type RoutineSubscriptionMaterializedRefundSuccessBusiness } from './RoutineSubscriptionMaterializedRefundSuccessEvidenceCodec';

type Query = Pick<DbClient, 'execute'>;
const amounts = new Set(['applyPrice', 'refundPrice', 'refundedPrice']);
const refundKeys = ['id','storeOrderId','orderId','uid','storeId','supplierId','applyType','applyPrice','refundNum','refundPrice',
  'refundReason','refundExplain','refundImg','cartInfo','addTime','refundType','refundedPrice','refundedTime','isCancel','isDel'] as const;
export type MaterializedRefundSuccessPublicRefund = Pick<typeof storeOrderRefund.$inferSelect, (typeof refundKeys)[number]>;
const columns = getTableColumns(storeOrderRefund);
const refundFields = sql.join(refundKeys.flatMap(key =>
  [sql`${key}::text`, amounts.has(key) ? sql`${columns[key]}::text` : sql`${columns[key]}`]), sql`, `);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);

/** The actual writer calls this after materialization in its existing transaction.
 * Only whitelisted scalar facts and digests cross the wire; the archived source
 * order/address and complete cart objects stay in PostgreSQL. No grants or I/O. */
export async function readRoutineMaterializedRefundSuccessSourceTx(tx: Query,
  raw: Readonly<RoutineSubscriptionMaterializedRefundSuccessBusiness>) {
  const body = captureRoutineSubscriptionMaterializedRefundSuccessBusiness(raw), m = body.materializedRefund;
  if (Object.hasOwn(tx, '$client')) return routineSubscriptionUnavailable();
  const [context] = await tx.execute<{ ready: boolean }>(sql`SELECT current_schema()='public'
    AND current_setting('transaction_isolation')='read committed'
    AND NOT EXISTS(SELECT 1 FROM(VALUES('store_order'),('store_order_cart_info'),('store_order_refund'),('store_order_refund_split')) n(name)
      WHERE pg_catalog.to_regclass(n.name) IS DISTINCT FROM pg_catalog.to_regclass('public.'||n.name)) AS ready`);
  if (context?.ready !== true) return routineSubscriptionUnavailable();
  // This receipt is append-only under the exact catalog below. ACCESS SHARE
  // conflicts with the published maintenance paths' ACCESS EXCLUSIVE locks
  // and TRUNCATE, without requiring UPDATE authority. Privileged manual owner
  // guard changes are outside that protocol. Mutable rows take separate locks.
  await tx.execute(sql`LOCK TABLE ONLY public.store_order_refund_split IN ACCESS SHARE MODE NOWAIT`);
  const entity = await tx.execute<{profile: string}>(sql.raw(refundEntityAcceptedPairSql(true)));
  if (entity.length !== 1 || !['legacy', 'guest'].includes(entity[0].profile)) return routineSubscriptionUnavailable();
  const refunds = await tx.execute<{refund: MaterializedRefundSuccessPublicRefund}>(sql`SELECT jsonb_build_object(${refundFields}) AS refund
    FROM ${storeOrderRefund} WHERE ${storeOrderRefund.id}=${body.refundId}
      AND octet_length(COALESCE(${storeOrderRefund.cartInfo},''))<=65536
      AND octet_length(COALESCE(${storeOrderRefund.refundImg},''))<=262144
    LIMIT 2 FOR SHARE NOWAIT`);
  const refund = refunds[0]?.refund;
  if (refunds.length !== 1 || !refund || refund.storeOrderId !== m.sourceOrderId || refund.uid !== body.userId
    || refund.orderId !== body.orderNo || refund.refundType !== 6 || refund.isCancel !== 0 || refund.isDel !== 0
    || refund.refundPrice !== m.refundAmount || refund.refundedPrice !== m.refundAmount
    || (amountToCents(m.refundAmount) ?? 0) <= 0 || (amountToCents(body.payPrice) ?? -1) < (amountToCents(m.refundAmount) ?? 0))
    return routineSubscriptionUnavailable();
  const fingerprint = await refundOrderSplitFingerprint(refund);
  const rows = await tx.execute<{ready: boolean; materializationDigest: string; selectedDigest: string}>(sql`
    WITH receipt AS MATERIALIZED (
      SELECT t.*,t.source_snapshot::jsonb AS archive,t.partitions::jsonb AS parts,
        encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS receipt_digest
      FROM public.store_order_refund_split t WHERE t.refund_id=${refund.id} AND t.fingerprint=${fingerprint}
        AND t.uid=${body.userId} AND t.source_order_id=${m.sourceOrderId} AND t.payment_order_id=${m.paymentOrderId}
        AND t.selected_order_id=${body.orderId} AND octet_length(t.source_snapshot)<=16777216 AND octet_length(t.partitions)<=131072
    ), chosen AS MATERIALIZED (
      SELECT o.* FROM public.store_order o WHERE o.id=${body.orderId} FOR SHARE NOWAIT
    ), original AS MATERIALIZED (
      SELECT o.* FROM public.store_order o WHERE o.id IN(${m.sourceOrderId},${m.paymentOrderId}) ORDER BY o.id FOR SHARE NOWAIT
    ), carts AS MATERIALIZED (
      SELECT c.id,c.oid,c.uid,c.cart_id,c.cart_num,c.product_id,c.sku_unique,c.is_gift,c.cart_info,c.refund_num,c.split_status,c.split_surplus_num
      FROM public.store_order_cart_info c WHERE c.oid=${body.orderId} ORDER BY c.id LIMIT 201 FOR SHARE NOWAIT
    ), expected AS MATERIALIZED (
      SELECT p.value AS part,c.value AS source FROM receipt r
      CROSS JOIN LATERAL jsonb_array_elements(r.parts) p(value)
      CROSS JOIN LATERAL jsonb_array_elements(r.archive->'carts') c(value)
      WHERE p.value->'sourceRowId'=c.value->'id' AND (p.value->>'selectedNum')::integer>0
    ) SELECT
      chosen.uid=${body.userId} AND src.uid=${body.userId} AND root.uid=${body.userId}
      AND chosen.type BETWEEN 0 AND 5 AND chosen.type=src.type AND chosen.type=root.type AND r.add_time=${refund.refundedTime}
      AND chosen.supplier_id=r.supplier_id AND chosen.store_id=r.store_id AND src.supplier_id=r.supplier_id AND src.store_id=r.store_id
      AND chosen.paid=1 AND src.paid=1 AND root.paid=1 AND chosen.pay_type='weixin' AND src.pay_type='weixin' AND root.pay_type='weixin'
      AND root.pid IN(0,-1) AND (chosen.id=root.id AND chosen.pid=0 OR chosen.pid=root.id AND root.pid=-1)
      AND (src.id=root.id OR src.pid=root.id) AND chosen.trade_no=root.trade_no AND src.trade_no=root.trade_no
      AND chosen.is_del=0 AND chosen.is_system_del=0 AND root.is_del=0 AND root.is_system_del=0
      AND chosen.refund_type=6 AND chosen.refund_status=2 AND chosen.refund_price::text=${m.refundAmount}
      AND chosen.pay_price::text=${body.payPrice} AND chosen.total_num=${refund.refundNum}
      AND r.archive @> jsonb_build_object('version','refund-order-materialization-v1',
        'source',jsonb_build_object('id',src.id,'uid',src.uid,'supplierId',src.supplier_id,'storeId',src.store_id,
          'orderId',src.order_id,'tradeNo',src.trade_no,'payType','weixin','paid',1,'type',src.type,
          'pid',CASE WHEN src.id=root.id THEN 0 ELSE root.id END),
        'payment',jsonb_build_object('id',root.id,'orderId',root.order_id,'tradeNo',root.trade_no,'payPrice',root.pay_price::text,'payType','weixin'),
        'refund',jsonb_build_object('id',${refund.id}::integer,'refundedTime',${refund.refundedTime}::integer))
      AND (SELECT count(*) BETWEEN 1 AND 100 AND count(*)=(SELECT count(*) FROM expected)
        AND sum(cart_num)=chosen.total_num AND sum(octet_length(COALESCE(cart_info,'')))<=1048576 FROM carts)
      AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN carts c ON c.id=(e.part->>'selectedRowId')::integer
        WHERE c.id IS NULL OR c.uid<>${body.userId} OR c.cart_num<>(e.part->>'selectedNum')::integer
          OR e.source->'productId' IS NULL OR jsonb_typeof(e.source->'productId')<>'number'
          OR c.product_id<>(e.source->>'productId')::integer OR c.sku_unique IS DISTINCT FROM e.source->>'skuUnique'
          OR c.cart_id IS DISTINCT FROM CASE WHEN r.disposition='whole' THEN e.part->>'sourceCartId' ELSE e.part->>'selectedRowId' END
          OR c.split_status<>2 OR c.split_surplus_num<>0 OR c.refund_num<>CASE WHEN r.disposition='whole' THEN 0 ELSE c.cart_num END)
      AS ready,r.receipt_digest AS "materializationDigest",
      encode(sha256(convert_to(jsonb_build_object('order',jsonb_build_object('id',chosen.id,'orderNo',chosen.order_id,
        'uid',chosen.uid,'supplierId',chosen.supplier_id,'storeId',chosen.store_id,'payPrice',chosen.pay_price::text,
        'totalNum',chosen.total_num,'type',chosen.type,'payType',chosen.pay_type,'tradeNo',chosen.trade_no,'pid',chosen.pid,
        'refundType',chosen.refund_type,'refundStatus',chosen.refund_status,'refundPrice',chosen.refund_price::text),
        'carts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM carts c))::text,'UTF8')),'hex') AS "selectedDigest"
    FROM receipt r CROSS JOIN chosen JOIN original src ON src.id=${m.sourceOrderId} JOIN original root ON root.id=${m.paymentOrderId}`);
  if (rows.length !== 1 || rows[0].ready !== true || !hex(rows[0].materializationDigest) || !hex(rows[0].selectedDigest))
    return routineSubscriptionUnavailable();
  const history = await readMaterializedRefundSnapshot(tx, refund);
  if (!history || history.physicalOrderId !== body.orderId || history.items.reduce((sum, item) => sum + (item.quantity ?? 0), 0) !== refund.refundNum)
    return routineSubscriptionUnavailable();
  return Object.freeze({ refund, materializationDigest: rows[0].materializationDigest, selectedDigest: rows[0].selectedDigest });
}
