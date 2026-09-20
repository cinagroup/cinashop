import { customerRefundApplicationFixture } from './customerRefundApplicationFixture';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, systemConfig } from '../../src/models/schema';
import { refundCancel } from '../../src/controllers/api/v1/PayController';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Preseeded refund histories with owner cancellation, never provider/settlement execution. */
export async function customerRefundReadFixture(extraTables: PgTable[] = []) {
  const fixture = await customerRefundApplicationFixture([storeOrderRefundPayment, ...extraTables]);
  try {
    for (let id = 20; id <= 47; id++) {
      const uid = id === 46 ? 22 : 11, refundType = [0, 1, 2, 3, 4, 5, 6][id % 7];
      await fixture.db.insert(storeOrder).values({ id, uid, orderId: `history_order_${id}`, paid: 1,
        totalNum: 2, totalPrice: '10.00', payPrice: '10.00', addTime: 1700000000 });
      await fixture.db.insert(storeOrderCartInfo).values({ id, oid: id, uid, cartId: String(2000 + id),
        productId: 70, cartNum: 2, isSupportRefund: 1,
        cartInfo: JSON.stringify({ product: { storeName: `退款商品 ${id}`, image: '/api/qa/image.svg' }, sku: { suk: '红色', price: '5.00' } }) });
      await fixture.db.insert(storeOrderRefund).values({ id, uid, storeOrderId: id, orderId: `history_refund_${id}`,
        applyType: 2, refundType, refundNum: 1, refundPrice: '5.00', refundedPrice: refundType === 6 ? '5.00' : '0.00',
        refundedTime: refundType === 6 ? 1700000010 : 0, isCancel: id === 21 ? 1 : 0, isDel: id === 47 ? 1 : 0,
        addTime: 1700000000, refundReason: '合成退款原因', refundExplain: '仅供本地读取', remark: '内部备注不可返回',
        cartInfo: JSON.stringify({ cartIds: [{ cartId: 2000 + id, cartNum: 1 }] }) });
    }
    await fixture.db.insert(systemConfig).values([
      { menuName: 'refund_name', value: '本地收件人' }, { menuName: 'refund_phone', value: '00000000000' },
      { menuName: 'refund_address', value: '本地测试退货地址，不发货' },
    ]);
    fixture.app.post('/api/order/refund/cancel/:uni', refundCancel);
    return fixture;
  } catch (error) { await fixture.close(); throw error; }
}
