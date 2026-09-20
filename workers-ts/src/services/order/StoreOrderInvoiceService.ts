import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { storeOrder, storeOrderInvoice, userInvoice } from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { lockOrderSettlement } from './OrderBrokerageService';
import { currentInvoiceAmount } from './InvoiceOrderLifecycle';

type Order = typeof storeOrder.$inferSelect;

/** Share the physical split/refund lock graph, never a hash of the caller's
 * spelling of an order. Resolve aliases without choosing an arbitrary match,
 * then revalidate the same identity and ancestor after every possible wait. */
async function lockInvoiceOrder(tx: DbClient, uid: number, reference: string): Promise<Order> {
  const numericId = Number(reference);
  const referenceCondition = Number.isSafeInteger(numericId) && numericId > 0
    ? or(eq(storeOrder.orderId, reference), eq(storeOrder.id, numericId)) : eq(storeOrder.orderId, reference);
  const matches = await tx.select({ id: storeOrder.id, pid: storeOrder.pid, orderId: storeOrder.orderId }).from(storeOrder)
    .where(and(referenceCondition, eq(storeOrder.uid, uid), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).limit(2);
  if (!matches.length) throw new NotFoundException('订单不存在');
  if (matches.length !== 1) throw new ValidateException('订单标识存在歧义，请使用明确的订单号');
  const initial = matches[0], rootId = initial.pid > 0 ? initial.pid : initial.id;
  await lockOrderSettlement(tx, rootId);
  const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, rootId)).limit(1).for('update');
  if (rootId !== initial.id) await lockOrderSettlement(tx, initial.id);
  const [order] = rootId === initial.id ? [root] : await tx.select().from(storeOrder)
    .where(eq(storeOrder.id, initial.id)).limit(1).for('update');
  if (!root || !order || order.uid !== uid || root.uid !== uid || order.isDel || order.isSystemDel
    || root.isDel || root.isSystemDel || order.orderId !== initial.orderId || order.pid !== initial.pid
    || (order.pid > 0 && (root.pid !== -1 || order.payType !== root.payType || order.paid !== root.paid))
    || (root.supplierId !== order.supplierId && !(root.supplierId === 0 && root.supplierAllocationStatus === 2))
    || (root.storeId !== order.storeId && root.supplierAllocationStatus !== 2)) {
    throw new ValidateException('开票订单关联已变化，请刷新后重试');
  }
  if (order.pid === -1) throw new ValidateException('请从拆分后的履约子单申请发票');
  if (order.pid < 0 || order.supplierAllocationStatus === 1 || ![0, 1, 2, 3].includes(order.status)) {
    throw new ValidateException('订单当前状态不能申请发票');
  }
  return order;
}

export class StoreOrderInvoiceService {
  constructor(private readonly container: Container) {}

  /** PHP v2 order/invoice_list */
  async list(uid: number, page = 1, limit = 10) {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
    const rows = await this.container.db
      .select({ invoice: storeOrderInvoice, order: storeOrder })
      .from(storeOrderInvoice)
      .innerJoin(storeOrder, eq(storeOrder.id, storeOrderInvoice.orderId))
      .where(
        and(
          eq(storeOrderInvoice.uid, uid),
          eq(storeOrderInvoice.isPay, 1),
          eq(storeOrderInvoice.isRefund, 0),
          eq(storeOrderInvoice.isDel, 0),
          eq(storeOrderInvoice.category, 'order'),
          eq(storeOrder.uid, uid),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
          ne(storeOrder.refundStatus, 2),
        ),
      )
      .orderBy(desc(storeOrderInvoice.addTime), desc(storeOrderInvoice.id))
      .limit(safeLimit)
      .offset((safePage - 1) * safeLimit);
    return rows.map(({ invoice, order }) => ({ ...invoice, order }));
  }

  /** PHP v2 order/make_up_invoice */
  async makeUp(
    uid: number,
    orderReference: string | number,
    invoiceId: number,
  ): Promise<{ id: number }> {
    const reference = String(orderReference).trim();
    if (!reference || reference.length > 50 || !Number.isSafeInteger(uid) || uid <= 0
      || !Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
      throw new ValidateException("请选择要开票订单和发票");
    }

    return withTx(this.container, async (tx) => {
      const order = await lockInvoiceOrder(tx, uid, reference);
      const amount = await currentInvoiceAmount(tx, order);

      const [template] = await tx
        .select()
        .from(userInvoice)
        .where(and(eq(userInvoice.id, invoiceId), eq(userInvoice.uid, uid), eq(userInvoice.isDel, 0)))
        .limit(1).for('share');
      if (!template) throw new NotFoundException("发票抬头不存在");

      const existing = await tx
        .select({ id: storeOrderInvoice.id, orderId: storeOrderInvoice.orderId, uid: storeOrderInvoice.uid, category: storeOrderInvoice.category })
        .from(storeOrderInvoice)
        .where(
          and(
            inArray(storeOrderInvoice.orderId, order.pid > 0 ? [order.pid, order.id] : [order.id]),
            eq(storeOrderInvoice.isDel, 0),
          ),
        )
        .orderBy(asc(storeOrderInvoice.id)).limit(2).for('update');
      if (existing.length > 1 || existing.some(row => row.uid !== uid || row.category !== 'order')) {
        throw new ValidateException('订单开票申请关联异常，请先完成数据核对');
      }
      if (existing.some(row => row.orderId !== order.id)) {
        // A root document still covers the payment. Until its explicit child
        // allocation exists, another child application would double invoice it.
        throw new ValidateException('原支付主单已有开票记录，请先完成拆单发票归属处理');
      }
      if (existing.length) throw new ValidateException("发票已申请，正在审核打印中");

      const [created] = await tx
        .insert(storeOrderInvoice)
        .values({
          uid,
          category: "order",
          orderId: order.id,
          invoiceId,
          headerType: template.headerType,
          type: template.type,
          name: template.name,
          dutyNumber: template.dutyNumber,
          drawerPhone: template.drawerPhone,
          email: template.email,
          tell: template.tell,
          address: template.address,
          bank: template.bank,
          cardNumber: template.cardNumber,
          isPay: order.paid === 1 ? 1 : 0,
          isRefund: 0,
          isInvoice: 0,
          invoiceAmount: amount,
          addTime: Math.floor(Date.now() / 1000),
        })
        .returning({ id: storeOrderInvoice.id });
      return created;
    });
  }
}
