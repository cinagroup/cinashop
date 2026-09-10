import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { seckillIndex, seckillList, seckillDetail } from '../../src/controllers/api/v1/UserActivityController';
import { cartAdd, cartList } from '../../src/controllers/api/v1/OrderController';
import { storeActivity, storeSeckillTime, storeSeckill, storeProductAttrValue, storeCart, systemConfig } from '../../src/models/schema';
import type { AppVariables, Env } from '../../src/env';

/** In-process disposable HTTP/SQL fixture. No listener, production auth, order-create or payment route. */
export async function createPcSeckillFixture() {
  const f = await createPcCheckoutQuoteFixture([storeActivity, storeSeckillTime, storeSeckill, systemConfig]);
  try {
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.delete(storeCart);
    const today = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
    await f.db.insert(storeActivity).values({ id: 900, type: 1, status: 1, startDay: today - 86400, endDay: today + 86400, timeId: '4,8' });
    await f.db.insert(storeSeckillTime).values([
      { id: 4, startTime: '0000', endTime: '2400', status: 1 },
      { id: 8, startTime: '0001', endTime: '2400', status: 1 },
    ]);
    await f.db.insert(storeSeckill).values([
      { id: 20, activityId: 900, productId: 70, storeName: '秒杀红蓝双规格', price: '6.25', otPrice: '10.00',
        stock: 8, quota: 8, quotaShow: 8, onceNum: 3, num: 6, timeId: '4', image: '/api/qa/image.svg' },
      { id: 21, activityId: 900, productId: 70, storeName: '另一时段秒杀', price: '7.25', otPrice: '10.00',
        stock: 8, quota: 8, quotaShow: 8, onceNum: 3, num: 6, timeId: '8', image: '/api/qa/image.svg' },
    ]);
    await f.db.insert(storeProductAttrValue).values([
      { id: 2, productId: 70, type: 0, unique: 'qablue01', suk: '蓝色,小号', stock: 2, price: '20.00' },
      { id: 3, productId: 20, type: 1, unique: 'actred20', suk: '红色,大号', stock: 7, quota: 6, price: '6.25', otPrice: '10.00' },
      { id: 4, productId: 20, type: 1, unique: 'actblu20', suk: '蓝色,小号', stock: 4, quota: 4, price: '8.75', otPrice: '20.00' },
      { id: 5, productId: 21, type: 1, unique: 'actred21', suk: '红色,大号', stock: 7, quota: 6, price: '7.25', otPrice: '10.00' },
    ]);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', f.container);
      // Synthetic identity in the disposable fixture only; never an auth replacement in the Worker.
      c.set('uid', c.req.header('Authori-zation') === 'Bearer isolated-seckill-session' ? 11 : 0);
      await next();
    });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get('/api/seckill/index', seckillIndex);
    app.get('/api/seckill/list/:time', seckillList);
    app.get('/api/seckill/detail/:id', seckillDetail);
    app.post('/api/cart/add', cartAdd);
    app.get('/api/cart/list', cartList);
    return { ...f, app,
      setActive: (active: boolean) => f.db.update(storeActivity).set({ status: active ? 1 : 0 }).where(eq(storeActivity.id, 900)),
      clearCarts: () => f.db.delete(storeCart),
    };
  } catch (error) { await f.close(); throw error; }
}
