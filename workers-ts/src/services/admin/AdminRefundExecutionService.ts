import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderRefund, storeOrderRefundPayment } from '@/models/schema';
import { assertRoutineRefundStatusReadTx } from '@/migrations/routineRefund';
import { amountToCents } from '@/services/payment/RefundGateway';
import { assertRoutineRefundProjectionTx } from '@/services/payment/RoutineRefundProvider';
import { verifyFinancialCompletedRefund } from '@/services/customer-work/CustomerWorkFinancialVerification';
import { managerRefundMaterializationReadiness } from '@/services/store/StoreManagerFinancialService';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { ApiErrorCode, AuthException, HttpApiException, ValidateException } from '@/utils/errors';
import { authorizeAdminRefundActorReadTx, type AdminRefundDecisionActor } from './AdminRefundDecisionService';
import { readAdminRefundOperationSnapshotTx, type AdminRefundOperationReceipt } from './AdminRefundOperationLedger';

export const ADMIN_REFUND_EXECUTION_VERSION = 'admin-refund-execution-v1' as const;
export interface AdminRefundExecution {
  completed: boolean;
  status: string;
}
export interface AdminRefundExecutionResult {
  version: typeof ADMIN_REFUND_EXECUTION_VERSION;
  receipt: AdminRefundOperationReceipt | null;
  execution: AdminRefundExecution | null;
}
const providerStates = new Set(['CREATED', 'REQUESTING', 'PROCESSING', 'SUCCESS', 'CLOSED', 'ABNORMAL', 'FAILED', 'UNKNOWN', 'NOT_FOUND']);
// The common completion reader also uses these model relations. Optional
// absent objects remain absent; a TEMP replacement must never supply evidence.
const snapshotRelations = ['store_order', 'store_order_refund', 'store_order_refund_payment', 'store_order_refund_split',
  'store_order_cart_info', 'store_order_status', 'store_order_invoice', 'store_order_invoice_evidence',
  'store_order_invoice_allocation', 'store_order_fulfillment_branch', 'store_product', 'store_product_attr_value',
  'store_seckill', 'store_bargain', 'store_bargain_user', 'store_combination', 'store_integral', 'store_discounts',
  'user', 'user_bill', 'store_order_outbox'] as const;
const unavailable = (error: unknown) => error instanceof HttpApiException && error.httpStatus === 503;
type Refund = typeof storeOrderRefund.$inferSelect;

/** Existing common verification reads the complete physical generation,
 * immutable split fingerprint/partitions, invoice and compensation evidence.
 * It does not invoke a finalizer or infer past stock movements from today's
 * inventory. Unverifiable historical rows remain UNKNOWN. */
async function completed(tx: DbClient, refund: Refund): Promise<boolean> {
  try {
    if (!(await managerRefundMaterializationReadiness(tx)).ready) return false;
    await verifyFinancialCompletedRefund(tx, refund);
    return true;
  } catch (error) {
    if (error instanceof ValidateException || unavailable(error)) return false;
    throw error;
  }
}

/** SQL-only current-owner execution projection. A new provider request, secret
 * lookup, original-key fence, advisory lock or completion write is never part
 * of this read. A missing receipt gives no assurance against a delayed sender. */
export async function lookupAdminRefundExecution(container: Container, env: Env,
  actorInput: AdminRefundDecisionActor, requestKey: unknown): Promise<AdminRefundExecutionResult> {
  const actor = Object.freeze({ id: actorInput.id, authVersion: actorInput.authVersion, expiresAt: actorInput.expiresAt });
  const key = normalizeOutRequestKey(requestKey), signing = Object.freeze({ APP_KEY: env.APP_KEY });
  if (!Object.hasOwn(container.db, '$client')) throw new Error('Admin refund execution status requires a root database client');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL row_security = off`);
    await tx.execute(sql`SELECT
      pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
      pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
    await authorizeAdminRefundActorReadTx(tx, actor);
    const receipt = await readAdminRefundOperationSnapshotTx(tx, actor.id, key);
    const result = (execution: AdminRefundExecution | null): AdminRefundExecutionResult => {
      if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
      return { version: ADMIN_REFUND_EXECUTION_VERSION, receipt, execution };
    };
    const unknown = () => result({ completed: false, status: 'UNKNOWN' });
    if (!receipt) return result(null);
    if (receipt.adminId !== actor.id || receipt.requestKey !== key) return unknown();
    if (receipt.action !== 'refund' || !['provider-admitted', 'balance-settled'].includes(receipt.outcome)) return result(null);
    const [relations] = await tx.execute<{ ready: boolean }>(sql`SELECT NOT EXISTS(SELECT 1 FROM
      pg_catalog.jsonb_array_elements_text(${JSON.stringify(snapshotRelations)}::jsonb) n(name)
      WHERE pg_catalog.to_regclass(pg_catalog.quote_ident(n.name)) IS DISTINCT FROM
        pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(n.name))) AS ready`);
    if (relations?.ready !== true) return unknown();

    const refunds = await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, receipt.refundId)).limit(2);
    if (refunds.length !== 1) return unknown();
    const refund = refunds[0], orders = await tx.select().from(storeOrder).where(eq(storeOrder.id, refund.storeOrderId)).limit(2);
    if (orders.length !== 1) return unknown();
    const order = orders[0], refundAmount = amountToCents(refund.refundPrice);
    if (refund.storeOrderId !== order.id || refund.uid !== order.uid || refund.storeId !== order.storeId
      || refund.supplierId !== order.supplierId || order.paid !== 1 || order.isDel || order.isSystemDel
      || refund.isDel || refund.isCancel || order.pid < -1 || refundAmount === null || refundAmount < 0) return unknown();

    if (receipt.outcome === 'balance-settled') {
      if (order.payType !== 'yue' && refundAmount !== 0) return unknown();
      return await completed(tx, refund) ? result({ completed: true, status: 'BALANCE_SUCCESS' }) : unknown();
    }
    const provider = order.payType === 'weixin' ? 'wechat' : order.payType === 'alipay' ? 'alipay' : null;
    if (!provider || refundAmount <= 0) return unknown();
    const rootId = order.pid > 0 ? order.pid : order.id;
    const roots = rootId === order.id ? [order] : await tx.select().from(storeOrder).where(eq(storeOrder.id, rootId)).limit(2);
    const payments = await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId, refund.id)).limit(2);
    if (roots.length !== 1 || payments.length !== 1) return unknown();
    const root = roots[0], payment = payments[0], totalAmount = amountToCents(root.payPrice);
    const allocated = root.pid === -1 && root.supplierId === 0 && root.supplierAllocationStatus === 2;
    if (root.id !== rootId || root.uid !== refund.uid || root.paid !== 1 || root.payType !== order.payType
      || root.isDel || root.isSystemDel || order.pid > 0 && root.pid !== -1
      || (order.storeId !== root.storeId || order.supplierId !== root.supplierId) && !allocated
      || totalAmount === null || totalAmount < refundAmount || payment.refundId !== refund.id
      || payment.storeOrderId !== order.id || payment.provider !== provider || payment.outRefundNo !== 'CNSR' + refund.id
      || payment.requestAmount !== refundAmount || payment.totalAmount !== totalAmount
      || !providerStates.has(payment.providerStatus)) return unknown();
    if (provider === 'wechat') {
      try {
        // Bind this API to its real Admin LOGIN. Complete absence keeps legacy
        // current-account semantics; partial/unauthorized addons never fall back.
        await assertRoutineRefundStatusReadTx(tx, 'admin');
        await assertRoutineRefundProjectionTx(tx, signing, refund.id, true);
      } catch (error) {
        if (unavailable(error)) return unknown();
        throw error;
      }
    }
    if (payment.providerStatus === 'SUCCESS') {
      return await completed(tx, refund) ? result({ completed: true, status: 'SUCCESS' }) : unknown();
    }
    return result({ completed: false, status: payment.providerStatus });
  });
}
