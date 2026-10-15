import { classifyProductMediaReference } from '../../../../common/productMediaReference';

export type ProductType = 0 | 1 | 3 | 4;
export type Flag = 0 | 1;
// Nested JSON is opaque to Vue's recursive UnwrapRef; the bounded server parser validates its leaves.
export type Json = null | string | number | boolean | unknown[] | { [key: string]: unknown };
export interface EditorDimension { value: string; detail: string[] }
export interface EditorParameter { name: string; value: string; sort: number; status: Flag }
export interface EditorSku {
  id?: number; unique?: string; suk: string; detail: Record<string, string>; pic: string;
  price: number; settle_price: number; cost: number; ot_price: number; vip_price: number; stock: number;
  bar_code: string; code: string; weight: number; volume: number; brokerage: number; brokerage_two: number;
  disk_info: string; virtual_list: Json[]; write_times: number; write_valid: 1 | 2 | 3; days: number; section_time: string[];
  delivery_mode: 'cards' | 'fixed'; original_disk_info: string; sales: number; virtual_available: number; virtual_total: number;
}
export interface ProductSavePayload {
  product_type: ProductType; supplier_id: number; cate_id: number[]; store_name: string; store_info: string; keyword: string;
  unit_name: string; recommend_image: string; slider_image: string[]; is_sub: Array<0 | 1>; sort: number; ficti: number;
  give_integral: number; is_show: 0 | 1 | 2; is_hot: Flag; is_benefit: Flag; is_best: Flag; is_new: Flag; mer_use: Flag;
  is_postage: Flag; is_good: Flag; description: string; spec_type: 0 | 1; video_open: Flag; video_link: string;
  items: EditorDimension[]; attrs: Array<Omit<EditorSku, 'id' | 'suk' | 'delivery_mode' | 'original_disk_info' | 'sales' | 'virtual_available' | 'virtual_total'>>;
  recommend: Json[]; activity: string[]; coupon_ids: number[]; label_id: number[]; command_word: string; tao_words: '';
  type: 0; delivery_type: number[]; freight: 1 | 2 | 3; postage: number; temp_id: number; recommend_list: number[];
  brand_id: number[]; soure_link: ''; bar_code: string; code: string; is_support_refund: Flag; is_presale_product: Flag;
  presale_time: string[]; presale_day: number; is_vip_product: Flag; auto_on_time: string; auto_off_time: string;
  custom_form: Json[] | { [key: string]: Json }; system_form_id: number; store_label_id: number[]; ensure_id: number[];
  specs: EditorParameter[]; specs_id: number; is_limit: Flag; limit_type: number; limit_num: number;
}
export const PRODUCT_EDITOR_FIELDS = [
  'product_type', 'supplier_id', 'cate_id', 'store_name', 'store_info', 'keyword', 'unit_name', 'recommend_image', 'slider_image',
  'is_sub', 'sort', 'ficti', 'give_integral', 'is_show', 'is_hot', 'is_benefit', 'is_best', 'is_new', 'mer_use', 'is_postage', 'is_good',
  'description', 'spec_type', 'video_open', 'video_link', 'items', 'attrs', 'recommend', 'activity', 'coupon_ids', 'label_id',
  'command_word', 'tao_words', 'type', 'delivery_type', 'freight', 'postage', 'temp_id', 'recommend_list', 'brand_id', 'soure_link',
  'bar_code', 'code', 'is_support_refund', 'is_presale_product', 'presale_time', 'presale_day', 'is_vip_product', 'auto_on_time',
  'auto_off_time', 'custom_form', 'system_form_id', 'store_label_id', 'ensure_id', 'specs', 'specs_id', 'is_limit', 'limit_type', 'limit_num',
] as const satisfies ReadonlyArray<keyof ProductSavePayload>;

export interface ProductEditorModel extends Omit<ProductSavePayload, 'attrs'> { attrs: EditorSku[] }
export interface ProductEditorDetail {
  productInfo: Record<string, unknown>;
  tempList: Array<{ id: number; name: string }>;
  cateList: unknown[];
  editor: { stored_custom_form: unknown; retired_attrs: unknown[]; description_preview: string; contract_version?: number; erp_open?: boolean };
}
export interface PendingProductSave { operation_id: string; requested_id: number; actor_id: number }
export interface ProductSaveReceipt extends PendingProductSave {
  state: 'unknown' | 'committed' | 'not_applied';
  result: { id: number; created: boolean } | null;
}
export type ProductOperationReceipt = Omit<ProductSaveReceipt, 'requested_id'> & { requested_id: number | null };
export interface EditorDraft extends ProductSavePayload {
  [key: string]: unknown;
  editor_contract_version: 1; editor_target: number; editor_pending: PendingProductSave | null;
}
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品资料格式无效');
  return value as Record<string, unknown>;
};
const number = (value: unknown, fallback = 0): number => {
  if (value === undefined || value === null || value === '') return fallback;
  const result = Number(value);
  if (!Number.isFinite(result)) throw Error('商品数值资料无效');
  return result;
};
const text = (value: unknown, fallback = ''): string => value === undefined || value === null ? fallback : typeof value === 'string' ? value : (() => { throw Error('商品文字资料无效'); })();
const flag = (value: unknown, fallback: Flag = 0): Flag => value === undefined ? fallback : value === true || Number(value) === 1 ? 1 : value === false || Number(value) === 0 ? 0 : (() => { throw Error('商品开关资料无效'); })();
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : (() => { throw Error('商品列表资料无效'); })();
const id = (value: unknown): number => { const result = number(value); if (!Number.isSafeInteger(result) || result < 1 || result > 2147483647) throw Error('商品关联ID无效'); return result; };
export function selectedIds(value: unknown, key = 'id'): number[] {
  const result = list(value).filter(item => item !== '').map(item => id(typeof item === 'object' && item !== null ? object(item)[key] : item));
  if (new Set(result).size !== result.length) throw Error('商品关联ID重复');
  return result;
}
export function canonicalProductImage(value: string): string {
  if (!value) return '';
  const reference = classifyProductMediaReference(value);
  if (reference.kind === 'invalid') throw Error('图片须为素材引用或有效的HTTPS图片地址');
  return reference.reference;
}
export function newEditorSku(detail: Record<string, string> = { 规格: '默认' }): EditorSku {
  return { suk: Object.values(detail).join(','), detail: { ...detail }, pic: '', price: 0, settle_price: 0, cost: 0, ot_price: 0,
    vip_price: 0, stock: 0, bar_code: '', code: '', weight: 0, volume: 0, brokerage: 0, brokerage_two: 0, disk_info: '', virtual_list: [],
    write_times: 1, write_valid: 1, days: 1, section_time: [], delivery_mode: 'cards', original_disk_info: '', sales: 0, virtual_available: 0, virtual_total: 0 };
}
export function newProductEditor(): ProductEditorModel {
  return { product_type: 0, supplier_id: 0, cate_id: [], store_name: '', store_info: '', keyword: '', unit_name: '件', recommend_image: '',
    slider_image: [], is_sub: [], sort: 0, ficti: 0, give_integral: 0, is_show: 1, is_hot: 0, is_benefit: 0, is_best: 0, is_new: 0,
    mer_use: 0, is_postage: 1, is_good: 0, description: '', spec_type: 0, video_open: 0, video_link: '',
    items: [{ value: '规格', detail: ['默认'] }], attrs: [newEditorSku()], recommend: [], activity: ['默认', '秒杀', '砍价', '拼团'],
    coupon_ids: [], label_id: [], command_word: '', tao_words: '', type: 0, delivery_type: [1], freight: 1, postage: 0, temp_id: 0,
    recommend_list: [], brand_id: [], soure_link: '', bar_code: '', code: '', is_support_refund: 1, is_presale_product: 0,
    presale_time: [], presale_day: 0, is_vip_product: 0, auto_on_time: '', auto_off_time: '', custom_form: [], system_form_id: 0,
    store_label_id: [], ensure_id: [], specs: [], specs_id: 0, is_limit: 0, limit_type: 1, limit_num: 1 };
}
export function restoreEditorSkus(value: unknown, dims: EditorDimension[]): EditorSku[] {
  return list(value).map(item => {
    const row = object(item), base = newEditorSku();
    const detail = row.detail === undefined ? Object.fromEntries(dims.map((dim, index) => [dim.value, text(row[`value${index + 1}`])]))
      : Object.fromEntries(Object.entries(object(row.detail)).map(([key, value]) => [key, text(value)]));
    const sku = { ...base, detail, suk: text(row.suk ?? row.values, dims.map(dim => detail[dim.value]).join(',')),
      pic: text(row.pic), disk_info: text(row.disk_info), bar_code: text(row.bar_code), code: text(row.code),
      section_time: list(row.section_time).map(item => text(item)), virtual_list: list(row.virtual_list) as Json[] };
    for (const field of ['price', 'settle_price', 'cost', 'ot_price', 'vip_price', 'stock', 'weight', 'volume', 'brokerage', 'brokerage_two',
      'sales', 'virtual_available', 'virtual_total', 'write_times', 'days'] as const) sku[field] = number(row[field], base[field]);
    const valid = number(row.write_valid, 1); if (![1, 2, 3].includes(valid)) throw Error('次卡有效期资料无效'); sku.write_valid = valid as 1 | 2 | 3;
    if (row.id !== undefined) sku.id = id(row.id);
    if (row.unique !== undefined) { if (typeof row.unique !== 'string' || !row.unique) throw Error('SKU身份无效'); sku.unique = row.unique; }
    sku.delivery_mode = sku.disk_info.trim() ? 'fixed' : 'cards'; sku.original_disk_info = sku.disk_info;
    return sku;
  });
}
export function fromLegacyDetail(value: ProductEditorDetail) {
  const dto = object(value), p = object(dto.productInfo), extra = object(dto.editor);
  if (!Array.isArray(dto.tempList) || !Array.isArray(dto.cateList) || typeof extra.description_preview !== 'string' || !Array.isArray(extra.retired_attrs)) throw Error('完整商品资料响应不完整');
  const model = newProductEditor(), productType = number(p.product_type);
  if (![0, 1, 3, 4].includes(productType)) throw Error('商品履约类型不支持编辑'); model.product_type = productType as ProductType;
  const specType = number(p.spec_type); if (![0, 1].includes(specType)) throw Error('商品规格类型无效'); model.spec_type = specType as 0 | 1;
  for (const field of ['store_name', 'store_info', 'keyword', 'unit_name', 'recommend_image', 'description', 'video_link', 'command_word', 'bar_code', 'code', 'auto_on_time', 'auto_off_time'] as const) model[field] = text(p[field], model[field]);
  for (const field of ['supplier_id', 'sort', 'ficti', 'give_integral', 'postage', 'temp_id', 'presale_day', 'system_form_id', 'specs_id', 'limit_type', 'limit_num'] as const) model[field] = number(p[field], model[field]);
  for (const field of ['is_hot', 'is_benefit', 'is_best', 'is_new', 'mer_use', 'is_postage', 'is_good', 'video_open', 'is_support_refund', 'is_presale_product', 'is_vip_product', 'is_limit'] as const) model[field] = flag(p[field], model[field]);
  for (const field of ['cate_id', 'brand_id', 'store_label_id', 'label_id', 'ensure_id'] as const) model[field] = selectedIds(p[field]);
  model.coupon_ids = selectedIds(p.coupons ?? p.coupon_ids); model.recommend_list = selectedIds(p.recommend_list, 'product_id');
  model.slider_image = list(p.slider_image).map(value => text(value)); model.is_sub = list(p.is_sub).map(value => number(value)) as Array<0 | 1>;
  if (model.is_sub.some(value => value !== 0 && value !== 1) || new Set(model.is_sub).size !== model.is_sub.length) throw Error('会员佣金配置无效');
  const isShow = number(p.is_show); if (![0, 1, 2].includes(isShow)) throw Error('商品上下架资料无效'); model.is_show = isShow as 0 | 1 | 2;
  const freight = number(p.freight, 1); if (![1, 2, 3].includes(freight)) throw Error('商品运费资料无效'); model.freight = freight as 1 | 2 | 3;
  model.delivery_type = list(p.delivery_type).map(value => number(value)); model.presale_time = list(p.presale_time).map(value => text(value));
  model.activity = list(p.activity).map(value => text(value)); model.recommend = cloneJson(list(p.recommend)) as Json[];
  model.items = model.spec_type === 0 ? [{ value: '规格', detail: ['默认'] }] : list(p.items).map(item => { const row = object(item); return { value: text(row.value), detail: list(row.detail).map(item => text(item)) }; });
  model.attrs = restoreEditorSkus(model.spec_type === 0 ? [object(p.attr)] : p.attrs, model.items);
  model.specs = list(p.specs).map(item => { const row = object(item); return { name: text(row.name), value: text(row.value), sort: number(row.sort), status: flag(row.status, 1) }; });
  const snapshot = extra.stored_custom_form ?? []; if (!Array.isArray(snapshot)) object(snapshot); model.custom_form = cloneJson(snapshot) as ProductEditorModel['custom_form'];
  return { model, owner: { type: number(p.type), relation_id: number(p.relation_id), supplier_id: model.supplier_id },
    retired: restoreEditorSkus(extra.retired_attrs, model.items), preview: extra.description_preview, savedDescription: model.description };
}
/** Explicit projection: read-only owner, server preview, SKU ids and import contexts never enter the write body. */
export function toLegacySave(m: ProductEditorModel): ProductSavePayload {
  // Element Plus clears numeric/select controls to null/undefined. Always emit
  // every main numeric key; optional blank values have the explicit zero/default meaning.
  const productType = number(m.product_type) as ProductType, freight = number(m.freight, 1) as 1 | 2 | 3;
  const attrs = m.attrs.map(row => ({ ...(row.unique ? { unique: row.unique } : {}), detail: { ...row.detail }, pic: canonicalProductImage(row.pic || m.slider_image[0] || ''),
    price: row.price, settle_price: row.settle_price, cost: row.cost, ot_price: row.ot_price, vip_price: row.vip_price, stock: row.stock,
    bar_code: row.bar_code, code: row.code, weight: row.weight, volume: row.volume,
    brokerage: m.is_sub.includes(1) ? row.brokerage : 0, brokerage_two: m.is_sub.includes(1) ? row.brokerage_two : 0,
    disk_info: m.product_type === 1 && row.delivery_mode === 'fixed' ? row.disk_info : '', virtual_list: [],
    write_times: number(row.write_times), write_valid: number(row.write_valid, 1) as 1 | 2 | 3, days: number(row.days), section_time: [...(row.section_time || [])] }));
  return { product_type: productType, supplier_id: number(m.supplier_id), cate_id: [...m.cate_id], store_name: m.store_name, store_info: m.store_info,
    keyword: m.keyword, unit_name: m.unit_name, recommend_image: canonicalProductImage(m.recommend_image), slider_image: m.slider_image.map(canonicalProductImage),
    is_sub: [...m.is_sub], sort: number(m.sort), ficti: number(m.ficti), give_integral: number(m.give_integral), is_show: m.auto_on_time ? 0 : number(m.is_show) as 0 | 1 | 2,
    is_hot: flag(m.is_hot), is_benefit: flag(m.is_benefit), is_best: flag(m.is_best), is_new: flag(m.is_new), mer_use: flag(m.mer_use), is_postage: flag(m.is_postage),
    is_good: flag(m.is_good), description: m.description, spec_type: productType === 4 ? 0 : number(m.spec_type) as 0 | 1, video_open: flag(m.video_open), video_link: m.video_link,
    items: m.items.map(row => ({ value: row.value, detail: [...row.detail] })), attrs, recommend: cloneJson(m.recommend), activity: [...m.activity],
    coupon_ids: [...m.coupon_ids], label_id: [...m.label_id], command_word: m.command_word, tao_words: '', type: 0,
    delivery_type: productType === 4 ? [2] : productType === 0 ? [...m.delivery_type] : [], freight: productType === 0 || productType === 4 ? freight : 1,
    postage: (productType === 0 || productType === 4) && freight === 2 ? number(m.postage) : 0, temp_id: (productType === 0 || productType === 4) && freight === 3 ? number(m.temp_id) : 0,
    recommend_list: [...m.recommend_list], brand_id: [...m.brand_id], soure_link: '', bar_code: m.bar_code, code: m.code,
    is_support_refund: flag(m.is_support_refund, 1), is_presale_product: flag(m.is_presale_product), presale_time: [...(m.presale_time || [])], presale_day: number(m.presale_day),
    is_vip_product: flag(m.is_vip_product), auto_on_time: m.auto_on_time || '', auto_off_time: m.auto_off_time || '', custom_form: cloneJson(m.custom_form),
    system_form_id: number(m.system_form_id), store_label_id: [...m.store_label_id], ensure_id: [...m.ensure_id],
    specs: m.specs.map(row => ({ name: row.name, value: row.value, sort: number(row.sort), status: flag(row.status, 1) })), specs_id: number(m.specs_id),
    is_limit: flag(m.is_limit), limit_type: number(m.limit_type), limit_num: number(m.limit_num) };
}
export function validateProductSave(p: ProductSavePayload, erp: boolean | null, now = Date.now()): void {
  if (![0, 1, 3, 4].includes(p.product_type) || ![0, 1].includes(p.spec_type) || ![1, 2, 3].includes(p.freight)) throw Error('商品履约、规格或运费类型无效');
  if ((['supplier_id', 'sort', 'ficti', 'presale_day', 'system_form_id', 'specs_id', 'limit_type', 'limit_num', 'temp_id'] as const).some(field => !Number.isSafeInteger(p[field]) || p[field] < 0 || p[field] > 2147483647) || !Number.isFinite(p.give_integral) || p.give_integral < 0 || !Number.isFinite(p.postage) || p.postage < 0) throw Error('商品排序、销量、积分、运费及规则数量须为有效非负数值');
  if (!p.store_name.trim()) throw Error('请输入商品名称'); if (!p.cate_id.length) throw Error('请选择至少一个分类');
  if (!p.slider_image.length || p.slider_image.length > 10 || p.slider_image.some(value => !value)) throw Error('请填写1至10张轮播图');
  if (!p.attrs.length || p.attrs.length > 200 || p.items.length > 3 || p.items.some(row => !row.value.trim() || !row.detail.length || row.detail.length > 50)) throw Error('规格须为1至3维、每维1至50值、最多200个组合');
  if (new Set(p.items.map(row => row.value)).size !== p.items.length || p.items.some(row => row.value.length > 32 || [row.value, ...row.detail].some(value => /[,\p{Cc}\p{Cs}]/u.test(value)) || new Set(row.detail).size !== row.detail.length || row.detail.some(value => !value || value.length > 64))) throw Error('规格名称和值不能重复、为空或包含逗号与控制字符');
  const combinations = p.items.reduce<Array<Record<string, string>>>((rows, dim) => rows.flatMap(row => dim.detail.map(value => ({ ...row, [dim.value]: value }))), [{}]);
  if (combinations.length !== p.attrs.length || new Set(p.attrs.map(row => detailIdentity(row.detail))).size !== p.attrs.length || combinations.some(detail => !p.attrs.some(row => detailIdentity(row.detail) === detailIdentity(detail)))) throw Error('规格维度已改变，请先生成完整SKU组合再保存');
  if (p.attrs.some(row => !row.pic || row.pic.length > 128 || !Number.isFinite(row.price) || row.price <= 0 || !Number.isSafeInteger(row.stock) || row.stock < 0)) throw Error('请填写每个SKU的图片、有效售价和整数库存（图片引用最长128字符）');
  if (p.attrs.some(row => (['price', 'settle_price', 'cost', 'ot_price', 'vip_price', 'weight', 'volume', 'brokerage', 'brokerage_two'] as const).some(key => !Number.isFinite(row[key]) || row[key] < 0))) throw Error('SKU金额、重量与体积须为非负有效数值');
  if (p.is_sub.includes(0) && p.attrs.some(row => row.vip_price <= 0)) throw Error('开启会员价后每个SKU会员价必须大于0');
  if ((p.product_type === 0 || p.product_type === 4) && (!p.delivery_type.length || p.freight === 2 && p.postage <= 0 || p.freight === 3 && !p.temp_id)) throw Error('请完善配送方式和运费设置');
  if (p.product_type === 4 && (p.attrs.length !== 1 || p.spec_type !== 0 || p.attrs.some(row => !Number.isSafeInteger(row.write_times) || row.write_times < 1 || row.write_times > 99999999 || ![1, 2, 3].includes(row.write_valid) || row.write_valid === 2 && (!Number.isSafeInteger(row.days) || row.days < 1 || row.days > 3650) || row.write_valid === 3 && (row.section_time.length !== 2 || row.section_time[1]! <= row.section_time[0]!)))) throw Error('请完善次卡次数及有效期');
  if (p.is_limit && (!p.limit_num || ![1, 2].includes(p.limit_type))) throw Error('请填写限购方式和数量');
  if (p.video_open && !/^https:\/\/[^\s]+$/u.test(p.video_link)) throw Error('视频请填写完整HTTPS外链');
  if (erp === true && p.product_type === 0 && (!p.code || p.attrs.some(row => !row.code))) throw Error('ERP已开启，请填写商品及每个SKU编码');
  if (p.is_presale_product && (p.presale_time.length !== 2 || p.presale_time.some(value => { const date = Date.parse(`${value.replace(' ', 'T')}+08:00`); return !Number.isFinite(date) || date < now; }))) throw Error('预售起止时间均不能早于当前时间（北京时间）');
  if (new TextEncoder().encode(JSON.stringify({ operation_id: '00000000-0000-4000-8000-000000000000', product: p })).byteLength > 1024 * 1024) throw Error('完整商品请求超过1 MiB，请减少详情或规格');
}
export function detailIdentity(detail: Record<string, string>): string { return JSON.stringify(Object.entries(detail).sort(([a], [b]) => a.localeCompare(b))); }
/** Generator intentionally omits identities. Preserve the exact old identity by semantic dimension names/values. */
export function mergeGeneratedSkus(dimensions: EditorDimension[], generated: unknown, existing: EditorSku[]): EditorSku[] {
  const rows = restoreEditorSkus(generated, dimensions), old = new Map(existing.map(row => [detailIdentity(row.detail), row]));
  if (old.size !== existing.length || new Set(rows.map(row => detailIdentity(row.detail))).size !== rows.length) throw Error('SKU组合存在重复');
  const targets = new Set(rows.map(row => detailIdentity(row.detail)));
  if (existing.some(row => row.unique && !targets.has(detailIdentity(row.detail)))) throw Error('历史SKU不能由重新生成移除或改名，请先使用退役操作');
  return rows.map(row => { const prior = old.get(detailIdentity(row.detail)); return prior ? { ...cloneJson(prior), detail: row.detail, suk: dimensions.map(dim => row.detail[dim.value]).join(',') } : row; });
}
export function parseEditorRoute(value: unknown): number {
  if (value === undefined || value === '' || value === '0') return 0;
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) throw Error('商品编辑ID无效'); return id(value);
}
export function parseProductReceipt(value: unknown, pending: PendingProductSave): ProductOperationReceipt {
  const row = object(value);
  if (row.operation_id !== pending.operation_id || row.actor_id !== pending.actor_id || !['unknown', 'committed', 'not_applied'].includes(String(row.state)) ||
    (row.state === 'unknown' ? row.requested_id !== null : row.requested_id !== pending.requested_id)) throw Error('保存回执与原操作身份不一致，结果仍待确认');
  if (row.state === 'committed') { const result = object(row.result); id(result.id); if (typeof result.created !== 'boolean' || result.created !== (pending.requested_id === 0) || pending.requested_id > 0 && result.id !== pending.requested_id) throw Error('保存回执商品身份无效，结果仍待确认'); }
  else if (row.result !== null) throw Error('保存回执结果无效，结果仍待确认');
  return row as unknown as ProductOperationReceipt;
}
export function parsePendingProductSave(value: unknown, actor: number): PendingProductSave {
  const row = object(value);
  if (Object.keys(row).sort().join(',') !== 'actor_id,operation_id,requested_id' || row.actor_id !== actor || typeof row.operation_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.operation_id) || typeof row.requested_id !== 'number' || !Number.isSafeInteger(row.requested_id) || row.requested_id < 0 || row.requested_id > 2147483647) throw Error('未确认保存的恢复资料无效，请保留当前页面并核实操作记录');
  return { operation_id: row.operation_id, requested_id: row.requested_id, actor_id: actor };
}
export function makeEditorDraft(model: ProductEditorModel, target: number, pending: PendingProductSave | null): EditorDraft {
  return { ...toLegacySave(model), editor_contract_version: 1, editor_target: target, editor_pending: pending ? { ...pending } : null };
}
export function fromEditorDraft(value: unknown, actor: number, target: number): { model: ProductEditorModel; pending: PendingProductSave | null } {
  const row = object(value);
  if (row.editor_contract_version !== 1 || row.editor_target !== target) throw Error('服务器草稿属于其他编辑器或商品，当前表单未覆盖');
  const pending = row.editor_pending === null ? null : parsePendingProductSave(row.editor_pending, actor);
  if (pending && pending.requested_id !== target) throw Error('草稿与未确认保存的商品不一致');
  // Reuse the same field projection, including per-SKU second-card rights and stored form snapshot.
  const model = fromLegacyDetail({ productInfo: { ...row, attr: list(row.attrs)[0], attrs: row.attrs, coupons: row.coupon_ids,
    recommend_list: row.recommend_list, type: 0 }, tempList: [], cateList: [], editor: { stored_custom_form: row.custom_form, retired_attrs: [], description_preview: '' } }).model;
  return { model, pending };
}
