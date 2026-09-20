import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { orderList, orderDetail, cartList } from '../../src/controllers/api/v1/OrderController';
import { orderCashier } from '../../src/controllers/api/v1/PayController';
import { storeOrder, storeOrderCartInfo, storeOrderEconomize, storeOrderInvoice,
  storeOrderPromotions, storePromotions, storeOrderWriteoff } from '../../src/models/schema';

/** Actual owner-scoped read controllers over disposable test SQL, never production. */
export async function customerOrderListFixture() {
  const fixture = await createPcCheckoutQuoteFixture([storeOrderCartInfo, storeOrderEconomize,
    storeOrderInvoice, storeOrderPromotions, storePromotions, storeOrderWriteoff]);
  try {
    for (let id = 1; id <= 34; id++) {
      const special: Record<number, { paid?: number; status?: number; shippingType?: number; deliveryType?: string; uid?: number; isDel?: number; isSystemDel?: number; pid?: number }> = {
        25:{paid:1,status:0},26:{paid:1,status:1,deliveryType:'express'},27:{paid:1,status:2},28:{paid:1,status:3},
        29:{paid:1,status:0,shippingType:2},30:{paid:1,status:4},31:{uid:22},32:{isDel:1},33:{isSystemDel:1},34:{pid:-1},
      };
      await fixture.db.insert(storeOrder).values({id,orderId:`local_list_${id}`,uid:11,totalNum:1,totalPrice:'10.00',payPrice:'10.00',
        addTime:1700000000,realName:'本地测试联系人',userPhone:'00000000000',userAddress:'隔离样本，不发货',...special[id]});
      await fixture.db.insert(storeOrderCartInfo).values({oid:id,uid:id===31?22:11,productId:70,cartNum:1,
        cartInfo:JSON.stringify({product:{storeName:`本地订单样本 ${id}`,image:'/api/qa/image.svg'},sku:{price:'10.00'}})});
    }
    fixture.app.get('/api/order/list',orderList);
    fixture.app.get('/api/order/detail/:uni',orderDetail);
    fixture.app.get('/api/order/cashier/:orderId/:type',orderCashier);
    fixture.app.get('/api/cart/list',cartList);
    return fixture;
  } catch(error) { await fixture.close(); throw error; }
}
