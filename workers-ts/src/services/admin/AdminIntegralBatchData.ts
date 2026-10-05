import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductCategory, storeProductDescription, storeProductRelation,
  systemAttachment, systemStore, systemSupplier } from '@/models/schema';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';
import { sanitizePublishedArticleHtml } from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { activityHash, activityId, activityInteger, activityObject } from './AdminSeckillActivityInput';

export const INTEGRAL_BATCH_LIMITS = { max_products: 100, max_total_skus: 1000, max_skus_per_product: 500 } as const;
export type IntegralBatchActor = { id: number };
export type IntegralBatchSkuInput = { baseUnique: string; price: string; integral: number; quota: number; image: string };
export type IntegralBatchProductInput = { productId: number; revision: string; skus: IntegralBatchSkuInput[] };
export type IntegralBatchInput = { requestId: string; isShow: 0 | 1; products: IntegralBatchProductInput[] };
export type IntegralBatchProductReceipt = { product_id: number; integral_id: number };
export type IntegralBatchReceipt = { request_id: string; payload_hash: string; products: IntegralBatchProductReceipt[]; count: number; is_show: 0 | 1 };
export type IntegralBatchSource = typeof storeProduct.$inferSelect & { version: string };
export type IntegralBatchSourceSku = typeof storeProductAttrValue.$inferSelect & { version: string };
const sourceColumns = { ...getTableColumns(storeProduct), version: sql<string>`xmin::text` };
const skuColumns = { ...getTableColumns(storeProductAttrValue), version: sql<string>`xmin::text` };

function whitelist(raw: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new ValidateException('不支持的积分批量字段');
}
export function integralBatchRequestId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    throw new ValidateException('请求标识必须是UUID');
  }
  return value;
}
export function integralBatchMoney(value: unknown, label = '现金价格') {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)) throw new ValidateException(`${label}须为非负十进制金额，最多两位小数`);
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
function picture(value: unknown) {
  if (value === '') return '';
  const reference = seckillTimePicture(value);
  // Draft hashes bind the exact durable reference. The shared public display
  // helper may strip asset signatures/entities; input must never silently
  // reinterpret a preview URL as the client's persisted SKU picture.
  if (reference !== value) throw new ValidateException('积分规格图片须使用稳定引用，不能提交签名预览或改写图片地址');
  if ([...reference].length > 128) throw new ValidateException('积分规格图片不能超过128个字符');
  return reference;
}
export function parseIntegralBatchInput(raw: Record<string, unknown>): IntegralBatchInput {
  whitelist(raw, ['request_id', 'is_show', 'products']);
  const requestId = integralBatchRequestId(raw.request_id);
  if (raw.is_show !== 0 && raw.is_show !== 1) throw new ValidateException('上架状态须为0或1');
  if (!Array.isArray(raw.products) || !raw.products.length || raw.products.length > INTEGRAL_BATCH_LIMITS.max_products) throw new ValidateException('请选择1至100个基础商品');
  let total = 0;
  const products = raw.products.map(value => {
    const row = activityObject(value, '积分商品'); whitelist(row, ['product_id', 'revision', 'skus']);
    const productId = activityId(row.product_id, '基础商品ID');
    if (typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)) throw new ValidateException('基础商品版本无效，请刷新后重新选择');
    if (!Array.isArray(row.skus) || !row.skus.length || row.skus.length > INTEGRAL_BATCH_LIMITS.max_skus_per_product) throw new ValidateException('每商品请选择1至500个规格');
    total += row.skus.length;
    const skus = row.skus.map(value => {
      const sku = activityObject(value, '积分规格'); whitelist(sku, ['base_unique', 'price', 'integral', 'quota', 'image']);
      if (typeof sku.base_unique !== 'string' || !sku.base_unique || sku.base_unique !== sku.base_unique.trim() ||
        sku.base_unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(sku.base_unique)) throw new ValidateException('基础规格标识无效');
      const price = integralBatchMoney(sku.price), integral = activityInteger(sku.integral, '兑换积分');
      // The actual PHP batch calls validateProductAttr(type=4); a SKU must
      // consume cash or points. Its root display minimum never authorizes free
      // redemption of another option.
      if (price === '0.00' && integral === 0) throw new ValidateException('积分商品兑换积分和价格不能同时为空');
      return { baseUnique: sku.base_unique, price, integral,
        quota: activityInteger(sku.quota, '兑换次数', 1), image: picture(sku.image) };
    });
    if (new Set(skus.map(row => row.baseUnique)).size !== skus.length) throw new ValidateException('同一商品规格不能重复');
    return { productId, revision: row.revision, skus: skus.sort((a, b) => a.baseUnique < b.baseUnique ? -1 : a.baseUnique > b.baseUnique ? 1 : 0) };
  });
  if (total > INTEGRAL_BATCH_LIMITS.max_total_skus) throw new ValidateException('一次最多添加1000个积分规格');
  if (new Set(products.map(row => row.productId)).size !== products.length) throw new ValidateException('基础商品不能重复');
  return { requestId, isShow: raw.is_show, products: products.sort((a, b) => a.productId - b.productId) };
}
/** Shared with the Admin draft recovery contract: fixed keys, decimal strings,
 * numeric product order and binary SKU order. The request UUID is not payload. */
export function integralBatchPayloadHash(input: IntegralBatchInput) {
  return activityHash({ is_show: input.isShow, products: input.products.map(product => ({ product_id: product.productId, revision: product.revision,
    skus: product.skus.map(sku => ({ base_unique: sku.baseUnique, price: sku.price, integral: sku.integral, quota: sku.quota, image: sku.image })) })) });
}
export function integralBatchQuery(query: URLSearchParams) {
  for (const key of query.keys()) if (!['page', 'limit', 'keyword', 'category_id', 'label_id'].includes(key) || query.getAll(key).length !== 1) throw new ValidateException('不支持或重复的积分商品查询参数');
  const page = query.has('page') ? activityId(query.get('page'), '页码') : 1;
  const limit = query.has('limit') ? activityId(query.get('limit'), '每页数量') : 15;
  if (limit > 100 || (page - 1) * limit > 10000) throw new ValidateException('积分商品分页超出范围');
  const keyword = query.get('keyword') ?? '';
  if (keyword.length > 100 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('查询名称无效');
  const filterId = (key: string) => !query.has(key) || ['', '0'].includes(query.get(key)!) ? 0 : activityId(query.get(key), '筛选ID');
  return { page, limit, offset: (page - 1) * limit, keyword: keyword.trim(), categoryId: filterId('category_id'), labelId: filterId('label_id') };
}

/** Retain owner-specific category names for valid shop/supplier sources as
 * well as the platform category links exposed by the shared Admin filter. */
export async function integralBatchMetadata(tx: DbClient, sources: Array<typeof storeProduct.$inferSelect>) {
  if (!sources.length) return new Map<number, string>();
  const links = await tx.select({ productId: storeProductRelation.productId, id: storeProductRelation.relationId }).from(storeProductRelation)
    .where(and(inArray(storeProductRelation.productId, sources.map(row => row.id)), eq(storeProductRelation.type, 1))).limit(10001);
  if (links.length > 10000) throw new ValidateException('商品分类关联超过完整展示容量');
  const idsFor = (source: typeof storeProduct.$inferSelect) => [...new Set([...links.filter(row => row.productId === source.id).map(row => row.id),
    ...source.cateId.split(',').filter(value => /^[1-9]\d{0,9}$/.test(value.trim())).map(value => Number(value.trim()))])].filter(id => id > 0 && id <= 2147483647);
  const ids = [...new Set(sources.flatMap(idsFor))];
  const categories = ids.length ? await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id, ids)).orderBy(asc(storeProductCategory.id)) : [];
  return new Map(sources.map(source => [source.id, idsFor(source).map(id => {
    const row = categories.find(row => row.id === id && ((row.type === 0 && row.relationId === 0) ||
      (source.type !== 0 && row.type === source.type && row.relationId === source.relationId)));
    return row?.cateName ?? `未知分类#${id}`;
  }).join(', ')]));
}

/** A shop/supplier replica remains an independent base product. Its positive
 * pid binds the existing platform parent; it is never replaced with that parent. */
export async function integralBatchOwner(tx: DbClient, source: typeof storeProduct.$inferSelect, locked = false) {
  const issues: string[] = [];
  if (source.isDel !== 0 || source.isShow !== 1 || source.isVerify !== 1) issues.push('基础商品已删除、下架或未通过审核');
  if (source.isVipProduct !== 0 || source.isPresaleProduct !== 0) issues.push('会员专享或预售商品不能直接参与积分兑换');
  if (![0, 1, 2].includes(source.type) || !Number.isSafeInteger(source.relationId) ||
    (source.type === 0 ? source.relationId !== 0 : source.relationId <= 0)) issues.push('基础商品所属方配置无效');
  if (![0, 1, 2, 3, 4].includes(source.productType)) issues.push('基础商品履约类型无效');
  if (!Number.isSafeInteger(source.stock) || source.stock < 0 || source.stock > 2147483647) issues.push('基础商品库存无效');
  if (!Number.isSafeInteger(source.pid) || source.pid < 0 || source.pid === source.id || (source.type === 0 && source.pid !== 0)) issues.push('基础商品副本关系无效');
  let owner: { id: number; name: string; isShow: number; isDel: number; isStore?: number } | null = null;
  let parent: IntegralBatchSource | null = null;
  if (source.type === 1 && source.relationId > 0) {
    const query = tx.select({ id: systemStore.id, name: systemStore.name, isShow: systemStore.isShow, isDel: systemStore.isDel, isStore: systemStore.isStore })
      .from(systemStore).where(eq(systemStore.id, source.relationId)).limit(1);
    owner = (await (locked ? query.for('share', { noWait: true }) : query))[0] ?? null;
    if (!owner || owner.isShow !== 1 || owner.isDel !== 0 || owner.isStore !== 1) issues.push('门店不存在、未开店、已停用或已删除');
  } else if (source.type === 2 && source.relationId > 0) {
    const query = tx.select({ id: systemSupplier.id, name: systemSupplier.supplierName, isShow: systemSupplier.isShow, isDel: systemSupplier.isDel })
      .from(systemSupplier).where(eq(systemSupplier.id, source.relationId)).limit(1);
    owner = (await (locked ? query.for('share', { noWait: true }) : query))[0] ?? null;
    if (!owner || owner.isShow !== 1 || owner.isDel !== 0) issues.push('供应商不存在、已停用或已删除');
  }
  if (source.pid > 0 && source.pid !== source.id) {
    const query = tx.select(sourceColumns).from(storeProduct).where(eq(storeProduct.id, source.pid)).limit(1);
    parent = (await (locked ? query.for('share', { noWait: true }) : query))[0] ?? null;
    if (!parent || parent.pid !== 0 || parent.type !== 0 || parent.relationId !== 0 || parent.productType !== source.productType) issues.push('商品副本缺少真实平台父商品或履约类型不一致');
  }
  return { issues, owner, parent, ownerName: source.type === 0 ? '平台' : owner?.name || `${source.type === 1 ? '门店' : '供应商'}#${source.relationId}` };
}

export async function integralBatchGraph(tx: DbClient, id: number, locked = false) {
  const sourceQuery = tx.select(sourceColumns).from(storeProduct).where(eq(storeProduct.id, id)).limit(1);
  const source = (await (locked ? sourceQuery.for('share', { noWait: true }) : sourceQuery))[0];
  if (!source) throw new NotFoundException('基础商品不存在');
  const skuQuery = tx.select(skuColumns).from(storeProductAttrValue)
    .where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
    .orderBy(asc(storeProductAttrValue.id)).limit(INTEGRAL_BATCH_LIMITS.max_skus_per_product + 1);
  // Native char(8) pads historical short tokens on the wire. Strip only its
  // ASCII padding, retaining controls/leading whitespace for invalid-identity
  // checks. Preserve xmin so stock/identity updates still change the revision.
  const skus = (await (locked ? skuQuery.for('share', { noWait: true }) : skuQuery))
    .map(row => ({ ...row, unique: row.unique.replace(/ +$/u, '') }));
  if (skus.length > INTEGRAL_BATCH_LIMITS.max_skus_per_product) throw new ValidateException('基础规格超过500项，不能截断选择');
  const dimensions = await tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 0))).orderBy(asc(storeProductAttr.id)).limit(11);
  const descriptions = await tx.select().from(storeProductDescription).where(and(eq(storeProductDescription.productId, id), eq(storeProductDescription.type, 0))).limit(2);
  const snapshots = await tx.select().from(storeProductAttrResult).where(and(eq(storeProductAttrResult.productId, id), eq(storeProductAttrResult.type, 0))).orderBy(asc(storeProductAttrResult.id)).limit(2);
  if (dimensions.length > 10 || descriptions.length > 1 || snapshots.length > 1) throw new ValidateException('基础商品内容或规格快照重复、超出容量');
  const ownership = await integralBatchOwner(tx, source, locked);
  const issues = [...ownership.issues];
  if (!skus.length) issues.push('基础商品没有可用的普通规格');
  if (new Set(skus.map(row => row.unique)).size !== skus.length || new Set(skus.map(row => row.suk)).size !== skus.length) issues.push('基础规格标识或组合不唯一');
  if (source.specType !== 0 && source.specType !== 1) issues.push('基础商品规格类型无效');
  if (source.specType === 1 && !dimensions.length) issues.push('多规格商品缺少真实规格维度');
  if (source.productType === 4 && (source.specType !== 0 || skus.length !== 1)) issues.push('次卡只支持单规格单SKU');
  const revision = await activityHash({ source, skus, dimensions, descriptions, snapshots, owner: ownership.owner, parent: ownership.parent });
  return { source, skus, dimensions, description: sanitizePublishedArticleHtml(descriptions[0]?.description ?? ''), revision, issues, ownerName: ownership.ownerName };
}
export type IntegralBatchGraph = Awaited<ReturnType<typeof integralBatchGraph>>;

export function integralBatchSkuIssues(row: IntegralBatchSourceSku, graph: IntegralBatchGraph) {
  const issues: string[] = [];
  if (!row.unique || row.unique !== row.unique.trim() || row.unique.length > 8 || /[\u0000-\u0020\u007f]/u.test(row.unique)) issues.push('基础规格标识无效');
  if (!row.suk || row.suk !== row.suk.trim() || /[\u0000-\u001f\u007f]/u.test(row.suk)) issues.push('基础规格组合无效');
  if (!Number.isSafeInteger(row.stock) || row.stock < 0 || row.stock > 2147483647) issues.push('基础规格库存无效');
  if (row.productType !== graph.source.productType) issues.push('基础规格履约类型与商品不一致');
  if (graph.dimensions.length) {
    const choices = row.suk.split(',');
    if (choices.length !== graph.dimensions.length || choices.some((value, index) => !graph.dimensions[index].attrValues.split(',').includes(value))) issues.push('基础规格组合与真实维度不一致');
  }
  for (const [label, value] of [['价格', row.price], ['成本', row.cost], ['重量', row.weight], ['体积', row.volume]] as const) {
    try { integralBatchMoney(value, label); } catch { issues.push(`基础规格${label}无效`); }
  }
  if (graph.source.productType !== 1 && row.diskInfo) issues.push('非卡密商品不能配置固定卡密内容');
  if (graph.source.productType === 4) {
    if (!Number.isSafeInteger(row.writeTimes) || row.writeTimes < 1 || row.writeTimes > 99999999 || ![1, 2, 3].includes(row.writeValid) ||
      (row.writeValid === 2 && (!Number.isSafeInteger(row.writeDays) || row.writeDays < 1 || row.writeDays > 3650)) ||
      (row.writeValid === 3 && (!Number.isSafeInteger(row.writeStart) || !Number.isSafeInteger(row.writeEnd) || row.writeStart <= 0 || row.writeEnd <= row.writeStart || row.writeEnd > 2147483647))) issues.push('次卡核销次数或有效期无效');
  }
  return issues;
}

/** Shops have no independent upload scope in the current attachment service.
 * Their verified Admin-managed catalogue can use platform assets; suppliers
 * retain the existing supplier-plus-platform library policy. Ownership remains
 * unchanged on every persisted product and SKU. No remote objects are read. */
export function integralBatchMediaOwner(source: typeof storeProduct.$inferSelect) {
  return source.type === 1 ? { type: 0, relationId: 0 } : { type: source.type, relationId: source.relationId };
}
export async function integralBatchPictures(tx: DbClient, source: typeof storeProduct.$inferSelect, images: readonly string[]) {
  return publicProductPictures(tx, images.map(image => ({ ...integralBatchMediaOwner(source), image })));
}
export async function validateIntegralBatchMedia(tx: DbClient, graph: IntegralBatchGraph, images: readonly string[]) {
  const descriptionRefs = [...new Set([...graph.description.matchAll(/\b(?:href|src)="(\/api\/assets\/[1-9]\d*)"/g)].map(match => match[1]))];
  if (descriptionRefs.length > 1000) throw new ValidateException('积分商品详情图片超过完整容量');
  const refs = [...images, ...descriptionRefs], ids = [...new Set(refs.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  if (ids.length) await tx.select({ id: systemAttachment.attId }).from(systemAttachment).where(inArray(systemAttachment.attId, ids)).orderBy(asc(systemAttachment.attId)).for('share', { noWait: true });
  const checked = await integralBatchPictures(tx, graph.source, refs);
  if (checked.some((image, index) => refs[index] !== '' && (!image || image !== refs[index]))) throw new ValidateException('积分商品图片不属于商品所属方的有效图片素材');
}
