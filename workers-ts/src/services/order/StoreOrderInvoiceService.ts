import { and, desc, eq, or, sql } from "drizzle-orm";
import { storeOrder, storeOrderInvoice, userInvoice } from "@/models/schema";
import { withTx, type Container } from "@/lib/di";
import { NotFoundException, ValidateException } from "@/utils/errors";

const ORDER_INVOICE_LOCK_NAMESPACE = 18_625;

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
          eq(storeOrder.uid, uid),
          eq(storeOrder.isDel, 0),
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
    if (!reference || !Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
      throw new ValidateException("请选择要开票订单和发票");
    }

    return withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ORDER_INVOICE_LOCK_NAMESPACE}, hashtext(${`order-invoice:${reference}`}))`,
      );
      const numericId = Number(reference);
      const orderReferenceCondition =
        Number.isSafeInteger(numericId) && numericId > 0
          ? or(eq(storeOrder.orderId, reference), eq(storeOrder.id, numericId))
          : eq(storeOrder.orderId, reference);
      const [order] = await tx
        .select()
        .from(storeOrder)
        .where(
          and(
            orderReferenceCondition,
            eq(storeOrder.uid, uid),
            eq(storeOrder.isDel, 0),
            eq(storeOrder.isSystemDel, 0),
          ),
        )
        .limit(1);
      if (!order) throw new NotFoundException("订单不存在");
      if (Number(order.payPrice) <= 0) throw new ValidateException("订单实际支付金额为0，不能开发票");
      if (order.refundStatus === 2) throw new ValidateException("订单已退款");
      if (order.refundStatus === 1) throw new ValidateException("正在申请退款中");

      const [template] = await tx
        .select()
        .from(userInvoice)
        .where(and(eq(userInvoice.id, invoiceId), eq(userInvoice.uid, uid), eq(userInvoice.isDel, 0)))
        .limit(1);
      if (!template) throw new NotFoundException("发票抬头不存在");

      const [existing] = await tx
        .select({ id: storeOrderInvoice.id })
        .from(storeOrderInvoice)
        .where(
          and(
            eq(storeOrderInvoice.orderId, order.id),
            eq(storeOrderInvoice.uid, uid),
            eq(storeOrderInvoice.isDel, 0),
          ),
        )
        .limit(1);
      if (existing) throw new ValidateException("发票已申请，正在审核打印中");

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
          invoiceAmount: order.payPrice,
          addTime: Math.floor(Date.now() / 1000),
        })
        .returning({ id: storeOrderInvoice.id });
      return created;
    });
  }
}
