import { and, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderRefund as refund, storeOrderRefundPayment as payment } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { previewReturnImages } from '@/services/order/RefundReturnPayload';
import { resolveRefundReturnContact } from '@/services/order/RefundReturnContactService';
import type { RefundExecutionScope } from '@/services/order/StoreOrderRefundService';
import { decimalToCents } from '@/services/order/OrderBrokerageService';
import { readStaffRefundHistory } from '@/services/order/RefundReadSnapshot';

export function adminRefundId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw new ValidateException('退款单标识无效');
  return Number(value);
}

/** Modern decisions carry what the administrator actually reviewed. The core
 * repeats these checks under the refund/order locks before changing state. */
export function adminRefundReview(value: unknown): RefundExecutionScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('请重新读取退款详情并确认');
  const row = value as Record<string, unknown>;
  for (const key of ['uid', 'storeOrderId', 'storeId', 'supplierId']) {
    const id = row[key];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < (key === 'uid' || key === 'storeOrderId' ? 1 : 0) || id > 2147483647) throw new ValidateException('退款确认范围无效');
  }
  if (typeof row.orderId !== 'string' || !row.orderId || row.orderId.length > 50
    || typeof row.refundPrice !== 'string' || !/^\d{1,10}\.\d{2}$/.test(row.refundPrice)) throw new ValidateException('退款确认金额或单号无效');
  return { expectedUid: Number(row.uid), expectedStoreOrderId: Number(row.storeOrderId), expectedStoreId: Number(row.storeId),
    expectedSupplierId: Number(row.supplierId), expectedRefundOrderId: row.orderId,
    expectedRefundAmountCents: decimalToCents(row.refundPrice), requireSystemVisible: true, requirePaid: true };
}

const selection = {
  id: refund.id, storeOrderId: refund.storeOrderId, orderId: refund.orderId, uid: refund.uid,
  storeId: refund.storeId, supplierId: refund.supplierId, applyType: refund.applyType,
  applyPrice: refund.applyPrice, refundType: refund.refundType, refundNum: refund.refundNum,
  refundPrice: refund.refundPrice, refundedPrice: refund.refundedPrice, refundReason: refund.refundReason,
  isCancel: refund.isCancel, isDel: refund.isDel, addTime: refund.addTime, refundedTime: refund.refundedTime,
  originalOrderId: storeOrder.orderId, payType: storeOrder.payType, providerStatus: payment.providerStatus,
};
const visible = () => and(eq(refund.isDel, 0), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0),
  eq(refund.uid, storeOrder.uid), eq(refund.supplierId, storeOrder.supplierId), eq(refund.storeId, storeOrder.storeId));

export class AdminRefundReadService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  async list(query: Record<string, string>) {
    const rawLimit = query.limit ?? '20';
    if (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw new ValidateException('分页大小无效');
    const limit = Number(rawLimit), conditions: SQL[] = [visible()!];
    if (query.before) conditions.push(lt(refund.id, adminRefundId(query.before)));
    if (query.status !== undefined && query.status !== '') {
      if (!/^[0-6]$/.test(query.status)) throw new ValidateException('售后状态无效');
      conditions.push(eq(refund.refundType, Number(query.status)));
    }
    const keyword = (query.keyword ?? '').trim();
    if (keyword.length > 64) throw new ValidateException('单号搜索不能超过64个字符');
    if (keyword) {
      const match = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(or(ilike(refund.orderId, match), ilike(storeOrder.orderId, match))!);
    }
    const rows = await this.container.db.select(selection).from(refund)
      .innerJoin(storeOrder, eq(storeOrder.id, refund.storeOrderId))
      .leftJoin(payment, eq(payment.refundId, refund.id)).where(and(...conditions))
      .orderBy(desc(refund.id)).limit(limit + 1);
    const list = rows.slice(0, limit);
    return { list, limit, nextCursor: rows.length > limit ? String(list.at(-1)!.id) : null };
  }

  async detail(id: number) {
    // One bounded database snapshot for the row, contact and attachment owner.
    // Actual Hyperdrive cache freshness is a separate deployment acceptance gate.
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
      const container = createContainerFromDb(db);
      const [row] = await db.select({ ...selection, refundExplain: refund.refundExplain, refuseReason: refund.refuseReason,
        refundExpress: refund.refundExpress, refundExpressName: refund.refundExpressName, refundPhone: refund.refundPhone,
        refundGoodsExplain: refund.refundGoodsExplain,
        evidence: sql<string | null>`CASE WHEN octet_length(${refund.refundGoodsImg}) <= 8192 THEN ${refund.refundGoodsImg} WHEN ${refund.refundGoodsImg} IS NULL THEN NULL ELSE '__invalid__' END`,
        cart: sql<string | null>`CASE WHEN octet_length(${refund.cartInfo}) <= 65536 THEN ${refund.cartInfo} ELSE NULL END`,
      }).from(refund).innerJoin(storeOrder, eq(storeOrder.id, refund.storeOrderId))
        .leftJoin(payment, eq(payment.refundId, refund.id)).where(and(visible(), eq(refund.id, id))).limit(1);
      if (!row) throw new NotFoundException('退款记录不存在或关联订单不可读取');
      const { evidence, cart, ...detail } = row;
      const refundHistory = await readStaffRefundHistory(db, { ...row, cartInfo: cart });
      let returnImages: Array<{ url: string; src: string }> = [], returnImagesError = '';
      try { returnImages = await previewReturnImages(container, row.uid, evidence, this.env.APP_KEY); }
      catch (error) { if (!(error instanceof ValidateException)) throw error; returnImagesError = '退货凭证暂不可读取，请与用户核对'; }
      let cartInfo: unknown = null;
      try { cartInfo = cart ? JSON.parse(cart) : null; } catch { /* Legacy malformed JSON must not erase the return evidence. */ }
      return { ...detail, cartInfo, refundHistory, returnImages, returnImagesError, returnContact: await resolveRefundReturnContact(container, row) };
    });
  }
}
