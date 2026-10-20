/** Owned native column fixtures, reusing real quote/protected-origin and full
 * gift commissioning. The HTTP user, rule edits and local number are labelled
 * fixture inputs, not App/JWT, Admin authorization or runtime grant evidence. */
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { printDocument, storeCart, storeCouponIssue, storeCouponIssueUser,
  storeCouponProduct, storeCouponUser, storeOrderOutbox,
  storeOrderPromotions, storeOrderStatus, storeProduct, storeProductAttrValue,
  storeProductCategory, storePromotions, storePromotionsAuxiliary, systemUserLevel,
  user } from '../../src/models/schema';
import { CartComputationService } from '../../src/services/order/CartComputationService';
import { StoreCartService } from '../../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../../src/services/order/StoreOrderCreateService';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { productPurchaseGiftFixture } from './productPurchaseAuthorsFixture';

export const ordinaryShortUnique = 'short7';
export interface ShortSkuReceipt { orderKey: string; quoteToken: string;
  cartInfo: Array<Record<string, unknown>>; priceGroup: Record<string, string> }
type QuoteFixture = Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
const password = 'short-sku-fixture-password';

async function prepare(f: QuoteFixture) {
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.db.update(user).set({ pwd: password, isEverLevel: 0, isMoneyLevel: 0,
    status: 1, isDel: 0, deleteTime: null }).where(eq(user.uid, 11));
  await f.db.update(storeProduct).set({ price: '17.00', stock: 40, isVip: 0,
    isLimit: 0, limitType: 0, limitNum: 0, freight: 1, postage: '0.00', tempId: 0,
    deliveryType: '1' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ unique: ordinaryShortUnique, price: '10.00', stock: 40 })
    .where(eq(storeProductAttrValue.id, 1));
  // Actual budget scope accepts reusable rows only; confirmation/create select
  // this same row through their independent checkout scope.
  await f.db.update(storeCart).set({ productAttrUnique: ordinaryShortUnique, cartNum: 2, isNew: 0 })
    .where(eq(storeCart.id, 1));
}
function compute(f: QuoteFixture) {
  return new CartComputationService(f.container).compute({ uid: 11, passwordVersion: password,
    expiresAt: Math.floor(Date.now() / 1000) + 3600 }, { cartIds: [1], shippingType: 1 });
}

export async function ordinaryShortSkuPromotionFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Short SKU promotion tests require owned native PG16');
  const f = await createPcCheckoutQuoteFixture([printDocument, storeOrderStatus, storeOrderOutbox,
    storeOrderPromotions, storeCouponIssue, storeCouponIssueUser, storeCouponProduct,
    storeCouponUser, storeProductCategory, systemUserLevel]);
  try {
    await prepare(f);
    const now = Math.floor(Date.now() / 1000);
    // Explicit reviewed price-policy fixture state; the actual quote and writer
    // below remain authoritative. This does not claim an Admin HTTP mutation.
    const [promotion] = await f.db.insert(storePromotions).values({ type: 1, pid: 0, storeId: 0,
      promotionsType: 1, name: '短规格九折', discount: '90.00', productPartakeType: 2,
      startTime: now - 60, stopTime: now + 3600, status: 1, isDel: 0, updateTime: now }).returning();
    await f.db.insert(storePromotionsAuxiliary).values({ promotionsId: promotion.id, type: 1,
      productPartakeType: 2, productId: 70, unique: ordinaryShortUnique, isAll: 0 });
    let serial = 0;
    const state = async (db: DbClient = f.db) => Object.fromEntries(await Promise.all([
      'user', 'store_cart', 'store_product', 'store_product_attr_value', 'store_promotions',
      'store_promotions_auxiliary', 'store_order', 'store_order_cart_info', 'store_order_status',
      'store_order_outbox', 'store_order_promotions', 'user_bill', 'store_coupon_user',
      'store_order_purchase_origin', 'store_order_purchase_physical_origin',
    ].map(async table => [table, Array.from(await db.execute(sql.raw(
      `SELECT to_jsonb(captured) AS row FROM public.${table} AS captured ORDER BY to_jsonb(captured)::text`)))])));
    const confirm = async () => {
      const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify({
        cartIds: [1], type: 0, addressId: 11, shippingType: 1, useIntegral: false }) }, f.env);
      return response.json<{ status: number; msg: string; data: ShortSkuReceipt | null }>();
    };
    const create = (receipt: ShortSkuReceipt, db: DbClient = f.db) => StoreOrderCreateService.createWithRuntime(
      createContainerFromDb(db), { CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true,
        requireConfirmation: true, nextOrderId: async () => `short_sku_promotion_${++serial}` }, {
        uid: 11, cartIds: [1], type: 0, addressId: 11, shippingType: 1, useIntegral: false,
        key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });
    const quote = () => new StoreOrderCreateService(f.container, f.env).quoteOrder({
      uid: 11, cartIds: [1], type: 0, addressId: 11, shippingType: 1, useIntegral: false });
    return { ...f, state, confirm, create, quote, promotionId: promotion.id,
      cart: () => new StoreCartService(f.container, f.env), compute: () => compute(f) };
  } catch (error) { await f.close(); throw error; }
}

export async function ordinaryShortSkuGiftFixture() {
  const f = await productPurchaseGiftFixture();
  try {
    await prepare(f);
    // Retain the real Admin-created gift campaign/entitlement protocols, then
    // explicitly move its selected paid-SKU fixture scope to the short identity.
    await f.db.update(storePromotionsAuxiliary).set({ unique: ordinaryShortUnique })
      .where(eq(storePromotionsAuxiliary.productId, 70));
    return { ...f, cart: () => new StoreCartService(f.container, f.env), compute: () => compute(f) };
  } catch (error) { await f.close(); throw error; }
}
