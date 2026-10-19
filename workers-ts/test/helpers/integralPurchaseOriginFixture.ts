/** Owned native PG16 column fixture. Real Admin bulk clone, direct exchange,
 * refund and provenance SQL run as the fixture maintenance owner. This does
 * not certify a full registered schema, production runtime grants, provider
 * settlement, delivered virtual goods, or complete pre-activation history. */
import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { storeIntegral, storeProduct, storeProductAttrValue } from '../../src/models/schema';
import { ActivityService } from '../../src/services/activity/ActivityService';
import { readPurchaseOriginEvidence } from '../../src/services/order/PurchaseOriginEvidence';
import { readPurchaseQuotaHistory } from '../../src/services/order/PurchaseQuotaHistory';
import { integralBatchActor, integralBatchFixture } from './integralBatchFixture';

const stateTables = ['user', 'store_cart', 'store_order', 'store_order_cart_info',
  'store_order_status', 'store_order_outbox', 'user_bill', 'store_order_refund',
  'store_order_refund_payment', 'store_order_refund_split', 'store_order_fulfillment_branch',
  'store_order_purchase_origin', 'fixture_integral_origin_observation'] as const;

export async function integralPurchaseOriginFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Integral origin requires native PostgreSQL16');
  const f = await integralBatchFixture(true);
  try {
    // Observe the actual capture event, rather than infer its paid state from
    // the final row. This owned test relation is transactional and cannot make
    // a failed exchange leave behind a receipt or a fabricated observation.
    await f.exec(`CREATE TABLE public.fixture_integral_origin_observation (
      order_id integer PRIMARY KEY, captured_paid smallint NOT NULL, root_cart_id text,
      detail_id integer NOT NULL, detail_cart_id text NOT NULL, snapshot_id jsonb,
      pay_integral integer NOT NULL, use_integral numeric(12,2) NOT NULL);
      CREATE FUNCTION public.fixture_observe_integral_origin() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        INSERT INTO public.fixture_integral_origin_observation
        SELECT o.id,o.paid,o.cart_id,d.id,d.cart_id,d.cart_info::jsonb->'id',o.pay_integral,o.use_integral
        FROM public.store_order o JOIN public.store_order_cart_info d ON d.oid=o.id
        WHERE o.id=NEW.order_id;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_observe_integral_origin AFTER INSERT ON public.store_order_purchase_origin
        FOR EACH ROW EXECUTE FUNCTION public.fixture_observe_integral_origin()`);

    async function virtualSource(productType: 1 | 2) {
      await f.db.update(storeProduct).set({ productType, freight: 1, postage: '0.00', tempId: 0 })
        .where(eq(storeProduct.id, 70));
      await f.db.update(storeProductAttrValue).set({ productType,
        diskInfo: productType === 1 ? 'owned-integral-origin-virtual-content' : '' })
        .where(and(eq(storeProductAttrValue.productId, 70), eq(storeProductAttrValue.type, 0)));
    }
    async function modern(productType: 1 | 2) {
      await virtualSource(productType);
      const input = await f.input([70]);
      for (const sku of input.products[0].skus) sku.price = '0.00';
      const created = await f.serviceFor().create(input, integralBatchActor);
      const integralId = created.products[0].integral_id;
      const values = await f.db.select().from(storeProductAttrValue);
      const activitySku = values.find(row => row.type === 4 && row.productId === integralId && row.suk === '蓝');
      const baseSku = values.find(row => row.type === 0 && row.productId === 70 && row.unique === 'blue0070');
      if (!activitySku || !baseSku) throw Error('Real bulk clone did not return the exact blue SKU pair');
      return { integralId, activitySku, baseSku, productType };
    }
    async function legacy() {
      await virtualSource(1);
      const [item] = await f.db.insert(storeIntegral).values({ productId: 70, productType: 1,
        storeName: 'owned pre-modern integral catalogue', price: '0.00', integral: 7,
        stock: 20, quota: 0, postage: '0.00', status: 1, isShow: 1, isDel: 0 }).returning();
      return { integralId: item.id, unique: 'blue0070' };
    }
    const activityFor = (db: DbClient = f.db) => new ActivityService(createContainerFromDb(db), f.env);
    const origins = async () => Array.from(await f.db.execute(sql`SELECT * FROM public.store_order_purchase_origin ORDER BY order_id`));
    const observations = async () => Array.from(await f.db.execute(sql`SELECT * FROM public.fixture_integral_origin_observation ORDER BY order_id`));
    const origin = (orderId: number, buyerId = 11) => f.db.transaction(
      tx => readPurchaseOriginEvidence(tx, { orderId, buyerId }), { accessMode: 'read only' });
    const history = () => f.db.transaction(tx => readPurchaseQuotaHistory(tx, 11),
      { isolationLevel: 'repeatable read', accessMode: 'read only' });
    const state = async () => ({ graph: await f.snapshot(), tables: Object.fromEntries(await Promise.all(
      stateTables.map(async table => [table, Array.from(await f.db.execute(sql.raw(
        `SELECT * FROM public.${table} AS captured ORDER BY to_jsonb(captured)::text`)))]))) });
    return { ...f, modern, legacy, activityFor, origins, observations, origin, history, state };
  } catch (error) { await f.close(); throw error; }
}
