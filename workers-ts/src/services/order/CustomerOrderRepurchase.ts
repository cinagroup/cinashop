import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { StoreCartService } from './StoreCartService';
import { addPresaleCartInTransaction } from '@/services/activity/PresaleCartService';
import { assertPresalePurchaseLimit, presalePurchaseLimits } from '@/services/activity/PresalePurchaseLimits';
import { assertCheckoutMembershipSnapshot } from './CheckoutMembershipSnapshot';
import { protectCheckoutPricingSources } from './CheckoutPricingSources';
import { readMembershipPricingPolicy } from '@/services/user/MembershipPricingPolicy';
import { assertProductPurchaseQuantity } from './ProductPurchaseAdmission';

const MAX_SOURCE_ROWS = 100, MAX_SNAPSHOT_BYTES = 32768;
const invalid = () => new ValidateException('原订单商品快照无法核对，请重新选择商品');
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function id(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2147483647; }

type Source = { id: number; uid: number; oid: number; productId: number; cartNum: number; skuUnique: string; cartInfo: string | null };
function selection(row: Source, orderType: number): { productId: number; unique: string; cartNum: number } | null {
  if (!id(row.productId) || !Number.isSafeInteger(row.cartNum) || row.cartNum < 1 || row.cartNum > 32767 || !row.cartInfo) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(row.cartInfo); } catch { throw invalid(); }
  const snapshot = object(parsed); if (!snapshot) throw invalid();
  // PHP tidyOrder keeps the JSON cart's activity type. The physical line.type
  // is merchant origin (platform/store/Supplier), and must not filter this flow.
  if (Object.hasOwn(snapshot, 'type')) {
    if (snapshot.type !== 0 && snapshot.type !== '0') return null;
  } else if (orderType !== 0 || snapshot.financial_version !== 'checkout-line-finance-v1') return null;
  const product = object(snapshot.product), legacy = object(snapshot.productInfo);
  for (const value of [snapshot.product_id, product?.id, legacy?.id]) {
    if (value !== undefined && String(value) !== String(row.productId)) throw invalid();
  }
  // Physical cart_num is authoritative, just as PHP tidyOrder overwrites the
  // historical JSON quantity. No historical price, gift or discount is copied.
  const keys = [row.skuUnique, object(snapshot.sku)?.unique, snapshot.product_attr_unique,
    object(legacy?.attrInfo)?.unique, object(product?.attrInfo)?.unique, object(snapshot.attrInfo)?.unique]
    .filter(value => value !== undefined && value !== null && value !== '');
  if (!keys.length || keys.some(value => typeof value !== 'string' || value.length > 16 || /[\s\x00-\x1f\x7f]/.test(value))
    || new Set(keys).size !== 1) throw invalid();
  return { productId: row.productId, unique: keys[0] as string, cartNum: row.cartNum };
}

/** Prepare independent direct-buy selections, never an order, payment or stock
 * reservation. Source facts and current catalogue admission share one atomic
 * transaction; any late row failure discards all newly prepared selections. */
export async function repurchaseCustomerOrder(container: Container, env: Env, uid: number, reference: unknown) {
  if (!id(uid) || typeof reference !== 'string' || !reference || reference.trim() !== reference
    || reference.length > 32 || /[\x00-\x1f\x7f]/.test(reference)) throw new ValidateException('订单参数无效');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    const orders = await tx.select().from(storeOrder).where(and(eq(storeOrder.orderId, reference),
      eq(storeOrder.uid, uid), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).limit(2).for('share');
    if (!orders.length) throw new NotFoundException('订单不存在');
    if (orders.length !== 1) throw new ValidateException('订单标识存在歧义');
    const order = orders[0];
    if ([1, 2, 3, 4, 5].includes(order.type)) throw new ValidateException('该活动商品不能再次购买，请从活动商品重新下单');
    const rows = await tx.select({ id: storeOrderCartInfo.id, uid: storeOrderCartInfo.uid, oid: storeOrderCartInfo.oid,
      productId: storeOrderCartInfo.productId, cartNum: storeOrderCartInfo.cartNum, skuUnique: storeOrderCartInfo.skuUnique,
      cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo}) <= ${MAX_SNAPSHOT_BYTES} THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
    }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id))
      .limit(MAX_SOURCE_ROWS + 1).for('share');
    if (!rows.length || rows.length > MAX_SOURCE_ROWS || rows.some(row => row.uid !== uid)) throw invalid();
    const selections = rows.map(row => selection(row, order.type)).filter((row): row is NonNullable<typeof row> => row !== null);
    if (!selections.length) throw new ValidateException('原订单没有可再次购买的普通商品，请重新下单');
    const productIds = [...new Set(selections.map(row => row.productId))].sort((a, b) => a - b);
    const skus = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0),
      or(...selections.map(row => and(eq(storeProductAttrValue.productId, row.productId), eq(storeProductAttrValue.unique, row.unique))))))
      .orderBy(asc(storeProductAttrValue.id)).for('share');
    // Checkout and presale writers lock the base SKU before its product.
    const products = await tx.select().from(storeProduct).where(inArray(storeProduct.id, productIds)).orderBy(asc(storeProduct.id)).for('share');
    const productQuantities = new Map<number, number>(), skuQuantities = new Map<number, number>();
    for (const item of selections) {
      const product = products.find(row => row.id === item.productId), matching = skus.filter(row => row.productId === item.productId && row.unique === item.unique);
      if (!product || product.isShow !== 1 || product.isDel !== 0 || product.isVerify !== 1 || matching.length !== 1) {
        throw new ValidateException('原订单商品或规格已下架、未审核或失效，请重新选择');
      }
      const sku = matching[0], productQuantity = (productQuantities.get(product.id) ?? 0) + item.cartNum,
        skuQuantity = (skuQuantities.get(sku.id) ?? 0) + item.cartNum;
      if (productQuantity > product.stock || skuQuantity > sku.stock) throw new ValidateException('再次购买商品库存不足，请重新选择数量');
      productQuantities.set(product.id, productQuantity); skuQuantities.set(sku.id, skuQuantity);
      if (product.isPresaleProduct !== 0) assertPresalePurchaseLimit(presalePurchaseLimits(product), productQuantity);
      else assertProductPurchaseQuantity(product, productQuantity);
      if (![0, 1].includes(product.isVipProduct)) throw new ValidateException('商品付费会员资格配置无效');
    }
    const memberOnly = products.some(product => product.isVipProduct === 1);
    let memberPredicate: SQL | undefined;
    const assertMember = async () => {
      const [active] = await tx.execute(sql`SELECT ${memberPredicate!} AS valid`);
      if (active?.valid !== true) throw new ValidateException('该商品仅限有效付费会员购买');
    };
    if (memberOnly) {
      if (!(await readMembershipPricingPolicy(tx)).paidMemberEnabled) throw new ValidateException('付费会员功能未开放，无法购买专享商品');
      // Mature NOWAIT member-row fence avoids a reverse wait edge after SKU
      // locks. Its DB-clock predicate must also run after all cart writes.
      memberPredicate = await assertCheckoutMembershipSnapshot(tx, { uid, paidActive: true,
        levelActive: null, levelId: null, level: null });
      await assertMember();
    }
    const cart = new StoreCartService(createContainerFromDb(tx), env), cartIds: number[] = [];
    for (const item of selections) {
      const params = { uid, ...item, type: 0, isNew: 1, activityId: 0 };
      const product = products.find(row => row.id === item.productId)!;
      const added = product.isPresaleProduct !== 0 ? await addPresaleCartInTransaction(tx, params) : await cart.add(params);
      cartIds.push(added.id);
    }
    if (memberOnly) {
      await protectCheckoutPricingSources(tx);
      if (!(await readMembershipPricingPolicy(tx)).paidMemberEnabled) throw new ValidateException('付费会员功能已变化，请重新确认');
      await assertMember();
    }
    return { cartIds, cateId: cartIds.join(','), sourceOrderId: order.orderId, sourceRowId: order.id };
  });
}
