import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription, storeProductVirtual,
  storeProductCoupon, storeCouponIssue, storeProductCategory, storeProductLabel, userLabel, systemForm,
  shippingTemplates, systemConfig } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference, canonicalizePublishedHtmlAttachmentReferences,
  sanitizePublishedArticleHtml } from '@/services/content/ArticleContentPolicy';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { legacyPhpJsonDecodeWire } from '@/utils/legacy-php-json';
import { normalizeConfigScalar } from '@/utils/config';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { budgetLegacyProductRead } from './AdminLegacyProductReadBudget';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';

type Row = Record<string, unknown>;
type Product = typeof storeProduct.$inferSelect;
type Sku = typeof storeProductAttrValue.$inferSelect;
type Dimension = { value: string; detail: string[] };
type Node = { value: number; label: string; pid: number; children?: Node[] };
type Slot = { image: string; type: number; relationId: number; set(value: string): void };
const CAPACITY = 10_000;
const activityNames: Record<string, string> = { '0': '默认', '1': '秒杀', '2': '砍价', '3': '拼团' };
const conflict = (message = '商品规格资料不能无歧义重建，请先核对历史数据') => new HttpApiException(message, 409, 409);
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function time(value: number, dayOnly = false): string {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 2_147_483_648) throw new ServiceUnavailableException('商品历史时间超出范围');
  const parts = Object.fromEntries(date.formatToParts(new Date(value * 1000)).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return dayOnly ? day : `${day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function csv(value: string | null): number[] {
  if (!value || value === '0') return [];
  const tokens = value.split(',').filter(item => item !== '' && item !== '0');
  if (tokens.length > CAPACITY || tokens.some(item => !/^[1-9]\d*$/.test(item) || Number(item) > 2_147_483_647))
    throw new ServiceUnavailableException('商品历史选集格式或容量错误');
  return tokens.map(Number);
}
function decode(value: string | null): unknown {
  if (!value || value === '0') return [];
  const decoded = legacyPhpJsonDecodeWire(value, 512 * 1024);
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 30_000 || depth > 24 || Array.isArray(entry) && entry.length > 1000)
      throw new ServiceUnavailableException('商品详情历史JSON结构超过编辑容量');
    if (entry && typeof entry === 'object') for (const child of Object.values(entry)) visit(child, depth + 1);
  };
  visit(decoded, 0); return decoded;
}
async function bounded<T>(query: PromiseLike<T[]>): Promise<T[]> {
  const rows = await query;
  if (rows.length > CAPACITY) throw new ServiceUnavailableException('商品详情完整集合超过10000项容量');
  return rows;
}
function tree(rows: Array<typeof storeProductCategory.$inferSelect>): Node[] {
  const nodes = new Map(rows.map(row => [row.id, { value: row.id, label: row.cateName, pid: row.pid } as Node]));
  const childrenByParent = new Map<number, typeof rows>();
  for (const row of rows) { const siblings = childrenByParent.get(row.pid) ?? []; siblings.push(row); childrenByParent.set(row.pid, siblings); }
  const walk = (pid: number, ancestors: number[]): Node[] => {
    if (ancestors.length > 16) throw new ServiceUnavailableException('商品分类层级超出容量');
    return (childrenByParent.get(pid) ?? []).map(row => {
      if (ancestors.includes(row.id)) throw conflict('商品分类存在循环');
      const node = nodes.get(row.id)!; const children = walk(row.id, [...ancestors, row.id]);
      if (children.length) node.children = children;
      return node;
    });
  };
  return walk(0, []);
}
function formInfo(value: unknown): Row[] {
  const names: Record<string, string> = { checkboxs: '多选框', citys: '城市', dates: '日期', dateranges: '日期范围',
    radios: '单选框', selects: '下拉框', texts: '文本框', times: '时间', timeranges: '时间范围', uploadPicture: '图片' };
  if (!value || typeof value !== 'object') return [];
  if (Object.keys(value).length > 100) throw new ServiceUnavailableException('商品详情系统表单超过100项编辑容量');
  return Object.values(value).map(item => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Row : {};
    const nested = (key: string, field: string, fallback: unknown) => row[key] && typeof row[key] === 'object'
      ? (row[key] as Row)[field] ?? fallback : fallback;
    const type = typeof row.name === 'string' ? row.name : '';
    return { id: row.id ?? '', type, name: names[type] ?? '', title: nested('titleConfig', 'value', ''),
      tip: nested('tipConfig', 'value', ''), list: ['checkboxs', 'radios', 'selects'].includes(type) ? nested('wordsConfig', 'list', []) : [],
      require: nested('titleShow', 'val', false), value: row.value ?? '' };
  });
}
function numeric(value: string | number | null): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ServiceUnavailableException('商品历史金额无效');
  return number;
}
function dimensions(product: Product, attrs: Array<typeof storeProductAttr.$inferSelect>, skus: Sku[]): Dimension[] {
  if (product.specType === 0) {
    if (skus.length > 1 || skus.some(row => row.suk !== '默认')) throw conflict();
    return [{ value: '规格', detail: ['默认'] }];
  }
  if (product.specType !== 1 || !attrs.length || attrs.length > 3 || !skus.length || skus.length > 200) throw conflict();
  const result = attrs.map(row => ({ value: row.attrName, detail: row.attrValues.split(',') }));
  if (new Set(result.map(row => row.value)).size !== result.length
    || result.some(row => !row.value || row.value.length > 32 || !row.detail.length || row.detail.length > 50
      || row.detail.some(value => !value || value.length > 64) || new Set(row.detail).size !== row.detail.length)
    || result.reduce((size, row) => size * row.detail.length, 1) > 200) throw conflict();
  const expected = result.reduce<string[][]>((rows, row) => rows.flatMap(parts => row.detail.map(value => [...parts, value])), [[]]);
  if (expected.length > 200 || expected.length !== skus.length || new Set(skus.map(row => row.suk)).size !== skus.length
    || expected.some(parts => !skus.some(row => row.suk === parts.join(',')))) throw conflict();
  return result;
}
function skuDto(row: Sku, dims: Dimension[], counts: Map<string, { available: number; total: number }>): Row {
  const parts = row.suk.split(',');
  const result: Row = { id: row.id, unique: row.unique, suk: row.suk,
    detail: Object.fromEntries(dims.map((dim, index) => [dim.value, parts[index] ?? ''])), pic: row.image,
    stock: row.stock, sales: row.sales, sum_stock: row.sumStock, bar_code: row.barCode, code: row.code,
    disk_info: row.diskInfo ?? '', virtual_list: [], virtual_available: counts.get(row.unique)?.available ?? 0,
    virtual_total: counts.get(row.unique)?.total ?? 0, write_times: row.writeTimes, write_valid: row.writeValid,
    days: row.writeDays, section_time: [row.writeStart ? time(row.writeStart, true) : '', row.writeEnd ? time(row.writeEnd, true) : ''],
    is_retired: row.isRetired };
  for (const [field, value] of Object.entries({ price: row.price, settle_price: row.settlePrice, vip_price: row.vipPrice, cost: row.cost,
    ot_price: row.otPrice, weight: row.weight, volume: row.volume, brokerage: row.brokerage, brokerage_two: row.brokerageTwo })) result[field] = numeric(value);
  dims.forEach((_dim, index) => { result[`value${index + 1}`] = parts[index] ?? ''; });
  return result;
}
function fallbackSku(product: Product): Row {
  return { pic: product.image, price: numeric(product.price), settle_price: numeric(product.settlePrice), cost: numeric(product.cost),
    ot_price: numeric(product.otPrice), vip_price: numeric(product.vipPrice), stock: product.stock, bar_code: '', code: '',
    weight: 0, volume: 0, brokerage: 0, brokerage_two: 0, disk_info: '', virtual_list: [], virtual_available: 0, virtual_total: 0,
    write_times: 1, write_valid: 1, days: 0, section_time: [], detail: { 规格: '默认' }, value1: '默认' };
}
function error(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(conflict('商品资料正在更新，请刷新后重试'), { cause: error });
    if (['42501', '57014', '42P01', '42703'].includes(code)) throw Object.assign(new ServiceUnavailableException('商品详情读取权限或迁移未就绪'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

/** The real legacy editor read contract. Never repairs SKU identity on GET,
 * selects card credentials, invokes a provider, or issues business DML. */
export class AdminLegacyProductReadService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}
  async detail(id: number, query: URLSearchParams, actor: AdminAuthorityActor) {
    if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647) throw new ValidateException('商品ID错误');
    if (query.size) throw new ValidateException('商品详情不接受查询参数');
    assertAdminAuthoritySession(actor);
    try {
      const snapshot = await withTx(this.container, async tx => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
        await authorizeAdminLegacyProductRead(tx, actor);
        const usedBytes = await budgetLegacyProductRead(tx, [
          { table: storeProduct, where: eq(storeProduct.id, id) },
          { table: storeProductAttr, where: and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 0))! },
          { table: storeProductAttrValue, where: and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0))! },
          { table: storeProductDescription, where: and(eq(storeProductDescription.productId, id), eq(storeProductDescription.type, 0))! },
          { table: storeProductCoupon, where: eq(storeProductCoupon.productId, id) },
          { table: shippingTemplates, where: and(eq(shippingTemplates.ownerType, 0), eq(shippingTemplates.relationId, 0))! },
          { table: storeProductCategory, where: and(eq(storeProductCategory.type, 0), eq(storeProductCategory.relationId, 0), eq(storeProductCategory.isShow, 1))! },
          { table: systemConfig, where: and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'site_url'))! },
        ]);
        const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, id)).limit(1);
        if (!product || !id) throw new ValidateException('商品不存在');
        const [attrs, skus, descriptions, counts, couponRows, templates, categories, settings] = await Promise.all([
          bounded(tx.select().from(storeProductAttr).where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 0))).orderBy(asc(storeProductAttr.id)).limit(CAPACITY + 1)),
          bounded(tx.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0))).orderBy(asc(storeProductAttrValue.id)).limit(CAPACITY + 1)),
          tx.select().from(storeProductDescription).where(and(eq(storeProductDescription.productId, id), eq(storeProductDescription.type, 0))).limit(2),
          bounded(tx.select({ unique: storeProductVirtual.attrUnique, available: sql<number>`count(*) FILTER(WHERE ${storeProductVirtual.uid}=0)::int`, total: sql<number>`count(*)::int` })
            .from(storeProductVirtual).where(eq(storeProductVirtual.productId, id)).groupBy(storeProductVirtual.attrUnique).limit(CAPACITY + 1)),
          bounded(tx.select().from(storeProductCoupon).where(eq(storeProductCoupon.productId, id)).orderBy(asc(storeProductCoupon.id)).limit(CAPACITY + 1)),
          bounded(tx.select().from(shippingTemplates).where(and(eq(shippingTemplates.ownerType, 0), eq(shippingTemplates.relationId, 0)))
            .orderBy(desc(shippingTemplates.sort), desc(shippingTemplates.id)).limit(CAPACITY + 1)),
          bounded(tx.select().from(storeProductCategory).where(and(eq(storeProductCategory.type, 0), eq(storeProductCategory.relationId, 0), eq(storeProductCategory.isShow, 1)))
            .orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id)).limit(CAPACITY + 1)),
          tx.select().from(systemConfig).where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'site_url'))).limit(2),
        ]);
        if (descriptions.length > 1 || settings.length > 1) throw conflict('商品描述或站点配置存在重复记录');
        if (skus.some(row => ![0, 1].includes(row.isRetired)) || new Set(skus.map(row => row.unique)).size !== skus.length) throw conflict();
        const active = skus.filter(row => row.isRetired === 0), dims = dimensions(product, attrs, active);
        const countMap = new Map(counts.map(row => [row.unique, { available: Number(row.available), total: Number(row.total) }]));
        const skuRows = active.map(row => skuDto(row, dims, countMap));
        const labelIds = csv(product.labelId), storeLabelIds = csv(product.storeLabelId), recommendationIds = csv(product.recommendList);
        const couponIds = [...new Set(couponRows.map(row => row.issueCouponId))];
        const scans: Parameters<typeof budgetLegacyProductRead>[1] = [];
        if (labelIds.length) scans.push({ table: userLabel, where: inArray(userLabel.id, labelIds) });
        if (storeLabelIds.length) scans.push({ table: storeProductLabel, where: inArray(storeProductLabel.id, storeLabelIds) });
        if (couponIds.length) scans.push({ table: storeCouponIssue, where: inArray(storeCouponIssue.id, couponIds) });
        if (recommendationIds.length) scans.push({ table: storeProduct, where: inArray(storeProduct.id, recommendationIds) });
        if (product.systemFormId) scans.push({ table: systemForm, where: eq(systemForm.id, product.systemFormId) });
        await budgetLegacyProductRead(tx, scans, 1024 * 1024 - usedBytes);
        const [labels, productLabels, coupons, recommendations, forms] = await Promise.all([
          labelIds.length ? tx.select({ id: userLabel.id, label_name: userLabel.name }).from(userLabel).where(inArray(userLabel.id, labelIds)).orderBy(desc(userLabel.id)) : [],
          storeLabelIds.length ? tx.select({ id: storeProductLabel.id, label_name: storeProductLabel.labelName }).from(storeProductLabel).where(inArray(storeProductLabel.id, storeLabelIds)).orderBy(asc(storeProductLabel.id)) : [],
          couponIds.length ? tx.select().from(storeCouponIssue).where(inArray(storeCouponIssue.id, couponIds)).orderBy(desc(storeCouponIssue.sort), desc(storeCouponIssue.id)) : [],
          recommendationIds.length ? tx.select().from(storeProduct).where(inArray(storeProduct.id, recommendationIds)) : [],
          product.systemFormId ? tx.select().from(systemForm).where(eq(systemForm.id, product.systemFormId)).limit(1) : [],
        ]);
        const storedForm = decode(product.customForm), customForm = forms[0]?.value ? decode(forms[0].value) : [];
        const info: Row = Object.fromEntries(Object.entries(product).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
        delete info.is_polices;
        Object.assign(info, { is_police: product.isPolices, cate_id: product.cateId.split(','), brand_id: csv(product.brandCom),
          label_id: labels, store_label_id: productLabels, ensure_id: csv(product.ensureId), slider_image: legacyPhpJsonDecodeWire(product.sliderImage), specs: decode(product.specs),
          is_sub: [...(product.isSub === 1 ? [1] : []), ...(product.isVip === 1 ? [0] : [])], recommend: [],
          is_limit: Boolean(product.isLimit), video_open: Boolean(product.videoOpen), delivery_type: product.deliveryType ? product.deliveryType.split(',') : [],
          video_link: product.videoLink && !product.videoLink.includes('http') ? `${normalizeConfigScalar(settings[0]?.value ?? '')}${product.videoLink}` : product.videoLink,
          coupons: coupons.map(row => ({ id: row.id, title: row.title })),
          presale_time: product.presaleStartTime ? [time(product.presaleStartTime), time(product.presaleEndTime)] : [],
          auto_on_time: product.isShow ? '' : product.autoOnTime ? time(product.autoOnTime) : '',
          auto_off_time: !product.isShow ? '' : product.autoOffTime ? time(product.autoOffTime) : '',
          custom_form: customForm, custom_form_info: formInfo(customForm),
          description: canonicalizePublishedHtmlAttachmentReferences(descriptions[0]?.description ?? ''),
          items: product.specType === 1 ? dims : [], attrs: product.specType === 1 ? skuRows : [],
          attr: product.specType === 0 ? skuRows[0] ?? fallbackSku(product) : { ...fallbackSku(product), pic: '', stock: 0, price: 0, cost: 0, ot_price: 0, vip_price: 0, settle_price: 0 },
          sku_repair_required: !active.length,
          activity: product.activity ? product.activity.split(',').map(value => activityNames[value] ?? value) : ['默认', '秒杀', '砍价', '拼团'],
          recommend_list: recommendationIds.map(productId => ({ product_id: String(productId), image: recommendations.find(row => row.id === productId)?.image ?? '' })),
        });
        for (const key of ['price', 'postage', 'ot_price', 'vip_price', 'cost', 'give_integral']) info[key] = numeric(info[key] as string);
        // The source Vue echoes custom_form_info as well as custom_form.
        // Keep both source fields, but refuse oversized complete forms before
        // preview/signing; reserve room below POST's 1 MiB transport cap for
        // the Vue submit-time SKU/coupon/selection projections.
        if (new TextEncoder().encode(JSON.stringify(info)).byteLength > 768 * 1024)
          throw new ServiceUnavailableException('商品详情完整表单超过768 KiB编辑容量');
        // Large read-only expansions are outside productInfo: the old Vue
        // echoes that object verbatim to POST, whose transport cap is 1 MiB.
        const editor = { stored_custom_form: storedForm, retired_attrs: skus.filter(row => row.isRetired === 1).map(row => skuDto(row, dims, countMap)), description_preview: '' };
        const slots: Slot[] = [];
        const collect = (raw: unknown, owner: Product, set: (value: string) => void) => {
          if (typeof raw !== 'string') return;
          const image = canonicalizePublishedAttachmentReference(raw);
          if (!image.startsWith('/api/assets/')) return;
          slots.push({ image, type: owner.type === 1 ? 0 : owner.type, relationId: owner.type === 1 ? 0 : owner.relationId, set });
        };
        for (const key of ['image', 'recommend_image']) collect(info[key], product, value => { info[key] = value; });
        if (Array.isArray(info.slider_image)) (info.slider_image as unknown[]).forEach((value, index) => collect(value, product, next => { (info.slider_image as unknown[])[index] = next; }));
        for (const row of [...skuRows, ...editor.retired_attrs, info.attr as Row]) collect(row.pic, product, value => { row.pic = value; });
        (info.recommend_list as Row[]).forEach(row => { const owner = recommendations.find(item => item.id === Number(row.product_id)); if (owner) collect(row.image, owner, value => { row.image = value; }); });
        // Editable markup stays canonical and byte-preserving; preview alone
        // is sanitized and signed after checking actual owner metadata here.
        const html = sanitizePublishedArticleHtml(info.description);
        const preview = new Map<string, string>();
        for (const match of html.matchAll(/\b(?:href|src)="(\/api\/assets\/[1-9]\d*)"/g)) if (!preview.has(match[1])) {
          preview.set(match[1], ''); collect(match[1], product, value => { preview.set(match[1], value); });
        }
        const references = await publicProductPictures(tx, slots);
        await assertAdminLegacyProductReadDeadline(tx, actor);
        return { data: { tempList: templates.map(row => ({ id: row.id, name: row.name })), cateList: tree(categories), productInfo: info, editor }, slots, references, html, preview };
      });
      const signed = await renderProductPictures(this.appKey, snapshot.references);
      snapshot.slots.forEach((slot, index) => slot.set(signed[index]));
      snapshot.data.editor.description_preview = snapshot.html.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g,
        (_all, attribute: string, reference: string) => `${attribute}="${(snapshot.preview.get(reference) ?? '').replaceAll('&', '&amp;')}"`);
      if (new TextEncoder().encode(JSON.stringify(snapshot.data)).byteLength > 2 * 1024 * 1024) throw new ServiceUnavailableException('商品详情响应超过2 MiB容量');
      return snapshot.data;
    } catch (caught) { return error(caught); }
  }

}
