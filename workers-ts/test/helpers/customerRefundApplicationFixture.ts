import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import type { PgTable } from 'drizzle-orm/pg-core';
import { orderDetail } from '../../src/controllers/api/v1/OrderController';
import { refundApply, refundList, refundDetail } from '../../src/controllers/api/v1/PayController';
import { storeOrder, storeOrderCartInfo, storeOrderEconomize, storeOrderInvoice, storeOrderPromotions,
  storePromotions, storeOrderWriteoff, storeOrderRefund, storeOrderStatus } from '../../src/models/schema';

/** Disposable owner-scoped refund APPLICATION fixture. No approval, payout or cancellation route. */
export async function customerRefundApplicationFixture(extraTables: PgTable[] = []) {
  const fixture = await createPcCheckoutQuoteFixture([storeOrderCartInfo, storeOrderEconomize, storeOrderInvoice,
    storeOrderPromotions, storePromotions, storeOrderWriteoff, storeOrderRefund, storeOrderStatus, ...extraTables]);
  try {
    for (let id = 1; id <= 4; id++) {
      await fixture.db.insert(storeOrder).values({ id, orderId: `local_refund_${id}`, uid: id === 4 ? 22 : 11,
        totalNum: 2, totalPrice: '10.00', payPrice: '10.00', paid: 1, payType: 'yue', addTime: 1700000000 });
      await fixture.db.insert(storeOrderCartInfo).values({ id, oid: id, uid: id === 4 ? 22 : 11, productId: 70,
        cartId: String(500 + id), cartNum: 2, isSupportRefund: 1,
        cartInfo: JSON.stringify({ product: { storeName: `本地退款样本 ${id}`, image: '/api/qa/image.svg' }, sku: { price: '5.00', suk: '红色' } }) });
    }
    fixture.app.get('/api/order/detail/:uni', orderDetail);
    fixture.app.post('/api/order/refund/apply/:id', refundApply);
    fixture.app.get('/api/order/refund/list', refundList);
    fixture.app.get('/api/order/refund/detail/:uni', refundDetail);
    const applications = () => fixture.db.select().from(storeOrderRefund);
    const statuses = () => fixture.db.select().from(storeOrderStatus);
    return { ...fixture, applications, statuses };
  } catch (error) { await fixture.close(); throw error; }
}
