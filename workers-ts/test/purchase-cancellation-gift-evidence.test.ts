import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { storeOrder, storeOrderCartInfo, userBill } from '@/models/schema/order';
import { storeOrderStatus } from '@/models/schema/order_refund';
import { PURCHASE_ORIGIN_DEFINITION_SQL } from '@/migrations/purchaseOriginEvidence';
import { PURCHASE_CANCELLATION_DEFINITION_SQL } from '@/migrations/purchaseCancellationEvidence';
import { PURCHASE_CANCELLATION_PROTECTION_SQL } from '@/migrations/purchaseCancellationEvidence';
import { PURCHASE_CANCELLATION_CATALOG_SQL, PURCHASE_CANCELLATION_FINGERPRINTS }
  from '@/migrations/purchaseCancellationEvidenceCatalog';
import { PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL, PURCHASE_CANCELLATION_GIFT_VALIDATE_BODY } from '@/migrations/purchaseCancellationGiftEvidence';
import { PURCHASE_CANCELLATION_GIFT_INSTALLATION_SQL }
  from '@/migrations/purchaseCancellationGiftEvidenceInstallation';
import { PURCHASE_CANCELLATION_GIFT_STATE_SQL }
  from '@/migrations/purchaseCancellationGiftEvidenceCatalog';
import { inspectPurchaseCancellationGiftEvidence,
  runPurchaseCancellationGiftEvidence } from '@/migrations/runPurchaseCancellationGiftEvidence';

describe('gift-aware purchase cancellation deferred evidence', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),
      api.generateDrizzleJson({ storeOrder, storeOrderCartInfo, userBill, storeOrderStatus }))).join('\n'));
    await f.exec(PURCHASE_ORIGIN_DEFINITION_SQL);
    await f.exec(PURCHASE_CANCELLATION_DEFINITION_SQL);
    await f.exec(PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL);
  }, 30_000);
  afterEach(async () => { await f?.close(); }, 45_000);

  async function seed(gift = true) {
    await f.db.insert(storeOrder).values({ id: 1, uid: 11, orderId: 'GIFT-CANCEL-LOCAL',
      unique: 'GIFT-CANCEL-LOCAL', type: 0, totalNum: 1, cartId: '1' });
    await f.db.insert(storeOrderCartInfo).values({ id: 1, oid: 1, uid: 11,
      cartId: '1', productId: 70, skuUnique: 'buy70', cartNum: 1,
      unique: 'purchase-row-1',
      surplusNum: 1, splitSurplusNum: 1,
      cartInfo: JSON.stringify({ financial_version: 'checkout-line-finance-v1',
        id: '1', cart_num: 1, product: { id: 70 }, sku: { id: 71, unique: 'buy70' },
        use_integral: '0' }) });
    await f.exec('INSERT INTO public.store_order_purchase_origin(order_id,buyer_id) VALUES (1,11)');
    if (!gift) return;
    const intent = { version: 'order-promotion-gifts-v1', price_promotions: [],
      promotions: [{ id: 101, tier_id: 101, name: '满送', label_id: [], eligible_cart_ids: ['1'],
        threshold_type: 1, threshold: '10.00', repetitions: 1, give_integral: 0,
        coupons: [], products: [{ aux_id: 202, product_id: 80, sku_id: 81,
          unique: 'gift80', quantity: 1, cart_id: '2147483647' }] }] };
    const zero = { sum_price: '0.00', vip_truePrice: '0.00', member_postage_price: '0.00',
      member_coupon_price: '0.00', raw_postage_price: '0.00', postage_price: '0.00',
      coupon_price: '0.00', integral_price: '0.00', first_order_price: '0.00',
      sum_true_price: '0.00', promotions_true_price: '0.00', costPrice: '0.00',
      one_brokerage: '0.00', two_brokerage: '0.00', division_staff_brokerage: '0.00',
      division_agent_brokerage: '0.00', division_brokerage: '0.00' };
    await f.db.insert(storeOrderCartInfo).values({ id: 2, oid: 1, uid: 11,
      cartId: '2147483647', productId: 80, skuUnique: 'gift80', cartNum: 1,
      unique: 'gift-row-2',
      isGift: 1, productType: 0, promotionsId: '101', settlePrice: '0.00',
      surplusNum: 1, splitSurplusNum: 1, writeTimes: 1, writeSurplusTimes: 1,
      cartInfo: JSON.stringify({ financial_version: 'checkout-line-finance-v1',
        id: '2147483647', cart_num: 1, product: { id: 80 },
        sku: { id: 81, unique: 'gift80', price: '0.00' },
        promotion_gift: { version: 'order-promotion-gifts-v1', root_id: 101,
          tier_id: 101, aux_id: 202 }, use_integral: '0', integral: 0,
        gain_integral: '0', ...zero }) });
    await f.db.update(storeOrder).set({ totalNum: 2, cartId: '1,2147483647',
      promotionsGive: JSON.stringify(intent) }).where(sql`${storeOrder.id}=1`);
  }
  const cancel = () => f.exec(`BEGIN; UPDATE public.store_order SET status=-2,is_del=1 WHERE id=1;
    INSERT INTO public.store_order_status(id,oid,change_type) VALUES (1,1,'cancel'); COMMIT`);
  const rows = async (statement: string): Promise<Record<string, unknown>[]> =>
    (await f.query(statement)).rows as Record<string, unknown>[];

  it('keeps the fixed 0171 artifact and recognizes only the exact gift validator body', async () => {
    const artifact = readFileSync('migrations/0171_purchase_cancellation_gift_evidence.sql', 'utf8');
    expect(artifact.trim()).toBe(PURCHASE_CANCELLATION_GIFT_INSTALLATION_SQL.trim());
    const [functionRow] = await rows(`SELECT prosrc,proconfig::text,provolatile,proparallel FROM pg_proc
      WHERE oid='public.validate_purchase_cancellation_v1()'::regprocedure`);
    const actual = String(functionRow.prosrc);
    expect({ length: actual.length, hash: createHash('sha256').update(actual).digest('hex'),
      config: functionRow.proconfig }).toEqual({ length: PURCHASE_CANCELLATION_GIFT_VALIDATE_BODY.length,
      hash: createHash('sha256').update(PURCHASE_CANCELLATION_GIFT_VALIDATE_BODY).digest('hex'),
      config: '{search_path=pg_catalog}' });
    const components = await rows(PURCHASE_CANCELLATION_CATALOG_SQL);
    expect(Object.fromEntries(components.filter(row => row.name !== 'validate_purchase_cancellation_v1'
      && row.name !== 'store_order_purchase_cancellation')
      .map(row => [row.name, row.fingerprint]))).toEqual(Object.fromEntries(
      Object.entries(PURCHASE_CANCELLATION_FINGERPRINTS)
        .filter(([name]) => name !== 'validate_purchase_cancellation_v1'
          && name !== 'store_order_purchase_cancellation')));
    if (f.format === 'pg16') expect(await rows(PURCHASE_CANCELLATION_GIFT_STATE_SQL))
      .toMatchObject([{ state: 'gift-v1' }]);
    await f.exec(`CREATE OR REPLACE FUNCTION public.validate_purchase_cancellation_v1()
      RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN RETURN NEW; END $$`);
    if (f.format === 'pg16') expect(await rows(PURCHASE_CANCELLATION_GIFT_STATE_SQL))
      .toMatchObject([{ state: 'drift' }]);
  });

  it('accepts unchanged purchased lines plus exact numeric gifted physical row', async () => {
    await seed(); await cancel();
    expect(await rows('SELECT order_id,total_num FROM public.store_order_purchase_cancellation'))
      .toEqual([{ order_id: 1, total_num: 1 }]);
  });

  it('preserves the canonical no-gift cancellation contract', async () => {
    await seed(false); await cancel();
    expect(await rows('SELECT order_id,total_num FROM public.store_order_purchase_cancellation'))
      .toEqual([{ order_id: 1, total_num: 1 }]);
  });

  it.each([
    ['quantity', `UPDATE public.store_order_cart_info SET cart_num=2,
      surplus_num=2,split_surplus_num=2,write_times=2,write_surplus_times=2 WHERE id=2`],
    ['missing gift', 'DELETE FROM public.store_order_cart_info WHERE id=2'],
    ['false monetary row', `UPDATE public.store_order_cart_info SET settle_price=1 WHERE id=2`],
    ['identity marker', `UPDATE public.store_order_cart_info SET promotions_id='102' WHERE id=2`],
    ['physical count', 'UPDATE public.store_order SET total_num=3 WHERE id=1'],
  ])('rejects %s while retaining origin and refund ledger', async (_name, mutation) => {
    await seed(); await f.exec(mutation);
    await expect(cancel()).rejects.toThrow();
    expect(await rows('SELECT count(*)::integer AS n FROM public.store_order_purchase_cancellation'))
      .toEqual([{ n: 0 }]);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('forwards exact old PG16 catalog once without data rewrite', async () => {
    const oldStart = PURCHASE_CANCELLATION_PROTECTION_SQL.indexOf(
      'CREATE FUNCTION public.validate_purchase_cancellation_v1()');
    const oldEnd = PURCHASE_CANCELLATION_PROTECTION_SQL.indexOf(
      'CREATE FUNCTION public.protect_purchase_cancellation_v1()');
    const oldValidate = PURCHASE_CANCELLATION_PROTECTION_SQL.slice(oldStart, oldEnd)
      .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
    await f.exec(oldValidate);
    expect(await inspectPurchaseCancellationGiftEvidence(f.db)).toMatchObject({ state: 'v1' });
    expect(PURCHASE_CANCELLATION_GIFT_INSTALLATION_SQL).toContain('CREATE OR REPLACE FUNCTION');
    await runPurchaseCancellationGiftEvidence(f.db);
    expect(await inspectPurchaseCancellationGiftEvidence(f.db)).toMatchObject({ state: 'gift-v1' });
  });
});
