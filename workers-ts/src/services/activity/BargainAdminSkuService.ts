import { and, asc, eq, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { storeBargain, storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue } from "@/models/schema";
import { PRODUCT_SKU_IDENTITY_LOCK_KEY, PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from "@/services/product/ProductSkuIdentity";
import { ValidateException } from "@/utils/errors";
import { readBargainContent } from './BargainContentService';
import { bargainShippingFields, readBargainShippingTemplates } from './BargainAdminShippingService';

type Sku = typeof storeProductAttrValue.$inferSelect;
export interface BargainSkuInput {
  baseUnique: string;
  expected?: { id: number; unique: string; stock: number; quota: number } | null;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new ValidateException("砍价规格原值无效");
  return value;
}
function unique(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{8}$/.test(value)) throw new ValidateException("砍价规格标识无效");
  return value;
}
export function parseBargainSku(value: unknown): BargainSkuInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidateException("请选择砍价规格");
  const input = value as Record<string, unknown>;
  const result: BargainSkuInput = { baseUnique: unique(input.baseUnique) };
  if (input.expected === null) result.expected = null;
  else if (input.expected !== undefined) {
    if (!input.expected || typeof input.expected !== "object" || Array.isArray(input.expected)) throw new ValidateException("砍价规格原值无效");
    const expected = input.expected as Record<string, unknown>;
    result.expected = { id: integer(expected.id), unique: unique(expected.unique), stock: integer(expected.stock), quota: integer(expected.quota) };
    if (!result.expected.id) throw new ValidateException("砍价规格原值无效");
  }
  return result;
}
function routeId(value: string | undefined, optional = false): number {
  if (optional && value === undefined) return 0;
  if (!value || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) throw new ValidateException("活动或商品ID无效");
  return Number(value);
}
const projection = { id: storeProductAttrValue.id, unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk,
  stock: storeProductAttrValue.stock, quota: storeProductAttrValue.quota, price: storeProductAttrValue.price, image: storeProductAttrValue.image };
export async function readBargainSkuOptions(container: Container, product: string | undefined, activity: string | undefined) {
  const productId = routeId(product), activityId = routeId(activity, true);
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql.raw(`SELECT
      set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    const [source] = await tx.select({ id: storeProduct.id, type: storeProduct.type, relationId: storeProduct.relationId,
      productType: storeProduct.productType }).from(storeProduct).where(and(eq(storeProduct.id, productId),
      eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1), eq(storeProduct.isVipProduct, 0), eq(storeProduct.isPresaleProduct, 0))).limit(1);
    if (!source) throw new ValidateException("原商品不符合砍价资格");
    let content: Awaited<ReturnType<typeof readBargainContent>> | null = null;
    let shipping: ReturnType<typeof bargainShippingFields> | null = null;
    if (activityId) {
      const [row] = await tx.select().from(storeBargain).where(and(eq(storeBargain.id, activityId),
        eq(storeBargain.productId, productId), eq(storeBargain.isDel, 0))).limit(1);
      if (!row) throw new ValidateException("砍价活动与商品不匹配");
      content = await readBargainContent(tx,activityId,row);
      shipping = bargainShippingFields(row);
    }
    const options = await tx.select(projection).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId),
      eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0))).orderBy(asc(storeProductAttrValue.id)).limit(501);
    const current = activityId ? await tx.select(projection).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, activityId),
      eq(storeProductAttrValue.type, 2))).orderBy(asc(storeProductAttrValue.id)).limit(501) : [];
    if (options.length > 500 || current.length > 500) throw new ValidateException("规格超过500项，请先整理");
    return { productId, activityId, options, current, content,
      shipping: { current: shipping, productType: source.productType, templates: await readBargainShippingTemplates(tx, source) } };
  });
}

/** The source product SHARE is already held by saveBargain. Secondary locks must
 * fail fast: checkout can own a base SKU before updating source product stock,
 * and other allocators can own the identity lock before locking product rows.
 * Never wait on either while holding source SHARE; roll back and ask for retry.
 */
export async function saveBargainSku(tx: DbClient, activityId: number, productId: number, input: BargainSkuInput,
  rules: { stock: number; quota: number; price: string; stockProvided?: boolean; quotaProvided?: boolean }, creating: boolean): Promise<void> {
  const [lock] = await tx.select({ acquired: sql<boolean>`pg_try_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},${PRODUCT_SKU_IDENTITY_LOCK_KEY})` })
    .from(sql`(VALUES(1)) AS identity_probe(n)`);
  if (!lock.acquired) throw new ValidateException("商品规格正在更新，请稍后重试");
  let current: Sku[], sources: Sku[];
  try {
    current = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, activityId),
      eq(storeProductAttrValue.type, 2))).orderBy(asc(storeProductAttrValue.id)).limit(2).for("no key update", { noWait: true });
    sources = await tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId),
      eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.unique, input.baseUnique), eq(storeProductAttrValue.isRetired, 0)))
      .limit(2).for("share", { noWait: true });
  } catch (error) {
    let cause: unknown = error;
    while (cause && typeof cause === "object" && "cause" in cause && cause.cause) cause = cause.cause;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "55P03") throw new ValidateException("规格库存正在变化，请刷新后重试");
    throw error;
  }
  if (sources.length !== 1) throw new ValidateException("原商品规格不存在、已退役或标识重复");
  const base = sources[0], existing = current[0];
  const matches = await tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue).where(and(
    eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0),
    eq(storeProductAttrValue.suk, base.suk), eq(storeProductAttrValue.isRetired, 0))).limit(2);
  if (matches.length !== 1) throw new ValidateException("原商品规格组合重复，请先整理商品规格");
  if (current.length > 1) throw new ValidateException("现有多规格砍价须专项整理，不能自动删减规格");
  if (existing?.isRetired) throw new ValidateException("已退役规格不能通过保存恢复");
  if (existing && existing.suk !== base.suk) throw new ValidateException("已有活动规格不能替换，请新建砍价活动");
  if (!creating && (existing ? !input.expected || input.expected.id !== existing.id || input.expected.unique !== existing.unique ||
    input.expected.stock !== existing.stock || input.expected.quota !== existing.quota : input.expected !== null)) {
    throw new ValidateException("砍价规格已变化，请刷新后重试");
  }
  // Price-only edits must not replay main-row stock over a differing SKU count.
  const stock = integer(existing && !rules.stockProvided ? existing.stock : rules.stock);
  const quota = integer(existing && !rules.quotaProvided ? existing.quota : rules.quota);
  if (quota > stock || stock > integer(base.stock)) throw new ValidateException("活动库存或额度不能超过原商品规格库存");
  const dimensions = await tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, productId),
    eq(storeProductAttr.type, 0))).orderBy(asc(storeProductAttr.id)).limit(11);
  const parts = base.suk.split(',');
  if (!dimensions.length || dimensions.length > 10 || dimensions.length !== parts.length ||
    new Set(dimensions.map(row => row.attrName)).size !== dimensions.length || dimensions.some((row, index) =>
      !row.attrName || !parts[index] || !row.attrValues.split(',').includes(parts[index]))) {
    throw new ValidateException("原商品属性与规格不一致，请先整理商品规格");
  }
  let identity = existing?.unique ?? '';
  for (let attempt = 0; !identity && attempt < 8; attempt++) {
    const candidate = Array.from(crypto.getRandomValues(new Uint8Array(4)), byte => byte.toString(16).padStart(2, '0')).join('');
    const rows = await tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue).where(eq(storeProductAttrValue.unique, candidate)).limit(1);
    if (!rows.length) identity = candidate;
  }
  if (!identity) throw new ValidateException("暂时无法分配规格标识，请重试");
  const values = { productType: base.productType, stock, quota, price: rules.price,
    ...(existing && existing.quota === quota ? {} : { quotaShow: quota }),
    image: base.image, cost: base.cost, settlePrice: base.settlePrice, otPrice: base.otPrice, vipPrice: base.vipPrice,
    barCode: base.barCode, code: base.code, weight: base.weight, volume: base.volume,
    brokerage: base.brokerage, brokerageTwo: base.brokerageTwo, diskInfo: base.diskInfo,
    writeTimes: base.writeTimes, writeValid: base.writeValid, writeDays: base.writeDays, writeStart: base.writeStart, writeEnd: base.writeEnd };
  if (existing) await tx.update(storeProductAttrValue).set(values).where(eq(storeProductAttrValue.id, existing.id));
  else await tx.insert(storeProductAttrValue).values({ ...values, productId: activityId, type: 2, suk: base.suk, unique: identity,
    sales: 0, sumStock: stock });
  const attrs = dimensions.map((row, index) => ({ value: row.attrName, detail: [parts[index]] }));
  const result = { attr: attrs, value: [{ detail: Object.fromEntries(dimensions.map((row, index) => [row.attrName, parts[index]])),
    unique: identity, suk: base.suk, price: rules.price, stock, quota, pic: base.image }] };
  await tx.delete(storeProductAttr).where(and(eq(storeProductAttr.productId, activityId), eq(storeProductAttr.type, 2)));
  await tx.insert(storeProductAttr).values(dimensions.map((row, index) => ({ productId: activityId, type: 2, attrName: row.attrName, attrValues: parts[index] })));
  await tx.delete(storeProductAttrResult).where(and(eq(storeProductAttrResult.productId, activityId), eq(storeProductAttrResult.type, 2)));
  await tx.insert(storeProductAttrResult).values({ productId: activityId, type: 2, result: JSON.stringify(result), changeTime: sql`floor(extract(epoch from clock_timestamp()))::int` });
}
