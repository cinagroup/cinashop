import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { shippingTemplates, storeCouponIssue, storeProduct, storeProductAttr, storeProductAttrValue,
  storeProductCategory, storeProductCoupon, storeProductDescription, storeProductRelation,
  storeProductVirtual, systemConfig, systemForm } from '@/models/schema';
import { NotFoundException, ServiceUnavailableException } from '@/utils/errors';
import { normalizeConfigScalar } from '@/utils/config';
import { budgetLegacyProductRead } from '@/services/admin/AdminLegacyProductReadBudget';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference, canonicalizePublishedHtmlAttachmentReferences, sanitizePublishedArticleHtml } from '@/services/content/ArticleContentPolicy';
import { resolveProductVideoReference } from '@/services/product/ProductVideoPolicy';
import { outProductBrandSelection } from './OutProductBrandBindings';
import { outProductEnsureSelection } from './OutProductEnsureBindings';
import { outProductLabelsSelection } from './OutProductLabelBindings';
import { outProductParameterSelection } from './OutProductParameterBindings';
import { readSupplierProductSystemFormSelection } from '@/services/supplier/SupplierProductSystemFormBindings';
import { outDetailFormInfo, outDetailIds, outDetailJson, outDetailProduct, outDetailSpecs, outDetailTree } from './OutProductDetailProjection';

const LIMIT = 10000;
type Row = Record<string, unknown>;
const scope = (id: number) => and(eq(storeProduct.id, id), eq(storeProduct.type, 0), eq(storeProduct.relationId, 0), eq(storeProduct.isDel, 0))!;
const templatesScope = and(eq(shippingTemplates.ownerType, 0), eq(shippingTemplates.relationId, 0))!;
const categoriesScope = and(eq(storeProductCategory.type, 0), eq(storeProductCategory.relationId, 0), eq(storeProductCategory.isShow, 1))!;
async function bounded<T>(query: PromiseLike<T[]>): Promise<T[]> {
  const rows = await query;
  if (rows.length > LIMIT) throw new ServiceUnavailableException('商品详情完整集合超过10000项容量');
  return rows;
}
function capacity(value: unknown, bytes: number, message: string) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > bytes) throw new ServiceUnavailableException(message);
}
function siteVideo(reference: string, raw: string | undefined) {
  if (!reference.startsWith('/') || reference.startsWith('/api/assets/')) return reference;
  const site = normalizeConfigScalar(raw ?? '');
  if (!site) return reference;
  try {
    const target = new URL(site);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) return reference;
    return `${site.replace(/\/$/, '')}${reference}`;
  } catch { return reference; }
}

/** A complete read snapshot shared by the legacy envelope and flat TS DTO.
 * No SKU repair, provider I/O or virtual-card credential selection occurs. */
export async function readOutProductDetail(container: Container, id: number, appKey?: string) {
  try {
    const snapshot = await withTx(container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      const used = await budgetLegacyProductRead(tx, [{ table: storeProduct, where: scope(id) }]);
      const [product] = await tx.select().from(storeProduct).where(scope(id)).limit(1);
      if (!product) throw new NotFoundException('商品不存在或不属于平台');
      const attrScope = and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 0))!;
      const skuScope = and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0))!;
      const descriptionScope = and(eq(storeProductDescription.productId, id), eq(storeProductDescription.type, 0))!;
      const relationScope = eq(storeProductRelation.productId, id), couponScope = eq(storeProductCoupon.productId, id);
      const settingScope = and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'site_url'))!;
      const baseScans = [
        { table: storeProductAttr, where: attrScope }, { table: storeProductAttrValue, where: skuScope },
        { table: storeProductDescription, where: descriptionScope }, { table: storeProductRelation, where: relationScope },
        { table: storeProductCoupon, where: couponScope }, { table: systemConfig, where: settingScope },
        { table: shippingTemplates, where: templatesScope, columns: [shippingTemplates.id, shippingTemplates.name] },
        { table: storeProductCategory, where: categoriesScope },
      ];
      const baseBytes = await budgetLegacyProductRead(tx, baseScans, 1024 * 1024 - used);
      const [attrs, skus, descriptions, relations, couponRows, templates, categories, settings, virtualCounts] = await Promise.all([
        bounded(tx.select().from(storeProductAttr).where(attrScope).orderBy(asc(storeProductAttr.id)).limit(LIMIT + 1)),
        bounded(tx.select().from(storeProductAttrValue).where(skuScope).orderBy(asc(storeProductAttrValue.id)).limit(LIMIT + 1)),
        tx.select().from(storeProductDescription).where(descriptionScope).limit(2),
        bounded(tx.select().from(storeProductRelation).where(relationScope).orderBy(asc(storeProductRelation.id)).limit(LIMIT + 1)),
        bounded(tx.select().from(storeProductCoupon).where(couponScope).orderBy(asc(storeProductCoupon.id)).limit(LIMIT + 1)),
        bounded(tx.select({ id: shippingTemplates.id, name: shippingTemplates.name }).from(shippingTemplates).where(templatesScope)
          .orderBy(desc(shippingTemplates.sort), desc(shippingTemplates.id)).limit(LIMIT + 1)),
        bounded(tx.select().from(storeProductCategory).where(categoriesScope).orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id)).limit(LIMIT + 1)),
        tx.select({ value: systemConfig.value }).from(systemConfig).where(settingScope).limit(2),
        product.productType === 1 ? bounded(tx.select({ unique: storeProductVirtual.attrUnique,
          available: sql<string>`count(*) FILTER(WHERE ${storeProductVirtual.uid}=0)::text`, total: sql<string>`count(*)::text` })
          .from(storeProductVirtual).where(eq(storeProductVirtual.productId, id)).groupBy(storeProductVirtual.attrUnique).limit(LIMIT + 1)) : [],
      ]);
      if (descriptions.length > 1 || settings.length > 1) throw new ServiceUnavailableException('商品描述或站点配置存在重复记录');
      const counts = new Map(virtualCounts.map(row => {
        const available = Number(row.available), total = Number(row.total);
        if (!Number.isSafeInteger(available) || !Number.isSafeInteger(total) || available < 0 || total < available)
          throw new ServiceUnavailableException('商品虚拟库存统计无效');
        return [row.unique, { available, total }];
      }));
      const recommendationIds = outDetailIds(product.recommendList), couponIds = [...new Set(couponRows.map(row => row.issueCouponId))];
      const scans: Parameters<typeof budgetLegacyProductRead>[1] = [];
      if (recommendationIds.length) scans.push({ table: storeProduct, where: and(inArray(storeProduct.id, recommendationIds), eq(storeProduct.type, 0), eq(storeProduct.relationId, 0), eq(storeProduct.isDel, 0))!, columns: [storeProduct.id, storeProduct.image] });
      if (couponIds.length) scans.push({ table: storeCouponIssue, where: inArray(storeCouponIssue.id, couponIds), columns: [storeCouponIssue.id, storeCouponIssue.title] });
      if (product.systemFormId) scans.push({ table: systemForm, where: eq(systemForm.id, product.systemFormId), columns: [systemForm.id, systemForm.value] });
      await budgetLegacyProductRead(tx, scans, 1024 * 1024 - used - baseBytes);
      const [recommendations, coupons, forms, brand, ensure, labels, parameters, systemFormSelection] = await Promise.all([
        recommendationIds.length ? tx.select({ id: storeProduct.id, image: storeProduct.image }).from(storeProduct)
          .where(and(inArray(storeProduct.id, recommendationIds), eq(storeProduct.type, 0), eq(storeProduct.relationId, 0), eq(storeProduct.isDel, 0))) : [],
        couponIds.length ? tx.select({ id: storeCouponIssue.id, title: storeCouponIssue.title }).from(storeCouponIssue).where(inArray(storeCouponIssue.id, couponIds)).orderBy(asc(storeCouponIssue.id)) : [],
        product.systemFormId ? tx.select({ value: systemForm.value }).from(systemForm).where(eq(systemForm.id, product.systemFormId)).limit(1) : [],
        outProductBrandSelection(tx, product), outProductEnsureSelection(tx, product), outProductLabelsSelection(tx, product),
        outProductParameterSelection(tx, product), readSupplierProductSystemFormSelection(tx, product),
      ]);
      const specs = outDetailSpecs(product, attrs, skus, counts), form = outDetailJson(forms[0]?.value ?? null);
      const video = await resolveProductVideoReference(tx, product.videoLink, product, { allowLegacyRelative: true });
      const info: Row = { ...outDetailProduct(product), brand_id: brand.brand_id, ensure_id: ensure.ensure_id,
        label_id: labels.label_id, store_label_id: labels.store_label_id,
        specs_id: parameters.specs_id,
        coupons, description: canonicalizePublishedHtmlAttachmentReferences(descriptions[0]?.description ?? ''),
        custom_form: form, custom_form_info: outDetailFormInfo(form),
        recommend_list: recommendationIds.map(productId => ({ product_id: String(productId), image: recommendations.find(row => row.id === productId)?.image ?? '' })),
        items: specs.items, attrs: specs.attrs, attr: specs.attr, sku_repair_required: specs.sku_repair_required,
        video_link: siteVideo(canonicalizePublishedAttachmentReference(product.videoLink), settings[0]?.value) };
      const editor = { stored_custom_form: outDetailJson(product.customForm), retired_attrs: specs.retired,
        media_previews: {} as Record<string, string>, video_preview: '', description_preview: '',
        category_selection: { stored: product.cateId, relation_ids: relations.filter(row => row.type === 1).map(row => row.relationId) },
        video_selection: { stored: product.videoLink, reference: String(info.video_link), available: Boolean(video) } };
      const slots: Array<{ image: string; type: number; relationId: number; set(value: string): void }> = [];
      const collect = (raw: unknown, set: (value: string) => void) => {
        if (typeof raw !== 'string') return;
        const image = canonicalizePublishedAttachmentReference(raw);
        slots.push({ image, type: 0, relationId: 0, set });
      };
      for (const key of ['image', 'recommend_image']) collect(info[key], value => { info[key] = value; });
      if (Array.isArray(info.slider_image)) info.slider_image.forEach((raw, index) => collect(raw, value => { (info.slider_image as unknown[])[index] = value; }));
      for (const row of [...specs.attrs, specs.attr, ...editor.retired_attrs]) collect(row.pic, value => { row.pic = value; });
      for (const row of info.recommend_list as Row[]) collect(row.image, value => { row.image = value; });
      const html = sanitizePublishedArticleHtml(info.description), preview = new Map<string, string>();
      for (const match of html.matchAll(/\b(?:href|src)="(\/api\/assets\/[1-9]\d*)"/g)) if (!preview.has(match[1])) {
        preview.set(match[1], ''); collect(match[1], value => { preview.set(match[1], value); });
      }
      const references = await publicProductPictures(tx, slots, 256);
      slots.forEach((slot, index) => slot.set(references[index]));
      capacity(info, 768 * 1024, '商品详情完整表单超过768 KiB编辑容量');
      const data = { ...product, ...brand, ...ensure, ...labels, ...parameters, ...systemFormSelection,
        cate_id: relations.filter(row => row.type === 1).map(row => row.relationId),
        description: descriptions[0]?.description ?? '', items: specs.flatItems,
        attrs: skus.map(sku => ({ ...sku, detail: Object.fromEntries(specs.flatItems.map((item, index) => [item.value, sku.suk.split(',')[index] ?? ''])) })),
        tempList: templates, cateList: outDetailTree(categories), productInfo: info, editor };
      return { data, references, preview, html, video: product.videoOpen === 1 ? siteVideo(video, settings[0]?.value) : '' };
    });
    const rendered = await renderProductPictures(appKey, [...snapshot.references, snapshot.video]);
    snapshot.references.forEach((reference, index) => {
      if (reference.startsWith('/api/assets/')) snapshot.data.editor.media_previews[reference] = rendered[index];
    });
    snapshot.data.editor.video_preview = rendered.at(-1) ?? '';
    snapshot.data.editor.description_preview = snapshot.html.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g,
      (_all, attribute: string, reference: string) => `${attribute}="${(snapshot.preview.get(reference) ? snapshot.data.editor.media_previews[reference] ?? '' : '').replaceAll('&', '&amp;')}"`);
    capacity(snapshot.data, 2 * 1024 * 1024, '商品详情响应超过2 MiB容量');
    return snapshot.data;
  } catch (error) {
    let cause = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      const code = 'code' in cause ? String(cause.code) : '';
      if (['55P03', '40P01', '40001', '42501', '57014', '42P01', '42703'].includes(code))
        throw Object.assign(new ServiceUnavailableException('商品详情读取权限、并发或迁移未就绪'), { cause: error });
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    throw error;
  }
}
