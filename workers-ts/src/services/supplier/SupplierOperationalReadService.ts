import { and, asc, desc, eq, ne, or, sql } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { storeOrder, storeOrderRefund, storeOrderStatus } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { readSupplierCarts, supplierDisplayCart, supplierReadIdentity, supplierReadSnapshot } from './SupplierReadSupport';

const referenceColumns = {
  id: storeOrder.id, pid: storeOrder.pid, uid: storeOrder.uid, storeId: storeOrder.storeId,
  supplierId: storeOrder.supplierId, status: storeOrder.status, paid: storeOrder.paid,
  refundStatus: storeOrder.refundStatus, shippingType: storeOrder.shippingType,
  isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel,
};

export class SupplierOperationalReadService {
  constructor(private readonly container: Container) {}

  async splitCartInfo(supplierId: number, orderId: number) {
    supplierReadIdentity(supplierId); supplierReadIdentity(orderId);
    return supplierReadSnapshot(this.container, async db => {
      const [reference] = await db.select(referenceColumns).from(storeOrder).where(and(
        eq(storeOrder.id, orderId), eq(storeOrder.supplierId, supplierId), eq(storeOrder.isSystemDel, 0),
      )).limit(1);
      if (!reference) throw new NotFoundException('订单不存在或不属于当前供应商');
      const rootId = reference.pid > 0 ? reference.pid : reference.id;
      if (rootId !== reference.id) {
        const [root] = await db.select({ id: storeOrder.id }).from(storeOrder).where(and(
          eq(storeOrder.id, rootId), eq(storeOrder.uid, reference.uid), eq(storeOrder.isSystemDel, 0),
          or(and(eq(storeOrder.supplierId, supplierId), eq(storeOrder.storeId, reference.storeId)),
            and(eq(storeOrder.supplierId, 0), eq(storeOrder.pid, -1), eq(storeOrder.supplierAllocationStatus, 2))),
        )).limit(1);
        if (!root) throw new NotFoundException('主订单不存在或不属于当前供应商');
      }
      let active: typeof reference | undefined = reference.status === 0 ? reference : undefined;
      if (reference.pid === -1) {
        const pending = await db.select(referenceColumns).from(storeOrder).where(and(
          eq(storeOrder.pid, reference.id), eq(storeOrder.supplierId, supplierId), eq(storeOrder.uid, reference.uid),
          eq(storeOrder.storeId, reference.storeId), eq(storeOrder.status, 0),
          // Completed refund leaves keep status=0; they are not pending shipments.
          // In-progress/unknown refunds remain candidates and fail explicitly below.
          ne(storeOrder.refundStatus, 2), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0),
        )).orderBy(asc(storeOrder.id)).limit(2);
        if (pending.length > 1) throw new ValidateException('订单存在多个待发货子单，请先完成数据核对');
        active = pending[0];
      }
      if (!active) return [];
      if (active.paid !== 1) throw new ValidateException('订单未支付');
      if (active.isDel || active.isSystemDel) throw new ValidateException('订单已删除，不能发货');
      if (active.shippingType === 2) throw new ValidateException('核销订单不能发货');
      if (![0, 3].includes(active.refundStatus)) throw new ValidateException('订单售后状态不允许发货');
      const [refund] = await db.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(and(
        eq(storeOrderRefund.storeOrderId, active.id), eq(storeOrderRefund.supplierId, supplierId),
        eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0),
        sql`${storeOrderRefund.refundType} IN (0, 1, 2, 4, 5)`,
      )).limit(1);
      if (refund) throw new ValidateException('订单存在进行中的售后，不能发货');
      const carts = await readSupplierCarts(db, supplierId, [active]);
      if (carts.some(cart => cart.cartNum < 0 || cart.refundNum < 0 || cart.refundNum > cart.cartNum
        || cart.splitSurplusNum < 0 || cart.splitSurplusNum > cart.cartNum || ![0, 1, 2].includes(cart.splitStatus))) {
        throw new ValidateException('订单商品数量或拆分状态不一致，请核对');
      }
      return carts.filter(cart => cart.splitStatus < 2 && cart.splitSurplusNum > 0).map(supplierDisplayCart);
    });
  }

  async statusLogs(supplierId: number, orderId: number) {
    supplierReadIdentity(supplierId); supplierReadIdentity(orderId);
    return supplierReadSnapshot(this.container, async db => {
      const [order] = await db.select({ id: storeOrder.id }).from(storeOrder).where(and(
        eq(storeOrder.id, orderId), eq(storeOrder.supplierId, supplierId), eq(storeOrder.isSystemDel, 0),
      )).limit(1);
      if (!order) throw new NotFoundException('订单不存在或不属于当前供应商');
      const logs = await db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, order.id))
        .orderBy(desc(storeOrderStatus.changeTime), desc(storeOrderStatus.id)).limit(501);
      if (logs.length > 500) throw new ValidateException('订单状态记录过多，请核对');
      return logs;
    });
  }
}
