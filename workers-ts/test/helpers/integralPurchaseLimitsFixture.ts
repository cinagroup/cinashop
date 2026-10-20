/** Native owned public PG16 column fixture. Admin bulk cloning and cap edits,
 * real cart admission, unified creation and direct exchange execute their real
 * services/controllers. The small Admin HTTP shell supplies the fixture
 * container, not production authentication/permission evidence. No provider,
 * completed historical coverage, production grants or synthetic paid admission. */
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { adminActivitySave } from '../../src/controllers/api/v1/AdminCrudController';
import { storeIntegral, storeProduct, storeProductAttrValue } from '../../src/models/schema';
import { ActivityService } from '../../src/services/activity/ActivityService';
import { StoreCartService } from '../../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../../src/services/order/StoreOrderCreateService';
import { integralBatchActor, integralBatchFixture } from './integralBatchFixture';

export type IntegralAuthor = 'direct' | 'create';
export type IntegralIntent = { author: IntegralAuthor; key: string; quantity: number; cartId?: number };
const stateTables = ['user', 'store_cart', 'store_order', 'store_order_cart_info', 'store_order_status',
  'store_order_outbox', 'user_bill', 'store_order_refund', 'store_order_refund_payment',
  'store_order_refund_split', 'store_order_fulfillment_branch', 'store_order_purchase_origin', 'store_order_purchase_physical_origin',
  'store_order_purchase_cancellation'] as const;

export async function integralPurchaseLimitsFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Integral limits require owned native PG16');
  const f = await integralBatchFixture(true);
  try {
    await f.db.update(storeProduct).set({ productType: 2, freight: 1, postage: '0.00', tempId: 0 })
      .where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ productType: 2 })
      .where(and(eq(storeProductAttrValue.productId, 70), eq(storeProductAttrValue.type, 0)));
    const input = await f.input([70]);
    for (const sku of input.products[0].skus) sku.price = '0.00';
    const cloned = await f.serviceFor().create(input, integralBatchActor);
    const integralId = cloned.products[0].integral_id;
    const [initial] = await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, integralId));
    if (initial.num !== 0 || initial.onceNum !== 0) throw Error('PHP bulk defaults must remain zero, not silently unlimited');
    const [activitySku] = await f.db.select().from(storeProductAttrValue).where(and(
      eq(storeProductAttrValue.productId, integralId), eq(storeProductAttrValue.type, 4), eq(storeProductAttrValue.suk, '蓝')));
    if (!activitySku) throw Error('Real batch did not create selected integral SKU');
    const adminCaps = async (patch: Record<string, unknown>, db: DbClient = f.db) => {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
      app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
      app.post('/activity/save', adminActivitySave);
      const response = await app.request('/activity/save', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'integral', id: integralId, ...patch }) }, f.env);
      return response.json<{ status: number; msg: string; data: unknown }>();
    };
    const caps = async (onceNum: number, num: number) => {
      const saved = await adminCaps({ onceNum, num });
      if (saved.status !== 200) throw Error(`Actual Admin cap update rejected fixture: ${saved.msg}`);
    };
    // Explicit new fixture policy. Persisted PHP zero defaults were verified
    // above; no production rows or old batch receipts are reinterpreted.
    await caps(-1, -1);
    const prepare = async (author: IntegralAuthor, quantity = 1, key = crypto.randomUUID()): Promise<IntegralIntent> => {
      if (author === 'direct') return { author, quantity, key };
      const cart = await new StoreCartService(f.container, f.env).add({ uid: 11, productId: 70,
        activityId: integralId, type: 4, unique: activitySku.unique, cartNum: quantity, isNew: 1 });
      return { author, quantity, key, cartId: cart.id };
    };
    const run = (intent: IntegralIntent, db: DbClient = f.db): Promise<{ orderId: string }> => intent.author === 'direct'
      ? new ActivityService(createContainerFromDb(db), f.env).exchange(11, integralId,
        intent.quantity, activitySku.unique, intent.key)
      : StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), {
        CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true,
        nextOrderId: async () => `limits_${intent.key.replaceAll('-', '').slice(0, 24)}`,
      }, { uid: 11, key: intent.key, cartIds: [intent.cartId!], type: 4, addressId: 11,
        shippingType: 1, useIntegral: false, userIp: '127.0.0.1' });
    const retained = async () => {
      const [row] = await f.db.execute(sql`SELECT COALESCE(SUM(total_num),0)::text AS total
        FROM public.store_order WHERE uid=11 AND type=4 AND activity_id=${integralId}
          AND pid IN(0,-1) AND (paid=1 OR (paid=0 AND is_del=0))`);
      return String(row.total);
    };
    const state = async () => ({ graph: await f.snapshot(), tables: Object.fromEntries(await Promise.all(
      stateTables.map(async table => [table, Array.from(await f.db.execute(sql.raw(
        `SELECT * FROM public.${table} AS captured ORDER BY to_jsonb(captured)::text`)))]))) });
    return { ...f, integralId, activitySku, originalBatchCaps: { onceNum: initial.onceNum, num: initial.num },
      adminCaps, caps, prepare, run, retained, state };
  } catch (error) { await f.close(); throw error; }
}
