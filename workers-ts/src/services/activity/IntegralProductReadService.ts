import { and, asc, desc, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import { withTx } from '@/lib/di';
import type { Env } from '@/env';
import { storeIntegral, storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription,
  storeProductLabel, storeProductEnsure, storeBrand, systemStore, systemSupplier, systemConfig, systemForm } from '@/models/schema';
import { integralPublicCandidateSql, integralPublicMediaOwner } from './IntegralPublicCatalogPolicy';
import { integralDescriptionAssetReferences, integralDescriptionHtml } from './IntegralCatalogReadability';
import { publicProductPictures, renderProductPictures } from './ProductAssetPolicy';
import { readProductDetailDesignSnapshot,publicProductDetailDesign } from '@/services/content/ProductDetailDesignReadService';
import { ValidateException } from '@/utils/errors';
import { INTEGRAL_DETAIL_LIMITS, INTEGRAL_DETAIL_CONFIG_KEYS, IntegralProductUnavailableException, integralDetailId, integralDetailInteger,
  integralDetailMoney, integralDetailText, integralDetailJson, integralDetailIds, integralDetailSpecs, integralDetailColor, integralPublicH5Origin,
  projectIntegralDetailSkus, type IntegralDetail } from './IntegralProductDetailData';

const skuColumns = { id: storeProductAttrValue.id, productId: storeProductAttrValue.productId, productType: storeProductAttrValue.productType,
  unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk, image: storeProductAttrValue.image, price: storeProductAttrValue.price,
  otPrice: storeProductAttrValue.otPrice, integral: storeProductAttrValue.integral, stock: storeProductAttrValue.stock,
  quota: storeProductAttrValue.quota, isRetired: storeProductAttrValue.isRetired };
const safeInt = (value: number) => integralDetailInteger(value) ? value : 0;
const bounded = (column: SQLWrapper, size = INTEGRAL_DETAIL_LIMITS.json + 1) => sql<string | null>`left(${column},${size})`;
const baseColumns = { id: storeProduct.id, pid: storeProduct.pid, type: storeProduct.type, relationId: storeProduct.relationId,
  productType: storeProduct.productType, stock: storeProduct.stock, isShow: storeProduct.isShow, isDel: storeProduct.isDel, isVerify: storeProduct.isVerify,
  isVipProduct: storeProduct.isVipProduct, isPresaleProduct: storeProduct.isPresaleProduct, brandId: storeProduct.brandId, otPrice: storeProduct.otPrice };
type ReadBase = Pick<typeof storeProduct.$inferSelect, keyof typeof baseColumns>;

/** A supplier/shop replica remains the actual base product. Only its identity
 * is checked against the platform parent; no private parent content is read.
 * Mirrors integralBatchOwner's accepted read rules without its whole-row parent
 * query or optional write locks. */
async function ownerIssues(tx: DbClient, product: ReadBase): Promise<string[]> {
  const issues: string[] = [];
  if (product.isDel !== 0 || product.isShow !== 1 || product.isVerify !== 1) issues.push('base_product_unpublished');
  if (product.isVipProduct !== 0 || product.isPresaleProduct !== 0) issues.push('base_product_ineligible');
  if (![0, 1, 2].includes(product.type) || !integralDetailInteger(product.relationId) || (product.type === 0 ? product.relationId !== 0 : product.relationId <= 0)) issues.push('owner_invalid');
  if (![0, 1, 2, 3, 4].includes(product.productType)) issues.push('product_type_invalid');
  if (!integralDetailInteger(product.pid) || product.pid === product.id || (product.type === 0 && product.pid !== 0)) issues.push('replica_invalid');
  if (product.type === 1) {
    const [owner] = await tx.select({ id: systemStore.id }).from(systemStore).where(and(eq(systemStore.id, product.relationId), eq(systemStore.isShow, 1), eq(systemStore.isDel, 0), eq(systemStore.isStore, 1))).limit(1);
    if (!owner) issues.push('store_unavailable');
  } else if (product.type === 2) {
    const [owner] = await tx.select({ id: systemSupplier.id }).from(systemSupplier).where(and(eq(systemSupplier.id, product.relationId), eq(systemSupplier.isShow, 1), eq(systemSupplier.isDel, 0))).limit(1);
    if (!owner) issues.push('supplier_unavailable');
  }
  if (product.pid > 0 && product.pid !== product.id) {
    const [parent] = await tx.select({ id: storeProduct.id, pid: storeProduct.pid, type: storeProduct.type, relationId: storeProduct.relationId, productType: storeProduct.productType })
      .from(storeProduct).where(eq(storeProduct.id, product.pid)).limit(1);
    if (!parent || parent.pid !== 0 || parent.type !== 0 || parent.relationId !== 0 || parent.productType !== product.productType) issues.push('replica_parent_invalid');
  }
  return issues;
}

/** Existing caller-owned RR READ ONLY transaction: catalogue and detail share
 * one authority. This function neither starts a transaction nor signs assets.
 * A safe sold-out DTO is still linkable. It never synthesizes an exchange SKU. */
export async function readIntegralProductSnapshot(tx: DbClient, value: unknown): Promise<IntegralDetail> {
  const id = integralDetailId(value);
  const [activity] = await tx.select({ id: storeIntegral.id, productId: storeIntegral.productId, type: storeIntegral.type, relationId: storeIntegral.relationId,
    productType: storeIntegral.productType, status: storeIntegral.status, isShow: storeIntegral.isShow, isDel: storeIntegral.isDel,
    storeName: storeIntegral.storeName, image: storeIntegral.image, images: storeIntegral.images, unitName: storeIntegral.unitName,
    integral: storeIntegral.integral, price: storeIntegral.price, stock: storeIntegral.stock, quota: storeIntegral.quota, sales: storeIntegral.sales,
    num: storeIntegral.num, onceNum: storeIntegral.onceNum, deliveryType: storeIntegral.deliveryType, systemFormId: storeIntegral.systemFormId,
    storeLabelId: bounded(storeIntegral.storeLabelId, 2001), ensureId: bounded(storeIntegral.ensureId, 2001), specs: bounded(storeIntegral.specs) })
    .from(storeIntegral).where(eq(storeIntegral.id, id)).limit(1);
  if (!activity || activity.isShow !== 1 || activity.status !== 1 || activity.isDel !== 0) throw new IntegralProductUnavailableException(['activity_unpublished']);
  // Only base owner/eligibility/display scalars: no cost, credentials, customer
  // forms, whole-row JSON or unbounded private parent content is selected.
  const [product] = await tx.select(baseColumns)
    .from(storeProduct).where(eq(storeProduct.id, activity.productId)).limit(1);
  if (!product) throw new IntegralProductUnavailableException(['base_product_missing']);
  const authority = await ownerIssues(tx, product);
  if (product.type !== activity.type || product.relationId !== activity.relationId || product.productType !== activity.productType) authority.push('activity_owner_mismatch');
  if (authority.length) throw new IntegralProductUnavailableException(authority);
  const [publicIdentity] = await tx.select({ id: storeIntegral.id }).from(storeIntegral).innerJoin(storeProduct, eq(storeProduct.id, storeIntegral.productId))
    .where(and(eq(storeIntegral.id, id), integralPublicCandidateSql('store_integral', 'store_product'))).limit(1);
  if (!publicIdentity) throw new IntegralProductUnavailableException(['public_identity_invalid']);
  const issues: string[] = [], blocked: string[] = [];
  if (!integralDetailInteger(activity.onceNum) || !integralDetailInteger(activity.num)) blocked.push('purchase_limit_invalid');
  if (!integralDetailInteger(activity.systemFormId)) blocked.push('form_reference_invalid');
  if (activity.systemFormId > 0) {
    const [form] = await tx.select({ id: systemForm.id }).from(systemForm).where(and(eq(systemForm.id, activity.systemFormId), eq(systemForm.status, 1), eq(systemForm.isDel, 0))).limit(1);
    if (!form) blocked.push('form_unavailable');
  }
  const activityRows = await tx.select(skuColumns).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 4), eq(storeProductAttrValue.isRetired, 0)))
    .orderBy(asc(storeProductAttrValue.id)).limit(INTEGRAL_DETAIL_LIMITS.skus + 1);
  const baseRows = await tx.select(skuColumns).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, product.id), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
    .orderBy(asc(storeProductAttrValue.id)).limit(INTEGRAL_DETAIL_LIMITS.skus + 1);
  if (activityRows.length > INTEGRAL_DETAIL_LIMITS.skus || baseRows.length > INTEGRAL_DETAIL_LIMITS.skus) throw new ValidateException('积分规格超过500项，不能截断详情');
  const dimensions = await tx.select({ id: storeProductAttr.id, name: storeProductAttr.attrName, values: sql<string>`left(${storeProductAttr.attrValues},100001)` })
    .from(storeProductAttr).where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 4))).orderBy(asc(storeProductAttr.id)).limit(INTEGRAL_DETAIL_LIMITS.attributes + 1);
  if (dimensions.length > INTEGRAL_DETAIL_LIMITS.attributes) throw new ValidateException('积分规格维度超过10项，不能截断详情');
  const productAttr: IntegralDetail['productAttr'] = [];
  for (const row of dimensions) {
    let choices: unknown = row.values;
    if (row.values.length > INTEGRAL_DETAIL_LIMITS.json) { blocked.push('attribute_invalid'); continue; }
    if (row.values.trim().startsWith('[')) choices = integralDetailJson(row.values, blocked, 'attribute_invalid');
    else choices = row.values.split(',');
    if (!Array.isArray(choices) || !choices.length || choices.length > 500 || choices.some(choice => !integralDetailText(choice, 512))) { blocked.push('attribute_invalid'); continue; }
    productAttr.push({ id: row.id, name: integralDetailText(row.name, 32), values: choices as string[] });
  }
  if (new Set(productAttr.map(row => row.name)).size !== productAttr.length || productAttr.some(row => !row.name)) blocked.push('attribute_ambiguous');
  const skus = projectIntegralDetailSkus(activity, product, activityRows, baseRows, blocked);
  const missing = skus.filter(row => row.issues.includes('base_sku_missing')).map(row => row.suk).filter(Boolean);
  if (missing.length) {
    const retired = await tx.selectDistinct({ suk: storeProductAttrValue.suk }).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, product.id), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 1), inArray(storeProductAttrValue.suk, missing))).limit(INTEGRAL_DETAIL_LIMITS.skus + 1);
    const retiredKeys = new Set(retired.map(row => row.suk)); for (const row of skus) if (retiredKeys.has(row.suk)) row.issues.push('base_sku_retired');
  }
  for (const row of skus) if (productAttr.length) {
    const selected = row.suk.split(',');
    if (selected.length !== productAttr.length || selected.some((choice, index) => !productAttr[index].values.includes(choice))) {
      row.issues.push('sku_attribute_mismatch'); row.stock = 0; row.purchasable = false;
    }
  }
  if (!skus.length) {
    const [retired] = await tx.select({ id: storeProductAttrValue.id }).from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 4), eq(storeProductAttrValue.isRetired, 1))).limit(1);
    issues.push(retired ? 'activity_sku_retired' : 'activity_sku_missing');
  }
  issues.push(...blocked);
  const descriptions = await tx.select({ description: sql<string | null>`left(${storeProductDescription.description},${INTEGRAL_DETAIL_LIMITS.description + 1})` })
    .from(storeProductDescription).where(and(eq(storeProductDescription.productId, id), eq(storeProductDescription.type, 4))).limit(2);
  if (descriptions.length > 1 || (descriptions[0]?.description?.length ?? 0) > INTEGRAL_DETAIL_LIMITS.description) throw new ValidateException('积分详情正文重复或超过200000字符');
  let description = integralDescriptionHtml(descriptions[0]?.description ?? '');
  const product_detail_design=publicProductDetailDesign(await readProductDetailDesignSnapshot(tx));
  const showService=product_detail_design.value.showService;
  issues.push(...product_detail_design.issues);
  const labels = integralDetailIds(activity.storeLabelId, issues, 'label_reference_invalid'), ensures = integralDetailIds(activity.ensureId, issues, 'ensure_reference_invalid');
  const labelRows = labels.length ? await tx.select({ id: storeProductLabel.id, labelName: storeProductLabel.labelName, styleType: storeProductLabel.styleType,
    color: storeProductLabel.color, bgColor: storeProductLabel.bgColor, borderColor: storeProductLabel.borderColor, icon: storeProductLabel.icon, type: storeProductLabel.type, relationId: storeProductLabel.relationId })
    .from(storeProductLabel).where(and(inArray(storeProductLabel.id, labels), eq(storeProductLabel.status, 1), eq(storeProductLabel.isShow, 1))).orderBy(desc(storeProductLabel.sort), asc(storeProductLabel.id)) : [];
  const ensureRows = ensures.length && Array.isArray(showService) && showService.includes(2) ? await tx.select({ id: storeProductEnsure.id, name: storeProductEnsure.name,
    image: storeProductEnsure.image, desc: storeProductEnsure.desc, type: storeProductEnsure.type, relationId: storeProductEnsure.relationId })
    .from(storeProductEnsure).where(and(inArray(storeProductEnsure.id, ensures), eq(storeProductEnsure.status, 1))).orderBy(desc(storeProductEnsure.sort), asc(storeProductEnsure.id)) : [];
  const sharedDefinition = (row: { type: number; relationId: number }) => (row.type === 0 && row.relationId === 0) || (product.type === 2 && row.type === 2 && row.relationId === product.relationId);
  if (labelRows.some(row => !sharedDefinition(row)) || ensureRows.some(row => !sharedDefinition(row))) issues.push('definition_owner_mismatch');
  const storeLabel = labelRows.filter(sharedDefinition).map(({ id, labelName, styleType, color, bgColor, borderColor, icon }) => ({ id, labelName: integralDetailText(labelName, 255), styleType: safeInt(styleType),
    color: integralDetailColor(color), bgColor: integralDetailColor(bgColor), borderColor: integralDetailColor(borderColor), icon }));
  const ensure = ensureRows.filter(sharedDefinition).map(({ id, name, image, desc }) => ({ id, name: integralDetailText(name, 255), image, desc: desc.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '') }));
  const [brand] = product.brandId > 0 ? await tx.select({ name: storeBrand.brandName }).from(storeBrand).where(and(eq(storeBrand.id, product.brandId), eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0))).limit(1) : [];
  let images: string[] = [];
  const gallery = integralDetailJson(activity.images, issues, 'gallery_invalid');
  if (gallery !== null) {
    if (!Array.isArray(gallery) || gallery.some(row => typeof row !== 'string')) issues.push('gallery_invalid');
    else images = gallery;
  }
  if (!images.length && activity.image) images = [activity.image];
  const bodyAssets = integralDescriptionAssetReferences(description);
  if (bodyAssets.length > INTEGRAL_DETAIL_LIMITS.bodyAssets) throw new ValidateException('积分详情素材超过1000项');
  const pictureOwner = integralPublicMediaOwner(product.type, product.relationId);
  const refs = [activity.image, ...images, ...skus.map(row => row.image || activity.image), ...storeLabel.map(row => row.icon), ...ensure.map(row => row.image), ...bodyAssets];
  const checked = await publicProductPictures(tx, refs.map(image => ({ ...pictureOwner, image })));
  if (checked.some((image, index) => refs[index] && !image)) issues.push('image_unavailable');
  let cursor = 0; const image = checked[cursor++], safeImages = checked.slice(cursor, cursor += images.length).filter(Boolean);
  for (const row of skus) row.image = checked[cursor++];
  for (const row of storeLabel) row.icon = checked[cursor++];
  for (const row of ensure) row.image = checked[cursor++];
  const bodyMap = new Map(bodyAssets.map((reference, index) => [reference, checked[cursor + index]]));
  description = description.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g, (attribute, _key: string, reference: string) => bodyMap.get(reference) ? attribute : '');
  const configs = await tx.select({ key: systemConfig.menuName, value: systemConfig.value }).from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...INTEGRAL_DETAIL_CONFIG_KEYS])))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(1001);
  if (configs.length > 1000) throw new ValidateException('积分详情展示配置超过完整容量');
  const config = (key: string) => { const raw = configs.find(row => row.key === key)?.value ?? ''; try { const parsed: unknown = JSON.parse(raw); return typeof parsed === 'string' || typeof parsed === 'number' ? String(parsed) : raw; } catch { return raw; } };
  const productValue = Object.fromEntries(skus.filter(row => skus.filter(candidate => candidate.suk === row.suk).length === 1 && row.suk && !['__proto__', 'constructor', 'prototype'].includes(row.suk)).map(row => [row.suk, row]));
  const rootPrice = integralDetailMoney(activity.price), rootOtPrice = integralDetailMoney(product.otPrice);
  if (rootPrice === null || rootOtPrice === null || !integralDetailInteger(activity.integral)) issues.push('summary_price_invalid');
  return { storeInfo: { id, productId: product.id, storeName: integralDetailText(activity.storeName, 256), unitName: integralDetailText(activity.unitName, 16),
    image, images: safeImages, description, productType: product.productType, sales: safeInt(activity.sales), onceNum: safeInt(activity.onceNum), num: safeInt(activity.num), systemFormId: safeInt(activity.systemFormId),
    deliveryType: activity.deliveryType.split(',').filter(part => part === '1' || part === '2'), price: rootPrice ?? '0.00', otPrice: rootOtPrice ?? '0.00', integral: safeInt(activity.integral),
    storeLabel, ensure, specs: Array.isArray(showService) && !showService.includes(3) ? integralDetailSpecs(activity.specs, issues) : [], brandName: integralDetailText(brand?.name ?? '', 100) },
    productAttr, productValue, skus, saleStock: skus.some(row => row.purchasable) ? 1 : 0, issues: [...new Set(issues)],
    product_detail_design,siteName: integralDetailText(config('site_name'), 255), siteUrl: '', shareQrcode: config('share_qrcode') === '1' ? 1 : 0, productPosterTitle: integralDetailText(config('product_poster_title'), 255) };
}

export class IntegralProductReadService {
  constructor(private readonly container: Container, private readonly env?: Pick<Env, 'APP_KEY' | 'PUBLIC_H5_ORIGIN'>) {}
  async read(value: unknown): Promise<IntegralDetail> {
    const id = integralDetailId(value);
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
      return readIntegralProductSnapshot(tx, id);
    });
    const info = result.storeInfo, refs = [info.image, ...info.images, ...result.skus.map(row => row.image), ...info.storeLabel.map(row => row.icon), ...info.ensure.map(row => row.image)];
    const signed = await renderProductPictures(this.env?.APP_KEY, refs); let cursor = 0;
    info.image = signed[cursor++]; info.images = signed.slice(cursor, cursor += info.images.length);
    for (const row of result.skus) row.image = signed[cursor++];
    for (const row of info.storeLabel) row.icon = signed[cursor++];
    for (const row of info.ensure) row.image = signed[cursor++];
    const bodyRefs = integralDescriptionAssetReferences(info.description);
    const bodySigned = await renderProductPictures(this.env?.APP_KEY, bodyRefs), byRef = new Map(bodyRefs.map((ref, index) => [ref, bodySigned[index].replace(/&/g, '&amp;').replace(/"/g, '&quot;')]));
    info.description = info.description.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g, (_attribute, key: string, ref: string) => `${key}="${byRef.get(ref)}"`);
    result.siteUrl = integralPublicH5Origin(this.env?.PUBLIC_H5_ORIGIN);
    return result;
  }
}
