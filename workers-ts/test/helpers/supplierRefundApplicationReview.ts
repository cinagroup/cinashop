import { eq, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, storeOrderRefundSplit, systemRole } from '@/models/schema';
import type { SupplierRefundApplicationContext, SupplierRefundApplicationReview } from '@/services/supplier/SupplierRefundApplicationReview';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { supplierOrderGiftIdentityFixture } from './supplierOrderGiftIdentity';

export const applicationClaim = (order: { id: number; uid: number }, rows: Array<{ id: number; cartId: string; cartNum: number }>,
  selected: Array<{ rowId: number; quantity: number }>, version = 'refund-quantity-customer-row-v3') => {
  const rowNamespace = version === 'refund-quantity-customer-row-v3';
  const items = selected.map(selection => {
    const row = rows.find(row => row.id === selection.rowId); if (!row) throw Error('Owned claim row missing');
    return { rowId: row.id, cartId: rowNamespace ? row.id : Number(row.cartId), cartNum: selection.quantity,
      beforeRefundNum: 0, totalNum: row.cartNum, ...(rowNamespace ? { sourceCartId: row.cartId } : {}) };
  });
  return JSON.stringify({ cartIds: items.map(({ cartId, cartNum, ...item }) => ({ cartId, cartNum,
    ...(rowNamespace ? { sourceCartId: item.sourceCartId } : {}) })),
    quantityReservation: { version, orderId: order.id, uid: order.uid, items } });
};

/** Owned synthetic display/edge-case records only. Registered checkout, refund
 * apply/cancel/refuse and materialization are separately proved in the native. */
export async function supplierRefundApplicationReviewFixture() {
  const f = await supplierOrderGiftIdentityFixture();
  try {
    const dialect = new PgDialect();
    // supplierOrderDistributionFixture already creates the real refund ORM table.
    for (const table of [storeOrderRefundPayment, storeOrderRefundSplit]) {
      const definition = getTableConfig(table), columns = definition.columns.map(column => {
        const value = column.default, initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL
          ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public."${definition.name}" (${columns.join(',')})`);
    }
    for (const roleId of [22, 31]) {
      const [role] = await f.db.select().from(systemRole).where(eq(systemRole.id, roleId));
      await f.db.update(systemRole).set({ rules: role.rules + ',supplier.refund.view' }).where(eq(systemRole.id, roleId));
    }
    await f.db.update(storeOrderCartInfo).set({ skuUnique: 'tracksku' }).where(eq(storeOrderCartInfo.id, 1111));
    const expectedApplications = new Map<number, SupplierRefundApplicationReview>();
    const context = (order: typeof storeOrder.$inferSelect): SupplierRefundApplicationContext => ({
      basis: 'linked_order_record', order_id: order.orderId, paid: order.paid as 0 | 1, pay_type: order.payType,
      pay_price: order.payPrice, pay_time: order.payTime,
      recipient: { name: order.realName, phone: order.userPhone, address: order.userAddress }, mark: order.mark });
    for (const id of [100, 201, 202, 301, 110, 111, 900]) {
      const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, id));
      const rows = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id);
      const quantity = id === 201 || id === 301 ? 2 : 1;
      const legacy = [
        { id: 'opaque-legacy-purchase', product_id: 70, cart_num: 1, is_gift: 0,
          productInfo: { id: 70, store_name: '申请冻结旧商品', spec_type: 1, code: 'WRONG-PRODUCT-CODE',
            attrInfo: { suk: '旧红色,S', code: 'LEGACY-SKU-CODE', settle_price: '2.50', disk_info: 'PRIVATE-LEGACY-DISK' } },
          attrInfo: { disk_info: 'PRIVATE-ROOT-DISK' } },
        { id: 'opaque-legacy-gift', product_id: 81, cart_num: 1, is_gift: 1,
          productInfo: { id: 81, store_name: '申请冻结旧赠品', spec_type: 0, code: 'LEGACY-PRODUCT-CODE',
            attrInfo: { suk: '旧礼盒', code: 'WRONG-SKU-CODE', settle_price: '0.00' } } },
      ];
      const cartInfo = id === 201 ? JSON.stringify(legacy) : id === 110 ? '{"cartIds":[123]}' : rows.length
        ? applicationClaim(order, rows, (id === 301 ? rows : [rows[0]]).map(row => ({ rowId: row.id, quantity: id === 301 ? row.cartNum : 1 }))) : null;
      await f.db.insert(storeOrderRefund).values({ id, uid: order.uid, supplierId: order.supplierId, storeId: order.storeId,
        storeOrderId: id, orderId: 'refund-application-' + id, applyType: 1, applyPrice: id === 301 ? '28.50' : '10.00',
        refundPrice: id === 301 ? '28.50' : '10.00', refundNum: quantity, refundType: id === 301 ? 6 : id === 202 ? 3 : 0,
        refundedPrice: id === 301 ? '28.50' : '0.00', isCancel: id === 111 ? 1 : 0, cartInfo,
        refundReason: '申请商品与数量核对', refundExplain: '用户申请：只退所选商品', addTime: 1700000000 });
      if (id === 100) {
        await f.db.update(storeOrderCartInfo).set({ refundNum: 1 }).where(eq(storeOrderCartInfo.id, rows[0].id));
        expectedApplications.set(id, { version: 1, refund_id: id, source_order_id: id, state: 'recorded', basis: 'quantity_claim', error: '',
          order_context: context(order), items: [{ row_id: rows[0].id, cart_id: rows[0].cartId, product_id: 70,
            product_name: '冻结核对商品', sku: '冻结红色,S', code: 'FROZEN-CODE', is_gift: 0,
            quantity: 1, settlement_unit: '2.50', settlement_subtotal: '2.50' }] });
      }
      if (id === 201) expectedApplications.set(id, { version: 1, refund_id: id, source_order_id: id, state: 'recorded',
        basis: 'php_legacy_snapshot', error: '', order_context: context(order), items: [
          { row_id: null, cart_id: legacy[0].id, product_id: 70, product_name: '申请冻结旧商品', sku: '旧红色,S', code: 'LEGACY-SKU-CODE', is_gift: 0,
            quantity: 1, settlement_unit: '2.50', settlement_subtotal: '2.50' },
          { row_id: null, cart_id: legacy[1].id, product_id: 81, product_name: '申请冻结旧赠品', sku: '旧礼盒', code: 'LEGACY-PRODUCT-CODE', is_gift: 1,
            quantity: 1, settlement_unit: '0.00', settlement_subtotal: '0.00' }] });
      if (id === 202) await f.db.update(storeOrderCartInfo).set({ cartId: 'changed-after-refusal' }).where(eq(storeOrderCartInfo.id, rows[0].id));
      if (id === 301) {
        const [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, id));
        const [payment] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, order.pid));
        await f.db.insert(storeOrderRefundSplit).values({ refundId: id, fingerprint: await refundOrderSplitFingerprint(refund), uid: order.uid,
          supplierId: order.supplierId, storeId: order.storeId, sourceOrderId: id, paymentOrderId: payment.id, selectedOrderId: id,
          remainingOrderId: null, disposition: 'whole', previousRefundId: 0, returnedPointBillIds: '[]', earnedIncomeScope: 'null',
          sourceSnapshot: JSON.stringify({ version: 'refund-order-materialization-v1', source: order, refund,
            payment, carts: rows }), partitions: JSON.stringify(rows.map(row => ({ sourceRowId: row.id, sourceCartId: row.cartId,
            selectedRowId: row.id, remainingRowId: null, selectedNum: row.cartNum, remainingNum: 0 }))), addTime: 1700000000 });
        expectedApplications.set(id, { version: 1, refund_id: id, source_order_id: id, state: 'archived', basis: null, error: '', items: [], order_context: context(order) });
      }
      // Known private values must never escape through compatibility raw fields.
      await f.db.update(storeOrder).set({ virtualInfo: '"PRIVATE-CLAIMED-CARD"', customForm: 'PRIVATE-CUSTOMER-ANSWER' }).where(eq(storeOrder.id, id));
    }
    const grantApplicationReader = async (role: string) => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unowned application review reader');
      await f.grantGiftReader(role);
      await f.exec(`GRANT SELECT ON public.store_order_refund,public.store_order_refund_payment,public.store_order_refund_split TO "${role}"`);
    };
    type Peer = Parameters<Parameters<typeof f.withReader>[0]>[0];
    const withReader = <T>(work: (peer: Peer) => Promise<T>) => f.withReader(async peer => { await grantApplicationReader(peer.role); return work(peer); });
    return { ...f, withReader, grantApplicationReader, expectedApplications,
      ids: { ...f.ids, modern: 100, legacy: 201, refusedUnavailable: 202, archived: 301, badLegacy: 110, cancelled: 111 },
      refundIds: { modern: 100, legacy: 201, refusedUnavailable: 202, archived: 301, badLegacy: 110, cancelled: 111, foreign: 900 } };
  } catch (error) { await f.close(); throw error; }
}
