import type { storeProduct } from '@/models/schema';
import { normalizeProductSkuEditorPayload, type ProductSkuEditorPayload } from '@/services/product/ProductSkuEditorService';
import { normalizeVirtualCardImport, type VirtualCardImportRow } from '@/services/product/VirtualProductInventoryService';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { adminProductModerationTime } from './AdminProductModerationInput';
import { normalizeProductVideoReference } from '@/services/product/ProductVideoPolicy';
import { classifyProductMediaReference } from '../../../../view/common/productMediaReference';

export const ADMIN_LEGACY_PRODUCT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_INTEGER = 2_147_483_647;
const MAX_CARDS = 1_000;
type Row = Record<string, unknown>;
type ProductType = 0 | 1 | 3 | 4;
type ProductValues = Partial<typeof storeProduct.$inferInsert>;

/** StoreProduct::save postMore has 59 active entries. `sales` is commented out.
 * Old edit submits the whole read DTO, so additional bounded read/UI fields are
 * intentionally ignored, as PHP postMore does; none become arbitrary columns. */
export const ADMIN_LEGACY_PRODUCT_FIELDS = [
  'product_type', 'supplier_id', 'cate_id', 'store_name', 'store_info', 'keyword', 'unit_name',
  'recommend_image', 'slider_image', 'is_sub', 'sort', 'ficti', 'give_integral', 'is_show', 'is_hot',
  'is_benefit', 'is_best', 'is_new', 'mer_use', 'is_postage', 'is_good', 'description', 'spec_type',
  'video_open', 'video_link', 'items', 'attrs', 'recommend', 'activity', 'coupon_ids', 'label_id',
  'command_word', 'tao_words', 'type', 'delivery_type', 'freight', 'postage', 'temp_id', 'recommend_list',
  'brand_id', 'soure_link', 'bar_code', 'code', 'is_support_refund', 'is_presale_product', 'presale_time',
  'presale_day', 'is_vip_product', 'auto_on_time', 'auto_off_time', 'custom_form', 'system_form_id',
  'store_label_id', 'ensure_id', 'specs', 'specs_id', 'is_limit', 'limit_type', 'limit_num',
] as const;

export interface AdminLegacyProductInputOptions {
  now?: number;
  /** Trusted route/UI copy context, never inferred from the submitted owner/copy `type`. */
  localCopy?: boolean;
  /** Needed only for PHP's relative-video expansion. Do not invent a production origin. */
  siteUrl?: string;
  erpOpen?: boolean;
  /** The modern full editor writes controlled HTTPS MP4 or private asset references. */
  controlledVideo?: boolean;
}
export interface AdminLegacyProductCardImport {
  suk: string;
  cards: VirtualCardImportRow[];
  requestDuplicates: number;
}
export interface AdminLegacyProductInput {
  productType: ProductType;
  supplierId: number;
  copyMode: -1 | 0 | 1;
  localCopy: boolean;
  normalized: Record<string, unknown>;
  productValues: ProductValues;
  description: string;
  skuPayload: ProductSkuEditorPayload;
  cardImports: AdminLegacyProductCardImport[];
}
export interface AdminLegacyProductOwner { type: number; relationId: number }

/** Source preserves every existing non-platform owner; `type` in the body is
 * is_copy and never the authority for product.type/relation_id. */
export function resolveAdminLegacyProductOwner(
  input: Pick<AdminLegacyProductInput, 'supplierId'>,
  existing?: AdminLegacyProductOwner,
): AdminLegacyProductOwner {
  if (existing && existing.type !== 0) return { type: existing.type, relationId: existing.relationId };
  return input.supplierId ? { type: 2, relationId: input.supplierId } : { type: 0, relationId: 0 };
}

function row(value: unknown, label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidateException(`${label}须为JSON对象`);
  return value as Row;
}
export function assertBoundedJson(value: unknown): void {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 30_000 || depth > 24) throw new ValidateException('商品JSON结构超出限制');
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new ValidateException('商品JSON包含无效数字');
      return;
    }
    if (typeof entry === 'string') {
      if (entry.length > 512 * 1024 || /[\u0000\ud800-\udfff]/u.test(entry)) throw new ValidateException('商品JSON文本长度或字符错误');
      return;
    }
    if (typeof entry !== 'object' || seen.has(entry)) throw new ValidateException('商品参数须为有限JSON');
    seen.add(entry);
    if (Array.isArray(entry)) {
      if (entry.length > 1_000) throw new ValidateException('商品JSON数组不能超过1000项');
      for (const item of entry) visit(item, depth + 1);
    } else {
      const object = row(entry, '商品参数');
      if (Object.keys(object).length > 160) throw new ValidateException('商品JSON对象字段过多');
      for (const [key, item] of Object.entries(object)) {
        if (key.length > 255 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new ValidateException('商品JSON字段无效');
        visit(item, depth + 1);
      }
    }
    seen.delete(entry);
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > ADMIN_LEGACY_PRODUCT_MAX_BODY_BYTES) throw new ValidateException('商品JSON不能超过1 MiB');
}
export async function readAdminLegacyProductBody(request: Request): Promise<unknown> {
  const parsed = parseLevelActivationJson(await readBoundedUtf8Text(request, ADMIN_LEGACY_PRODUCT_MAX_BODY_BYTES));
  assertBoundedJson(parsed);
  return row(parsed, '商品正文');
}
function text(value: unknown, label: string, max: number, fallback = '', trim = true): string {
  const raw = value === undefined ? fallback : value;
  if (typeof raw !== 'string' || [...raw].length > max || /[\u0000\ud800-\udfff]/u.test(raw)) throw new ValidateException(`${label}长度或字符错误`);
  return trim ? raw.trim() : raw;
}
function integer(value: unknown, label: string, fallback = 0, min = 0, max = MAX_INTEGER): number {
  const raw = value === undefined || value === '' ? fallback : value;
  const parsed = typeof raw === 'string' && /^-?(?:0|[1-9]\d*)$/.test(raw) ? Number(raw) : raw;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ValidateException(`${label}须为${min}至${max}的整数`);
  return parsed;
}
function flag(value: unknown, label: string, fallback = 0): 0 | 1 {
  return integer(typeof value === 'boolean' ? Number(value) : value, label, fallback, 0, 1) as 0 | 1;
}
function money(value: unknown, label: string, fallback = '0', maxWhole = 10): string {
  const raw = value === undefined || value === '' ? fallback : value;
  if ((typeof raw !== 'string' && typeof raw !== 'number') || !new RegExp(`^\\d{1,${maxWhole}}(?:\\.\\d{1,2})?$`).test(String(raw))) throw new ValidateException(`${label}须为至多两位小数的非负数`);
  const [whole, fraction = ''] = String(raw).split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}
function array(value: unknown, label: string, maximum: number): unknown[] {
  const source = value === undefined ? [] : value;
  if (!Array.isArray(source) || source.length > maximum) throw new ValidateException(`${label}须为至多${maximum}项的数组`);
  return source;
}
function ids(value: unknown, label: string, csvLength?: number): number[] {
  const result = array(value, label, 100).map(item => integer(item, label, 0, 1));
  if (new Set(result).size !== result.length) throw new ValidateException(`${label}不能重复`);
  if (csvLength !== undefined && result.join(',').length > csvLength) throw new ValidateException(`${label}超过存储长度`);
  return result;
}
function legacyTime(value: unknown): number {
  const expanded = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value} 00:00:00` : value;
  return adminProductModerationTime(expanded);
}
function specs(value: unknown): Array<{ name: string; value: string; sort: number; status: 0 | 1 }> {
  const names = new Set<string>();
  return array(value, '商品参数', 100).map(entry => {
    const source = row(entry, '商品参数');
    const name = text(source.name, '参数名', 255), value = text(source.value, '参数值', 255);
    if (!name || !value || names.has(name)) throw new ValidateException('商品参数名称和值不能为空且名称不能重复');
    names.add(name);
    return { name, value, sort: integer(source.sort, '参数排序'), status: flag(source.status, '参数状态', 1) };
  });
}
function skuDetail(source: Row, dimensions: Array<{ value: string; detail: string[] }>, specType: number): Row {
  if (specType === 0) return { 规格: '默认' };
  const detail: Row = {};
  const supplied = source.detail === undefined ? null : row(source.detail, 'SKU规格');
  if (supplied) {
    for (const [key, value] of Object.entries(supplied)) {
      const name = key.trim();
      if (Object.prototype.hasOwnProperty.call(detail, name)) throw new ValidateException('SKU规格名称不能重复');
      detail[name] = text(value, 'SKU规格值', 64);
    }
    if (Object.keys(detail).length !== dimensions.length || Object.keys(detail).some(key => !dimensions.some(dimension => dimension.value === key))) throw new ValidateException('SKU规格维度不完整');
  }
  for (const [index, dimension] of dimensions.entries()) {
    const positional = source[`value${index + 1}`];
    if (!supplied) detail[dimension.value] = text(positional, 'SKU规格值', 64);
    else if (positional !== undefined && text(positional, 'SKU规格值', 64) !== detail[dimension.value]) throw new ValidateException('SKU位置字段与规格明细冲突');
  }
  const canonical = dimensions.map(dimension => detail[dimension.value]).join(',');
  if (source.suk !== undefined && source.suk !== canonical) throw new ValidateException('SKU规格标识与明细冲突');
  return detail;
}

/** Pure adapter only. The caller must authorize, lock, validate current catalog
 * rows and persist all groups/effects in one transaction. A decoded DTO proves
 * neither persistence nor legacy editor migration completion. */
export function normalizeAdminLegacyProductInput(value: unknown, options: AdminLegacyProductInputOptions = {}): AdminLegacyProductInput {
  assertBoundedJson(value);
  const source = row(value, '商品正文');
  const productType = integer(source.product_type, '商品类型', 0, 0, 4) as ProductType;
  if (![0, 1, 3, 4].includes(productType)) throw new ValidateException('旧商品编辑器仅支持实物、卡密、手工虚拟及次卡商品');
  const supplierId = integer(source.supplier_id, '供应商ID');
  const copyMode = integer(source.type, '商品导入方式', 0, -1, 1) as -1 | 0 | 1;
  const localCopy = options.localCopy === true;
  const categoryIds = ids(source.cate_id, '商品分类', 64);
  if (!categoryIds.length) throw new ValidateException('请选择商品分类');
  const brandIds = ids(source.brand_id, '品牌', 64), storeLabelIds = ids(source.store_label_id, '商品标签'), ensureIds = ids(source.ensure_id, '保障服务');
  const sliderImages = array(source.slider_image, '商品轮播图', 10).map(entry => text(entry, '商品轮播图', 256));
  if (!sliderImages.length || sliderImages.some(image => !image)) throw new ValidateException('请上传商品轮播图');
  if (JSON.stringify(sliderImages).length > 5_000) throw new ValidateException('商品轮播图超过存储长度');
  const storeName = text(source.store_name, '商品名称', 256);
  if (!storeName) throw new ValidateException('请输入商品名称');
  const isSub = array(source.is_sub, '会员及佣金选项', 2).map(entry => integer(entry, '会员及佣金选项', 0, 0, 1));
  if (new Set(isSub).size !== isSub.length) throw new ValidateException('会员及佣金选项不能重复');
  const isVip = isSub.includes(0) ? 1 : 0, separateCommission = isSub.includes(1) ? 1 : 0;
  const specType = integer(source.spec_type, '规格类型', 0, 0, 1) as 0 | 1;
  const dimensions = specType === 0 ? [{ value: '规格', detail: ['默认'] }]
    : array(source.items, '规格维度', 3).map(entry => {
      const dimension = row(entry, '规格维度');
      return { value: text(dimension.value, '规格名', 32), detail: array(dimension.detail, '规格值', 50).map(item => text(item, '规格值', 64)) };
    });
  const rawSkus = array(source.attrs, '商品SKU', 200);
  const cardImports: AdminLegacyProductCardImport[] = [];
  let totalCards = 0;
  const skuRows = rawSkus.map(entry => {
    const sku = row(entry, '商品SKU');
    const detail = skuDetail(sku, dimensions, specType);
    const image = text(sku.pic, 'SKU图片', 128);
    if (!image) throw new ValidateException('请上传商品规格图片');
    const settlePrice = money(sku.settle_price, 'SKU结算价', '0', 8);
    if (settlePrice === '0.00' && sku.cost === undefined) throw new ValidateException('请填写正确的商品成本价格');
    if (sku.stock === undefined) throw new ValidateException('请填写正确的商品库存');
    const cost = settlePrice !== '0.00' ? settlePrice : money(sku.cost, 'SKU成本价');
    const vipPrice = money(sku.vip_price, 'SKU会员价');
    if (isVip && vipPrice === '0.00') throw new ValidateException('会员价格不能为0');
    const diskInfoValue = Array.isArray(sku.disk_info) && sku.disk_info.length === 0 ? '' : sku.disk_info;
    const diskInfo = localCopy ? '' : text(diskInfoValue, '固定虚拟内容', 4_096, '', false);
    const virtualList = array(sku.virtual_list, '导入卡密', MAX_CARDS);
    if (productType !== 1 && (diskInfo || virtualList.length)) throw new ValidateException('只有卡密商品可以提交卡密内容');
    if (!localCopy && diskInfo && virtualList.length) throw new ValidateException('固定内容与导入卡密不能同时提交');
    if (!localCopy && virtualList.length) {
      totalCards += virtualList.length;
      if (totalCards > MAX_CARDS) throw new ValidateException('单次商品保存最多导入1000条卡密');
      const imported = normalizeVirtualCardImport(virtualList);
      cardImports.push({ suk: dimensions.map(dimension => detail[dimension.value]).join(','), ...imported });
    }
    const writeValid = productType === 4 ? integer(sku.write_valid, '次卡有效期类型', 0, 1, 3) : 1;
    let writeStart = 0, writeEnd = 0;
    if (productType === 4 && writeValid === 3) {
      const period = array(sku.section_time, '次卡固定有效期', 2);
      if (period.length !== 2) throw new ValidateException('请选择固定有效时间段');
      writeStart = legacyTime(period[0]); writeEnd = legacyTime(period[1]);
      if (!writeStart || writeEnd <= writeStart) throw new ValidateException('次卡固定有效期结束必须晚于开始');
    }
    const unique = localCopy ? undefined : sku.unique;
    return { detail, image, price: money(sku.price, 'SKU售价'), settle_price: settlePrice, cost,
      ot_price: money(sku.ot_price, 'SKU划线价'), vip_price: vipPrice,
      stock: localCopy && productType === 1 ? 0 : integer(sku.stock, 'SKU库存'),
      bar_code: text(sku.bar_code, 'SKU条码', 50), code: text(sku.code, 'SKU编码', 50),
      weight: money(sku.weight, 'SKU重量'), volume: money(sku.volume, 'SKU体积'),
      brokerage: separateCommission ? money(sku.brokerage, '一级佣金') : '0.00',
      brokerage_two: separateCommission ? money(sku.brokerage_two, '二级佣金') : '0.00', disk_info: diskInfo,
      ...(unique === undefined ? {} : { unique }),
      ...(productType === 4 ? { write_times: integer(sku.write_times, '次卡核销次数', 0, 1, 99_999_999), write_valid: writeValid,
        write_days: writeValid === 2 ? integer(sku.days ?? sku.write_days, '次卡有效天数', 0, 1, 3_650) : 0,
        write_start: writeStart, write_end: writeEnd } : {}),
    };
  });
  const skuPayload = normalizeProductSkuEditorPayload({ spec_type: specType, items: dimensions, attrs: skuRows }, productType);
  if (skuPayload.skus.reduce((sum, sku) => sum + sku.stock, 0) > MAX_INTEGER) throw new ValidateException('商品总库存超出存储范围');
  const code = text(source.code, '商品编码', 50);
  if (options.erpOpen && productType === 0 && (!code || skuRows.some(sku => !sku.code))) throw new ValidateException('开启ERP时商品及每个SKU均须填写商品编码');
  const isPresale = flag(source.is_presale_product, '预售开关');
  const presalePeriod = array(source.presale_time, '预售时间', 2);
  let presaleStart = 0, presaleEnd = 0;
  if (isPresale) {
    if (presalePeriod.length !== 2) throw new ValidateException('请选择预售时间');
    presaleStart = legacyTime(presalePeriod[0]); presaleEnd = legacyTime(presalePeriod[1]);
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(now) || now < 0) throw new ValidateException('商品保存时钟无效');
    if (!presaleStart || !presaleEnd || presaleStart < now || presaleEnd < now) throw new ValidateException('预售起止时间不能小于当前时间');
    // PHP checks each endpoint against now, but does not compare their order.
  }
  const autoOn = legacyTime(source.auto_on_time), autoOff = legacyTime(source.auto_off_time);
  const isShow = autoOn ? 0 : integer(source.is_show, '上架状态', 0, 0, 2);
  const isLimit = flag(source.is_limit, '限购开关');
  const limitType = isLimit ? integer(source.limit_type, '限购类型', 0, 1, 2) : 0;
  const limitNum = isLimit ? integer(source.limit_num, '限购数量', 0, 1) : 0;
  const customForm = source.custom_form === undefined ? [] : source.custom_form;
  if (!Array.isArray(customForm)) row(customForm, '自定义表单');
  if (Object.keys(customForm as object).length > 100) throw new ValidateException('自定义表单不能超过100项');
  const parameterSpecs = specs(source.specs);
  const sourceUserLabels = array(source.label_id, '用户标签', 100);
  // Exact source discrepancy: real Form submits numeric IDs, while saveData
  // applies array_column(..., 'id'). That array (empty or nonempty) is omitted
  // by Think ORM Builder::parseData for this non-JSON varchar column; no model
  // mutator converts it. Thus edits preserve the old main label_id, while the
  // original relationData still contains the submitted IDs for relation type 4.
  const relationUserLabels = sourceUserLabels.map(entry => integer(typeof entry === 'object' && entry !== null ? row(entry, '用户标签').id : entry, '用户标签', 0, 1));
  if (new Set(relationUserLabels).size !== relationUserLabels.length) throw new ValidateException('用户标签不能重复');
  const recommendList = ids(source.recommend_list, '推荐商品', 256), couponIds = ids(source.coupon_ids, '赠送优惠券');
  const recommend = array(source.recommend, '商品推荐回显', 100);
  const activity = array(source.activity, '活动顺序', 4).map(entry => {
    const label = text(entry, '活动名', 32);
    return label === '秒杀' ? 1 : label === '砍价' ? 2 : label === '拼团' ? 3 : 0;
  });
  let deliveryTypes = productType === 4 && !Array.isArray(source.delivery_type)
    ? [integer(source.delivery_type, '配送方式', 2, 1, 3)]
    : array(source.delivery_type, '配送方式', 3).map(entry => integer(entry, '配送方式', 0, 1, 3));
  if (new Set(deliveryTypes).size !== deliveryTypes.length) throw new ValidateException('配送方式不能重复');
  if (productType === 0 && !deliveryTypes.length) throw new ValidateException('请选择商品配送方式');
  let freight = integer(source.freight, '运费类型', 1, 1, 3), postage = money(source.postage, '邮费'), tempId = integer(source.temp_id, '运费模板');
  if ([1, 3].includes(productType)) { freight = 2; postage = '0.00'; tempId = 0; deliveryTypes = []; }
  else if (freight === 1) { postage = '0.00'; tempId = 0; }
  else if (freight === 2) { tempId = 0; if (postage === '0.00') throw new ValidateException('请设置运费金额'); }
  else { postage = '0.00'; if (!tempId) throw new ValidateException('请选择运费模版'); }
  let videoLink = text(source.video_link, '商品视频', 500);
  const videoReference = classifyProductMediaReference(videoLink);
  if (options.controlledVideo || videoReference.kind === 'asset' || videoReference.kind === 'invalid' && videoReference.privateNamespace) {
    videoLink = normalizeProductVideoReference(videoLink);
  } else if (videoLink && !videoLink.includes('http')) {
    if (!options.siteUrl) throw new ValidateException('相对视频地址需要配置站点地址');
    videoLink = text(`${options.siteUrl}${videoLink}`, '商品视频', 500);
  }
  const description = text(source.description, '商品详情', 512 * 1024, '', false);
  const productValues: ProductValues = {
    productType, storeName, storeInfo: text(source.store_info, '商品简介', 256), keyword: text(source.keyword, '商品关键词', 256),
    unitName: text(source.unit_name, '商品单位', 32, '件') || '件', image: sliderImages[0], sliderImage: JSON.stringify(sliderImages),
    recommendImage: text(source.recommend_image, '推荐图', 256), sort: integer(source.sort, '商品排序'), ficti: integer(source.ficti, '虚拟销量'),
    giveIntegral: money(source.give_integral, '赠送积分'), isShow, isHot: flag(source.is_hot, '热卖'), isBenefit: flag(source.is_benefit, '促销'),
    isBest: flag(source.is_best, '精品'), isNew: flag(source.is_new, '新品'), merUse: flag(source.mer_use, '门店使用'),
    isPostage: flag(source.is_postage, '包邮'), isGood: flag(source.is_good, '优品'), isSub: separateCommission, isVip,
    videoOpen: flag(source.video_open, '视频开关'), videoLink, activity: activity.join(','), commandWord: text(source.command_word, '口令', 255),
    recommendList: recommendList.join(','), soureLink: localCopy ? '' : text(source.soure_link, '采集链接', 2_000), barCode: text(source.bar_code, '商品条码', 15),
    code, isSupportRefund: flag(source.is_support_refund, '退款支持', 1), isPresaleProduct: isPresale, presaleStartTime: presaleStart,
    presaleEndTime: presaleEnd, presaleDay: integer(source.presale_day, '预售发货日'), isVipProduct: flag(source.is_vip_product, '会员专属'),
    autoOnTime: autoOn, autoOffTime: autoOff, customForm: Object.keys(customForm as object).length ? JSON.stringify(customForm) : '',
    systemFormId: integer(source.system_form_id, '系统表单ID'), isLimit, limitType, limitNum,
    deliveryType: deliveryTypes.join(','), freight, postage, tempId,
  };
  const normalized: Row = {
    product_type: productType, supplier_id: supplierId, cate_id: categoryIds, store_name: storeName,
    store_info: productValues.storeInfo, keyword: productValues.keyword, unit_name: productValues.unitName,
    recommend_image: productValues.recommendImage, slider_image: sliderImages, image: sliderImages[0], is_sub: isSub, is_vip: isVip,
    sort: productValues.sort, ficti: productValues.ficti, give_integral: productValues.giveIntegral, is_show: isShow,
    is_hot: productValues.isHot, is_benefit: productValues.isBenefit, is_best: productValues.isBest, is_new: productValues.isNew,
    mer_use: productValues.merUse, is_postage: productValues.isPostage, is_good: productValues.isGood, description,
    spec_type: specType, video_open: productValues.videoOpen, video_link: videoLink, items: dimensions, attrs: skuRows,
    recommend, activity, coupon_ids: couponIds, label_id: relationUserLabels, command_word: productValues.commandWord,
    tao_words: text(source.tao_words, '淘口令', 2_000), type: copyMode, delivery_type: deliveryTypes, freight, postage, temp_id: tempId,
    recommend_list: recommendList, brand_id: brandIds, soure_link: productValues.soureLink, bar_code: productValues.barCode, code,
    is_support_refund: productValues.isSupportRefund, is_presale_product: isPresale, presale_time: [presaleStart, presaleEnd],
    presale_day: productValues.presaleDay, is_vip_product: productValues.isVipProduct, auto_on_time: autoOn, auto_off_time: autoOff,
    custom_form: customForm, system_form_id: productValues.systemFormId, store_label_id: storeLabelIds, ensure_id: ensureIds,
    specs: parameterSpecs, specs_id: integer(source.specs_id, '参数模板ID'), is_limit: isLimit, limit_type: limitType, limit_num: limitNum,
  };
  return { productType, supplierId, copyMode, localCopy, normalized, productValues, description, skuPayload, cardImports };
}
