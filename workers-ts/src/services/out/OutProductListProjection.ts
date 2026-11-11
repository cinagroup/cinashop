import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductCategory, storeProductDescription, storeProductLabel } from '@/models/schema';
import { budgetLegacyProductRead } from '@/services/admin/AdminLegacyProductReadBudget';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedHtmlAttachmentReferences } from '@/services/content/ArticleContentPolicy';
import { legacyPhpJsonDecodeWire } from '@/utils/legacy-php-json';
import { ServiceUnavailableException } from '@/utils/errors';
import { outDetailIds, outDetailJson } from './OutProductDetailProjection';

type Product = typeof storeProduct.$inferSelect;
type Sku = typeof storeProductAttrValue.$inferSelect;
type Row = Record<string, unknown>;
const READ_BUDGET = 4 * 1024 * 1024;
const MAX_ROWS = 10_000;
const snake = (value: object): Row => Object.fromEntries(Object.entries(value)
  .map(([key, field]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), field]));
const camel = (value: Row): Row => Object.fromEntries(Object.entries(value).map(([key, field]) =>
  [key === 'is_police' ? 'isPolices' : key.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase()), field]));
const sqlIds = (values: number[]) => sql.join(values.map(value => sql`${value}`),sql`, `);
const phpTruthy = (value: string | null) => Boolean(value && value !== '0');
const numeric = (value: string): number => {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new ServiceUnavailableException('商品历史金额无效');
  return result;
};

/** The raw management list projection differs from the buyer-facing card:
 * actual sales and raw VIP offer, PHP model accessors, and type-0 SKU rows. */
export function outListProduct(row: Product): Row {
  const result = snake(row);
  delete result.is_polices;
  Object.assign(result, { is_police: row.isPolices, slider_image: legacyPhpJsonDecodeWire(row.sliderImage, 512 * 1024),
    custom_form: outDetailJson(row.customForm), label_id: outDetailIds(row.labelId),
    store_label_id: outDetailIds(row.storeLabelId), ensure_id: outDetailIds(row.ensureId), specs: outDetailJson(row.specs),
    delivery_type: phpTruthy(row.deliveryType) ? row.deliveryType.split(',') : [] });
  for (const key of ['price', 'vip_price', 'ot_price', 'postage', 'cost', 'give_integral']) result[key] = numeric(String(result[key]));
  return result;
}

export function outListSku(row: Sku): Row {
  const result = snake(row);
  // Retirement is a TS identity extension; preserve the distinction explicitly
  // so a historic SKU cannot be mistaken for an active purchasable SKU.
  return result;
}

/** Complete bounded expansion inside the same snapshot as list/count. */
export async function projectOutProductList(tx: DbClient, cards: Row[], appKey?: string): Promise<Row[]> {
  if (!cards.length) return [];
  if (cards.length > 100) throw new ServiceUnavailableException('商品列表超过单页读取容量');
  const ids = cards.map(row => Number(row.id));
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length)
    throw new ServiceUnavailableException('商品列表身份无效');
  const productScope = inArray(storeProduct.id, ids), skuScope = and(inArray(storeProductAttrValue.productId, ids), eq(storeProductAttrValue.type, 0))!;
  const descriptionScope = and(inArray(storeProductDescription.productId, ids), eq(storeProductDescription.type, 0))!;
  let used = await budgetLegacyProductRead(tx, [{table:storeProduct,where:productScope},
    {table:storeProductAttrValue,where:skuScope},{table:storeProductDescription,where:descriptionScope}],READ_BUDGET);
  // JSON objects keep the complete legacy rows without instantiating a large
  // Drizzle projection type for each table. Numeric decimals are cast to text
  // before JSON conversion so their stored scale and precision survive.
  const [rawProducts,rawSkus,descriptions] = await Promise.all([
    tx.execute<{row:Row}>(sql`SELECT to_jsonb(p)||jsonb_build_object('price',p.price::text,'settle_price',p.settle_price::text,
      'vip_price',p.vip_price::text,'ot_price',p.ot_price::text,'postage',p.postage::text,'star',p.star::text,
      'give_integral',p.give_integral::text,'cost',p.cost::text) AS row FROM store_product p WHERE p.id IN (${sqlIds(ids)})`),
    tx.execute<{row:Row}>(sql`SELECT to_jsonb(s)||jsonb_build_object('price',s.price::text,'settle_price',s.settle_price::text,
      'cost',s.cost::text,'ot_price',s.ot_price::text,'vip_price',s.vip_price::text,'weight',s.weight::text,'volume',s.volume::text,
      'brokerage',s.brokerage::text,'brokerage_two',s.brokerage_two::text) AS row FROM store_product_attr_value s
      WHERE s.product_id IN (${sqlIds(ids)}) AND s.type=0 ORDER BY s.id LIMIT ${MAX_ROWS+1}`),
    tx.execute<{productId:number;description:string|null}>(sql`SELECT product_id AS "productId",description FROM store_product_description
      WHERE product_id IN (${sqlIds(ids)}) AND type=0 LIMIT ${MAX_ROWS+1}`),
  ]);
  const products = rawProducts.map(result => camel(result.row) as Product), skus = rawSkus.map(result => camel(result.row) as Sku);
  if (products.length !== ids.length || skus.length > MAX_ROWS || descriptions.length > MAX_ROWS)
    throw new ServiceUnavailableException('商品列表关联读取不完整');
  const productMap = new Map(products.map(row => [row.id,row]));
  const descriptionMap = new Map<number,string|null>();
  for (const row of descriptions) {
    if (descriptionMap.has(row.productId)) throw new ServiceUnavailableException('商品描述存在重复记录');
    descriptionMap.set(row.productId,row.description);
  }
  const categoryIds = [...new Set(products.flatMap(row => outDetailIds(row.cateId)))];
  const labelIds = [...new Set(products.flatMap(row => outDetailIds(row.storeLabelId)))];
  if (categoryIds.length > MAX_ROWS || labelIds.length > MAX_ROWS) throw new ServiceUnavailableException('商品列表选集超过读取容量');
  const categoryScope = categoryIds.length ? inArray(storeProductCategory.id,categoryIds) : undefined;
  const labelScope = labelIds.length ? and(inArray(storeProductLabel.id,labelIds),eq(storeProductLabel.type,0),eq(storeProductLabel.relationId,0)) : undefined;
  const scans: Parameters<typeof budgetLegacyProductRead>[1] = [];
  if (categoryScope) scans.push({table:storeProductCategory,where:categoryScope});
  if (labelScope) scans.push({table:storeProductLabel,where:labelScope});
  used += await budgetLegacyProductRead(tx,scans,READ_BUDGET-used);
  const [categories,labels] = await Promise.all([
    categoryScope ? tx.execute<{id:number;pid:number;cateName:string}>(sql`SELECT id,pid,cate_name AS "cateName"
      FROM store_product_category WHERE id IN (${sqlIds(categoryIds)}) ORDER BY id`) : [],
    labelScope ? tx.execute<{id:number;labelName:string}>(sql`SELECT id,label_name AS "labelName" FROM store_product_label
      WHERE id IN (${sqlIds(labelIds)}) AND type=0 AND relation_id=0 ORDER BY id`) : [],
  ]);
  const parentIds = [...new Set(categories.map(row => row.pid).filter(id => id > 0))];
  const parentScope = parentIds.length ? and(inArray(storeProductCategory.id,parentIds),eq(storeProductCategory.isShow,1)) : undefined;
  if (parentScope) await budgetLegacyProductRead(tx,[{table:storeProductCategory,where:parentScope}],READ_BUDGET-used);
  const parents = parentScope ? await tx.execute<{id:number;cateName:string}>(sql`SELECT id,cate_name AS "cateName"
    FROM store_product_category WHERE id IN (${sqlIds(parentIds)}) AND is_show=1`) : [];
  const parentMap = new Map(parents.map(row => [row.id,row.cateName]));
  const skuMap = new Map<number,Row[]>(), retiredSkuMap = new Map<number,Row[]>();
  for (const row of skus) {
    if (row.isRetired !== 0 && row.isRetired !== 1) throw new ServiceUnavailableException('商品规格退役状态无效');
    const target = row.isRetired === 0 ? skuMap : retiredSkuMap;
    const entries = target.get(row.productId) ?? [];
    entries.push(outListSku(row)); target.set(row.productId,entries);
  }
  const result: Row[] = cards.map(card => {
    const product = productMap.get(Number(card.id));
    if (!product) throw new ServiceUnavailableException('商品列表身份已失配');
    const productCategories = new Set(outDetailIds(product.cateId)), productLabels = new Set(outDetailIds(product.storeLabelId));
    const categoryNames = categories.filter(row => productCategories.has(row.id)).map(row => {
      const parent = parentMap.get(row.pid); return `${parent ? `${parent}/` : ''}${row.cateName}`;
    }).filter(Boolean);
    return { ...card, ...outListProduct(product), image:card.image, recommend_image:card.recommend_image,
      card_sales:card.sales, card_vip_price:card.vip_price, store_label_cards:card.store_label,
      attrValue:skuMap.get(product.id) ?? [], retired_attr_value:retiredSkuMap.get(product.id) ?? [],
      description: descriptionMap.get(product.id) == null ? null : canonicalizePublishedHtmlAttachmentReferences(descriptionMap.get(product.id)!),
      cate_name:categoryNames.join(','), store_label:labels.filter(row => productLabels.has(row.id)).map(row => row.labelName).join(',') };
  });
  const slots: Array<{image:unknown;type:number;relationId:number;set:(value:string)=>void}> = [];
  for (const row of result) {
    const owner = Number(row.type) === 1 ? {type:0,relationId:0} : {type:Number(row.type),relationId:Number(row.relation_id)};
    if (Array.isArray(row.slider_image)) row.slider_image.forEach((image,index) => {
      if (typeof image === 'string') slots.push({...owner,image,set:value => { (row.slider_image as unknown[])[index]=value; }});
    });
    for (const sku of [...row.attrValue as Row[], ...row.retired_attr_value as Row[]]) if (typeof sku.image === 'string')
      slots.push({...owner,image:sku.image,set:value => { sku.image=value; }});
  }
  const references = await publicProductPictures(tx,slots,256), images = await renderProductPictures(appKey,references);
  slots.forEach((slot,index) => slot.set(images[index]));
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > READ_BUDGET)
    throw new ServiceUnavailableException('商品列表完整响应超过读取容量');
  return result;
}
