/** Native PG16 column fixture around the actual cart, budget, confirmation and
 * order writers. Its HTTP shell sets a labelled fixture user, not production
 * JWT/authentication evidence. No provider, full ORM-schema or runtime-grant
 * claim; the real checkout-pricing and immutable origin protocols are installed
 * by the existing owned quote fixture. */
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { storeCart, storeProduct, storeProductAttrValue, storeProductCategory, user, storeOrder,
  storeOrderCartInfo, storeOrderStatus, storeOrderOutbox, printDocument,
  storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponUser,
  systemUserLevel } from '../../src/models/schema';
import { CartComputationService } from '../../src/services/order/CartComputationService';
import { StoreCartService } from '../../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../../src/services/order/StoreOrderCreateService';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';

export interface ProductAdmissionReceipt { orderKey: string; quoteToken: string }
type ProductRules = Pick<typeof storeProduct.$inferSelect, 'isLimit' | 'limitType' | 'limitNum'>;
const rulesDisabled: ProductRules = { isLimit: 0, limitType: 0, limitNum: 0 };

export async function productPurchaseAdmissionFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Product admission requires owned native PostgreSQL16');
  const f = await createPcCheckoutQuoteFixture([storeOrderStatus, storeOrderOutbox, printDocument,
    storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponUser, storeProductCategory, systemUserLevel]);
  try {
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(user).set({ pwd: 'product-limit-fixture-password', isEverLevel: 0,
      isMoneyLevel: 0, status: 1, isDel: 0, deleteTime: null }).where(eq(user.uid, 11));
    await f.db.update(storeProduct).set({ ...rulesDisabled, stock: 40, isVip: 0,
      freight: 1, postage: '0.00', tempId: 0, deliveryType: '1,2,3' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ stock: 40 }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 70, type: 0,
      unique: 'qablue02', suk: '蓝色,小号', stock: 40, price: '10.00' });
    // The inherited fixture explicitly inserts cart id=1. Commission ONLY this
    // owned sequence before real add() inserts, retaining nontransactional gaps.
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('public.store_cart','id'),
      (SELECT MAX(id) FROM public.store_cart),true)`);
    let orderNumber = 0;
    const cart = (db: DbClient = f.db) => new StoreCartService(createContainerFromDb(db), f.env);
    const limits = async (patch: Partial<ProductRules>, db: DbClient = f.db) => {
      // Labelled Admin-state edit, not a claim about an Admin HTTP authorizer.
      await db.update(storeProduct).set(patch).where(eq(storeProduct.id, 70));
    };
    const insertCart = async (patch: Partial<typeof storeCart.$inferInsert> = {}) => {
      const [row] = await f.db.insert(storeCart).values({ uid: 11, productId: 70,
        productAttrUnique: 'qared001', cartNum: 1, isNew: 0, status: 1, ...patch }).returning();
      return row;
    };
    const compute = (cartIds: number[]) => new CartComputationService(f.container).compute({ uid: 11,
      passwordVersion: 'product-limit-fixture-password', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    { cartIds, shippingType: 1 });
    const quote = (cartIds: number[]) => new StoreOrderCreateService(f.container, f.env)
      .quoteOrder({ uid: 11, cartIds, type: 0, addressId: 11, shippingType: 1 });
    const confirm = async (cartIds: number[]) => {
      const response = await f.app.request('/api/order/confirm', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
        body: JSON.stringify({ cartIds, type: 0, addressId: 11, shippingType: 1, useIntegral: false }),
      }, f.env);
      return response.json<{ status: number; msg: string; data: ProductAdmissionReceipt | null }>();
    };
    const create = (cartIds: number[], key: string = crypto.randomUUID(), options: {
      db?: DbClient; receipt?: ProductAdmissionReceipt; nextOrderId?: () => Promise<void>;
    } = {}) => StoreOrderCreateService.createWithRuntime(createContainerFromDb(options.db ?? f.db), {
      CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true,
      ...(options.receipt ? { requireConfirmation: true as const } : {}),
      nextOrderId: async () => { await options.nextOrderId?.(); return `product_admission_${++orderNumber}`; },
    }, { uid: 11, cartIds, key: options.receipt?.orderKey ?? key, quoteToken: options.receipt?.quoteToken,
      type: 0, addressId: 11, shippingType: 1, useIntegral: false, userIp: '127.0.0.1' });
    const state = async () => ({ ...await f.snapshot(),
      carts: await f.db.select().from(storeCart).orderBy(storeCart.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
      details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
      outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id),
      coupons: await f.db.select().from(storeCouponUser).orderBy(storeCouponUser.id),
      physicalOrigins: Array.from(await f.db.execute(sql`SELECT * FROM public.store_order_purchase_physical_origin ORDER BY order_id`)),
      origins: Array.from(await f.db.execute(sql`SELECT * FROM public.store_order_purchase_origin ORDER BY order_id`)),
    });
    return { ...f, cart, limits, insertCart, compute, quote, confirm, create, state };
  } catch (error) { await f.close(); throw error; }
}
