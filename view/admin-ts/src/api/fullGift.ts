import request, { getData } from '@/utils/request';

const endpoint = '/marketing/full-gifts';
const MAX_INT = 2_147_483_647;
const integer = (value: unknown, min = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= MAX_INT;
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('满送活动响应格式错误');
  return value as Record<string, unknown>;
};
const text = (value: unknown): value is string => typeof value === 'string' && !/[\u0000-\u001f\u007f]/u.test(value);

export type FullGiftScope = 1 | 2 | 3 | 4 | 5;
export type FullGiftCategory = 1 | 2;
export type FullGiftThreshold = 1 | 2;
export interface FullGiftCouponSelection { give_coupon_id: number; give_coupon_num: number }
export interface FullGiftProductSelection { give_product_id: number; unique: string; give_product_num: number }
export interface FullGiftRule {
  id?: number;
  threshold: number; give_integral: number;
  give_coupon_id: FullGiftCouponSelection[]; give_product_id: FullGiftProductSelection[];
}
export interface FullGiftSelection { product_id: number; unique: string[] }
export interface FullGiftSku { id: number; unique: string; suk: string; label?: string; price: string | number; stock: number; is_retired?: 0 | 1 }
export interface FullGiftProduct {
  id: number; store_name: string; image: string; price: string | number; stock: number; cate_name: string;
  attrValue: FullGiftSku[]; is_show?: 0 | 1; is_del?: 0 | 1; is_verify?: 0 | 1; pid?: number;
  gift_eligible?: 0 | 1;
}
export interface FullGiftBrand { id: number; brand_name: string }
export interface FullGiftLabel { id: number; label_name: string }
export interface FullGiftCoupon {
  id: number; coupon_title: string; coupon_type: 1 | 2; coupon_price: string | number;
  type: number; use_min_price: string | number; is_permanent: 0 | 1; remain_count: number;
  receive_type: number; status: 0 | 1; is_del: 0 | 1;
}
export interface FullGiftGiftProduct {
  id: number; product_id: number; unique: string; store_name: string;
  image: string; stock: number; sku: { id: number; unique: string; suk: string; stock: number; is_retired: 0 | 1 };
}
export interface FullGiftRuleDetail extends FullGiftRule {
  giveCoupon: (Omit<FullGiftCoupon, 'id'> & { id: number; coupon_id: number; limit_num: number; surplus_num: number })[];
  giveProducts: (FullGiftGiftProduct & { limit_num: number; surplus_num: number })[];
}
export function fullGiftAvailablePool(newLimit: number, oldLimit = 0, oldSurplus = 0): number {
  if (!integer(newLimit, 1) || newLimit > 99_999_999 || !integer(oldLimit) || !integer(oldSurplus)
    || oldSurplus > oldLimit) throw Error('赠送活动池数量无效');
  const available = newLimit - (oldLimit - oldSurplus);
  if (available < 0) throw Error('新总量不能低于已经赠出的数量');
  return available;
}
export interface FullGiftRow {
  id: number; name: string; product_count: number; threshold_type: FullGiftThreshold; desc: string; sum_pay_price: string | number;
  promotions_cate: FullGiftCategory; sum_order: number; sum_user: number;
  old_user: number; new_user: number; status: 0 | 1; revision: string;
}
export interface FullGiftDetail extends FullGiftRow {
  start_time: string; stop_time: string; promotions_cate: FullGiftCategory; promotions: FullGiftRuleDetail[];
  is_label: 0 | 1;
  label_id: number[]; product_partake_type: FullGiftScope;
  product_id: FullGiftSelection[]; brand_id: number[]; store_label_id: number[]; sort: number;
  products: FullGiftProduct[]; brands: FullGiftBrand[]; labels: FullGiftLabel[];
  user_labels: FullGiftLabel[]; selection_issues: string[];
}
export interface FullGiftPage<T> { list: T[]; count: number; page: number; limit: number }
export interface FullGiftListQuery { page: number; limit: number; name?: string; status?: '' | 0 | 1; threshold_type?: '' | FullGiftThreshold }
export interface FullGiftOptionQuery { page: number; limit: number; keyword: string }
export interface FullGiftInput {
  name: string; section_time: [string, string]; promotions_cate: FullGiftCategory;
  threshold_type: FullGiftThreshold; promotions: FullGiftRule[];
  is_label: 0 | 1; label_id: number[];
  product_partake_type: FullGiftScope; product_id: FullGiftSelection[];
  brand_id: number[]; store_label_id: number[]; status: 0 | 1; sort: number;
}
export type FullGiftMutationKey = { request_id: string; revision: string };
export type FullGiftSave = FullGiftInput & { request_id: string; revision?: string };

export function fullGiftDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return false;
  const utc = new Date(value.replace(' ', 'T') + '+08:00');
  const epoch = utc.getTime() / 1000;
  return Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= MAX_INT
    && new Date(utc.getTime() + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19) === value;
}
export function fullGiftRange(value: unknown): [string, string] {
  if (!Array.isArray(value) || value.length !== 2 || !fullGiftDate(value[0]) || !fullGiftDate(value[1]) || value[0] > value[1]) {
    throw Error('请选择完整且有效的上海时间范围，开始时间不能晚于结束时间');
  }
  return [value[0], value[1]];
}
function ids(value: unknown, label: string, max = 10_000): number[] {
  if (Array.isArray(value) && value.length > max) throw Error(`${label}最多选择${max}个`);
  if (!Array.isArray(value) || value.some(id => !integer(id, 1)) || new Set(value).size !== value.length) {
    throw Error(`${label}列表不完整、重复或超过容量`);
  }
  return [...value];
}
function selections(value: unknown): FullGiftSelection[] {
  if (!Array.isArray(value) || value.length > 10_000) throw Error('商品与规格选择不完整');
  const selected = value.map(item => {
    const row = record(item);
    if (!integer(row.product_id, 1) || !Array.isArray(row.unique) || !row.unique.length || row.unique.length > 10_000
      || row.unique.some(unique => !text(unique) || !unique.trim() || unique.length > 8)
      || new Set(row.unique).size !== row.unique.length) throw Error('商品规格选择不完整或重复');
    return { product_id: row.product_id, unique: [...row.unique] as string[] };
  });
  if (new Set(selected.map(row => row.product_id)).size !== selected.length) throw Error('商品选择重复');
  return selected;
}
function decimalAmount(value: unknown, label: string): number {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d+(?:\.\d{1,2})?$/u.test(raw) || !Number.isFinite(Number(raw))
    || Number(raw) <= 0 || Number(raw) > 999_999) throw Error(`${label}须为大于零、最多两位小数且不超过999999元`);
  return Number(raw);
}
function rules(value: unknown, category: FullGiftCategory, thresholdType: FullGiftThreshold): FullGiftRule[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || category === 2 && value.length !== 1) {
    throw Error('阶梯规则须有1–100级；循环规则只能有1级');
  }
  let previous = 0;
  return value.map((item) => {
    const row = record(item);
    if (row.id !== undefined && !integer(row.id, 1)) throw Error('优惠层级身份无效');
    const threshold = thresholdType === 1 ? decimalAmount(row.threshold, '优惠门槛')
      : integer(row.threshold, 1) && row.threshold <= 999_999 ? row.threshold : NaN;
    if (!Number.isFinite(threshold) || threshold <= previous) throw Error('优惠门槛须为正数且逐级递增；件数须为整数');
    if (!integer(row.give_integral) || row.give_integral > 999_999) throw Error('赠送积分须为0–999999的整数');
    if (!Array.isArray(row.give_coupon_id) || row.give_coupon_id.length > 100) throw Error('每级赠券最多100种');
    if (!Array.isArray(row.give_product_id) || row.give_product_id.length > 100) throw Error('每级赠品规格最多100种');
    const give_coupon_id = row.give_coupon_id.map(raw => {
      const item = record(raw);
      if (!integer(item.give_coupon_id, 1) || !integer(item.give_coupon_num, 1) || item.give_coupon_num > 99_999_999) throw Error('赠券身份或活动池数量无效');
      return { give_coupon_id: item.give_coupon_id, give_coupon_num: item.give_coupon_num };
    });
    const give_product_id = row.give_product_id.map(raw => {
      const item = record(raw);
      if (!integer(item.give_product_id, 1) || !text(item.unique) || !item.unique || item.unique.length > 8
        || !integer(item.give_product_num, 1) || item.give_product_num > 99_999_999) throw Error('赠品SKU身份或活动池数量无效');
      return { give_product_id: item.give_product_id, unique: item.unique, give_product_num: item.give_product_num };
    });
    if (new Set(give_coupon_id.map(item => item.give_coupon_id)).size !== give_coupon_id.length
      || new Set(give_product_id.map(item => `${item.give_product_id}:${item.unique}`)).size !== give_product_id.length) throw Error('同一级不能重复选择赠券或赠品规格');
    if (row.give_integral === 0 && !give_coupon_id.length && !give_product_id.length) throw Error('每级至少配置赠积分、赠券或赠品之一');
    previous = threshold;
    return { ...(row.id === undefined ? {} : { id: row.id }), threshold, give_integral: row.give_integral,
      give_coupon_id, give_product_id } as FullGiftRule;
  });
}
function requestKey(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(value)) throw Error('操作请求 ID 无效');
  return value;
}
export function normalizeFullGift(value: FullGiftInput): FullGiftInput {
  const name = value.name?.trim().normalize('NFC');
  if (!name || [...name].length > 255 || !text(name)) throw Error('请输入 1–255 字的活动名称');
  if (![1, 2].includes(value.promotions_cate) || ![1, 2].includes(value.threshold_type)) throw Error('阶梯/循环或满额/满件条件无效');
  if (!flag(value.status) || !integer(value.sort) || value.sort > 32_767 || ![1, 2, 4, 5].includes(value.product_partake_type)) throw Error('活动状态、排序或商品参与范围无效');
  if (!flag(value.is_label)) throw Error('用户标签开关无效');
  const product_id = selections(value.product_id), brand_id = ids(value.brand_id, '品牌');
  const store_label_id = ids(value.store_label_id, '商品标签'), label_id = ids(value.label_id, '用户标签', 100);
  const promotions = rules(value.promotions, value.promotions_cate, value.threshold_type);
  if (value.is_label === 1 && !label_id.length) throw Error('请选择支付后关联的用户标签');
  if (value.is_label === 0 && label_id.length) throw Error('关闭用户标签后仍有标签选项');
  if (value.product_partake_type === 2 && !product_id.length) throw Error('请选择商品及具体规格');
  if (value.product_partake_type === 4 && !brand_id.length) throw Error('请选择参与活动的品牌');
  if (value.product_partake_type === 5 && !store_label_id.length) throw Error('请选择参与活动的商品标签');
  return {
    name, section_time: fullGiftRange(value.section_time), promotions_cate: value.promotions_cate,
    threshold_type: value.threshold_type, promotions, is_label: value.is_label,
    label_id, product_partake_type: value.product_partake_type,
    product_id: value.product_partake_type === 2 ? product_id : [],
    brand_id: value.product_partake_type === 4 ? brand_id : [],
    store_label_id: value.product_partake_type === 5 ? store_label_id : [],
    status: value.status, sort: value.sort,
  };
}
function money(value: unknown): value is string | number {
  return typeof value === 'number' ? Number.isFinite(value) && value >= 0
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value);
}
function parseRow(value: unknown): FullGiftRow {
  const row = record(value);
  if (!integer(row.id, 1) || !text(row.name) || !integer(row.product_count) || ![1, 2].includes(row.threshold_type as number)
    || ![1, 2].includes(row.promotions_cate as number) || !text(row.desc)
    || !money(row.sum_pay_price)
    || !integer(row.sum_order) || !integer(row.sum_user) || !integer(row.old_user) || !integer(row.new_user)
    || !flag(row.status) || !revision(row.revision)) throw Error('满送活动列表字段错误');
  return row as unknown as FullGiftRow;
}
function parseSku(value: unknown): FullGiftSku {
  const row = record(value);
  if (!integer(row.id, 1) || !text(row.unique) || !row.unique || !text(row.suk)
    || !money(row.price) || !integer(row.stock) || row.is_retired !== undefined && !flag(row.is_retired)) throw Error('商品规格身份不完整');
  return row as unknown as FullGiftSku;
}
function parseProduct(value: unknown): FullGiftProduct {
  const row = record(value);
  if (!integer(row.id, 1) || !text(row.store_name) || !text(row.image) || !money(row.price)
    || !integer(row.stock) || !text(row.cate_name) || !Array.isArray(row.attrValue) || row.attrValue.length > 10_000
    || row.gift_eligible !== undefined && !flag(row.gift_eligible)) throw Error('商品选项身份不完整');
  const attrValue = row.attrValue.map(parseSku);
  if (new Set(attrValue.map(item => item.unique)).size !== attrValue.length) throw Error('商品规格身份重复');
  return { ...row, attrValue } as unknown as FullGiftProduct;
}
function parseBrand(value: unknown): FullGiftBrand {
  const row = record(value); if (!integer(row.id, 1) || !text(row.brand_name)) throw Error('品牌身份不完整');
  return row as unknown as FullGiftBrand;
}
function parseLabel(value: unknown): FullGiftLabel {
  const row = record(value); if (!integer(row.id, 1) || !text(row.label_name)) throw Error('标签身份不完整');
  return row as unknown as FullGiftLabel;
}
function parseCoupon(value: unknown): FullGiftCoupon {
  const row = record(value);
  if (!integer(row.id, 1) || !text(row.coupon_title) || !row.coupon_title || ![1, 2].includes(row.coupon_type as number)
    || !money(row.coupon_price) || !integer(row.type) || !money(row.use_min_price) || !flag(row.is_permanent)
    || !integer(row.remain_count) || !integer(row.receive_type) || !flag(row.status) || !flag(row.is_del)) {
    throw Error('赠券发行身份不完整');
  }
  return row as unknown as FullGiftCoupon;
}
function queryPage(query: { page: number; limit: number }) {
  if (!integer(query.page, 1) || !integer(query.limit, 1) || query.limit > 50 || (query.page - 1) * query.limit > 100_000) throw Error('分页范围无效');
}
function parsePage<T extends { id: number }>(value: unknown, query: { page: number; limit: number }, parse: (value: unknown) => T): FullGiftPage<T> {
  const payload = record(value);
  if (!Array.isArray(payload.list) || !integer(payload.count) || payload.page !== query.page || payload.limit !== query.limit || payload.list.length > query.limit || payload.list.length > payload.count) throw Error('满送活动分页结果不完整');
  const list = payload.list.map(parse);
  if (new Set(list.map(row => row.id)).size !== list.length) throw Error('满送活动分页记录重复');
  return { list, count: payload.count as number, page: query.page, limit: query.limit };
}
export async function apiFullGiftList(query: FullGiftListQuery, signal?: AbortSignal) {
  queryPage(query);
  if (query.name !== undefined && (!text(query.name) || query.name.length > 200)
    || query.status !== undefined && !['', 0, 1].includes(query.status)
    || query.threshold_type !== undefined && !['', 1, 2].includes(query.threshold_type)) throw Error('满送活动筛选无效');
  return parsePage(await getData(request.get(endpoint, { params: query, signal })), query, parseRow);
}
export async function apiFullGiftProducts(query: FullGiftOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/products`, { params: query, signal })), query, parseProduct);
}
export async function apiFullGiftBrands(query: FullGiftOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/brands`, { params: query, signal })), query, parseBrand);
}
export async function apiFullGiftLabels(query: FullGiftOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/labels`, { params: query, signal })), query, parseLabel);
}
export async function apiFullGiftUserLabels(query: FullGiftOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/user-labels`, { params: query, signal })), query, parseLabel);
}
export async function apiFullGiftCoupons(query: FullGiftOptionQuery, signal?: AbortSignal) {
  queryPage(query); return parsePage(await getData(request.get(`${endpoint}/coupons`, { params: query, signal })), query, parseCoupon);
}
export async function apiFullGiftDetail(id: number, signal?: AbortSignal): Promise<FullGiftDetail> {
  if (!integer(id, 1)) throw Error('满送活动 ID 无效');
  const payload = record(await getData(request.get(`${endpoint}/${id}`, { signal })));
  const info = record(payload.info); parseRow(info);
  if (info.id !== id || !fullGiftDate(info.start_time) || !fullGiftDate(info.stop_time)
    || ![1, 2].includes(info.promotions_cate as number) || !flag(info.is_label)
    || !integer(info.sort) || info.sort > 32_767
    || ![1, 2, 3, 4, 5].includes(info.product_partake_type as number)) throw Error('满送活动详情身份或配置不完整');
  const label_id = ids(info.label_id, '用户标签', 100), brand_id = ids(info.brand_id, '品牌');
  const store_label_id = ids(info.store_label_id, '商品标签'), product_id = selections(info.product_id);
  const promotions = rules(info.promotions, info.promotions_cate as FullGiftCategory, info.threshold_type as FullGiftThreshold);
  if (promotions[0].id !== id || new Set(promotions.map(item => item.id)).size !== promotions.length) throw Error('优惠层级身份不完整或重复');
  if (info.is_label === 1 && !label_id.length || info.is_label === 0 && label_id.length
    || info.is_overlay !== undefined && info.is_overlay !== 0
    || Array.isArray(info.overlay) && info.overlay.length > 0) throw Error('标签或历史叠加配置不能无损编辑');
  if (!Array.isArray(info.products) || !Array.isArray(info.brands) || !Array.isArray(info.labels)
    || !Array.isArray(info.user_labels) || !Array.isArray(info.selection_issues)
    || info.selection_issues.some(item => !text(item))) throw Error('满送活动详情选项不完整');
  if (info.selection_issues.length) throw Error(`现有商品或规格已变化，禁止直接保存：${info.selection_issues.join('；')}`);
  const promotionDetails = promotions.map((rule, index): FullGiftRuleDetail => {
    const source = record((info.promotions as unknown[])[index]);
    if (source.pid !== (index === 0 ? 0 : id)) throw Error('优惠层级父级身份不一致');
    if (!Array.isArray(source.giveCoupon) || !Array.isArray(source.giveProducts)) throw Error('赠券或赠品详情回显不完整');
    const giveCoupon = source.giveCoupon.map(raw => {
      const item = record(raw);
      parseCoupon({ ...item, id: item.coupon_id });
      if (!integer(item.id, 1) || !integer(item.coupon_id, 1) || !integer(item.limit_num, 1)
        || !integer(item.surplus_num)) throw Error('赠券池身份或数量不完整');
      return item as unknown as FullGiftRuleDetail['giveCoupon'][number];
    });
    const giveProducts = source.giveProducts.map(raw => {
      const item = record(raw), sku = record(item.sku);
      if (!integer(item.id, 1) || !integer(item.product_id, 1) || !text(item.unique) || !item.unique
        || !text(item.store_name) || !text(item.image) || !integer(item.stock)
        || !integer(item.limit_num, 1) || !integer(item.surplus_num)
        || !integer(sku.id, 1) || sku.unique !== item.unique || !text(sku.suk)
        || !integer(sku.stock) || sku.is_retired !== 0) throw Error('赠品规格或数量回显不完整');
      return item as unknown as FullGiftRuleDetail['giveProducts'][number];
    });
    if (giveCoupon.length !== rule.give_coupon_id.length || giveProducts.length !== rule.give_product_id.length
      || rule.give_coupon_id.some(item => !giveCoupon.some(choice => choice.coupon_id === item.give_coupon_id && choice.limit_num === item.give_coupon_num))
      || rule.give_product_id.some(item => !giveProducts.some(choice => choice.product_id === item.give_product_id
        && choice.unique === item.unique && choice.limit_num === item.give_product_num))) throw Error('赠券或赠品回显与规则不一致，不能截断编辑');
    return { ...rule, giveCoupon, giveProducts };
  });
  const products = info.products.map(parseProduct), brands = info.brands.map(parseBrand);
  const labels = info.labels.map(parseLabel), user_labels = info.user_labels.map(parseLabel);
  const matchIds = (selected: number[], rows: { id: number }[]) => selected.length === rows.length
    && new Set(rows.map(row => row.id)).size === rows.length && selected.every(id => rows.some(row => row.id === id));
  if (!matchIds(brand_id, brands) || !matchIds(store_label_id, labels) || !matchIds(label_id, user_labels)) throw Error('品牌或标签已失效，不能编辑截断数据');
  if ([2, 3].includes(info.product_partake_type as number)) {
    if (!matchIds(product_id.map(item => item.product_id), products)) throw Error('商品回显不完整，不能编辑截断数据');
    for (const choice of product_id) {
      const product = products.find(item => item.id === choice.product_id)!;
      if (product.is_show !== 1 || product.is_del !== 0 || product.is_verify !== 1 || product.pid !== 0
        || choice.unique.length !== product.attrValue.length
        || choice.unique.some(unique => !product.attrValue.some(sku => sku.unique === unique && sku.is_retired === 0))) {
        throw Error(`商品 #${choice.product_id} 的规格已退役或回显不完整，不能编辑截断数据`);
      }
    }
  }
  return { ...info, label_id, brand_id, store_label_id, product_id, promotions: promotionDetails,
    products, brands, labels, user_labels } as unknown as FullGiftDetail;
}
function mutationResult(value: unknown, id = 0) {
  const row = record(value); if (!integer(row.id, 1) || id && row.id !== id) throw Error('写入响应未能确认，请重新读取满送活动核对');
  return { id: row.id as number };
}
export async function apiFullGiftSave(id: number, value: FullGiftSave, signal?: AbortSignal) {
  if (!integer(id) || id && !revision(value.revision)) throw Error('满送活动身份或版本无效');
  const normalized = normalizeFullGift(value);
  if (id ? normalized.promotions[0].id !== id : normalized.promotions.some(rule => rule.id !== undefined)) throw Error('满送活动层级身份无效');
  const body = { ...normalized, request_id: requestKey(value.request_id), ...(id ? { revision: value.revision } : {}) };
  return mutationResult(await getData(id ? request.put(`${endpoint}/${id}`, body, { signal }) : request.post(endpoint, body, { signal })), id);
}
export async function apiFullGiftStatus(id: number, value: FullGiftMutationKey & { status: 0 | 1 }, signal?: AbortSignal) {
  if (!integer(id, 1) || !revision(value.revision) || !flag(value.status)) throw Error('满送活动身份、版本或状态无效');
  return mutationResult(await getData(request.patch(`${endpoint}/${id}/status`, { ...value, request_id: requestKey(value.request_id) }, { signal })), id);
}
export async function apiFullGiftDelete(id: number, value: FullGiftMutationKey, signal?: AbortSignal) {
  if (!integer(id, 1) || !revision(value.revision)) throw Error('满送活动身份或版本无效');
  return mutationResult(await getData(request.delete(`${endpoint}/${id}`, { data: { ...value, request_id: requestKey(value.request_id) }, signal })), id);
}
