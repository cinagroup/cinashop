import { adminRequest } from './adminRequest';
import { baseRequest, API_BASE, getFormType, RequestError } from '@/utils/request';
import { useAdminSession } from '@/stores/adminSession';
import { parseOrderSystemFormTemplate } from '../../../common/order-system-form';
import { assistedImageId } from '../../../common/assistedForm';
import type { SystemFormInfo, SystemFormComponent } from '@/types/systemForm';
import { assistedObject as object, assistedInteger as integer, assistedText as text, assistedMoney as money,
  assistedIds, assistedOwner, assistedKey, assistedAddress, assistedOptions,
  type AssistedOwner, type AssistedAddress, type AssistedOptions, type AssistedIntent } from '../../../common/assistedCheckout';

export interface AssistedQuote {
  key: string; token: string; owner: AssistedOwner; cartIds: number[]; options: AssistedOptions;
  items: Array<{ id: number; name: string; sku: string; quantity: number; price: string; productType: number }>;
  address: (AssistedAddress & { id: number }) | null; addressRequired: boolean; formId: number;
  form: SystemFormInfo | null;
  integralEnabled: boolean; points: number; usedPoints: number; remainingPoints: number;
  amounts: Record<'original' | 'products' | 'membership' | 'coupon' | 'firstOrder' | 'points' | 'originalPostage' | 'postageDiscount' | 'postage' | 'payable', string>;
}
export interface AssistedSavedAddress extends AssistedAddress { id: number; isDefault: boolean }
export interface AssistedStore { id: number; name: string; address: string }
export interface AssistedCity { id: number; name: string; parent: number; expandable: boolean }
export interface AssistedCoupon { id: number; title: string; discount: string }
function list(value: unknown, max: number) {
  if (!Array.isArray(value) || value.length > max) throw Error('结算目录响应过大或无效');
  return value;
}
function unique<T extends { id: number }>(items: T[]) {
  if (new Set(items.map(row => row.id)).size !== items.length) throw Error('结算目录包含重复项');
  return items;
}
function own(scope: AssistedOwner) {
  const owner = assistedOwner(scope), session = useAdminSession();
  if (!session.authenticated || !session.canAssist || session.id !== owner.adminId) throw Error('请重新登录原代客管理员');
  return owner;
}
function parseQuote(value: unknown, scope: AssistedOwner, ids: number[], input: AssistedOptions, expectedKey?: string): AssistedQuote {
  const raw = object(value), context = object(raw.checkout), owner = assistedOwner(context), key = assistedKey(raw.orderKey);
  if (JSON.stringify(owner) !== JSON.stringify(assistedOwner(scope)) || context.version !== 1 || context.isNew !== 0
    || JSON.stringify([...assistedIds(context.cartIds)].sort((a,b)=>a-b)) !== JSON.stringify([...ids].sort((a,b)=>a-b))) throw Error('报价不属于当前代客范围');
  if (expectedKey && key !== expectedKey) throw Error('重算改变了原订单标识');
  if (context.shippingType !== input.shipping_type || context.storeId !== input.store_id || context.couponId !== input.couponId
    || context.useIntegral !== input.useIntegral || context.payType !== input.payType || typeof context.addressRequired !== 'boolean') throw Error('报价未采用当前结算选择');
  const address = raw.addressInfo === null ? null : (() => {
    const row = object(raw.addressInfo);
    return { ...assistedAddress({ ...row, realName: row.real_name, cityId: row.city_id }), id: integer(row.id) };
  })();
  const source = address ? (address.id ? 'saved' : 'manual') : 'none';
  if (context.addressSource !== source || (input.manualAddress && context.addressRequired && (!address || address.id !== 0
    || JSON.stringify(assistedAddress(address)) !== JSON.stringify(input.manualAddress)))
    || (input.addressId && context.addressRequired && address?.id !== input.addressId)) throw Error('报价收货地址与选择不符');
  const items = unique(list(raw.cartInfo, 200).map(value => {
    const row = object(value), product = object(row.productInfo), sku = object(product.attrInfo), id = integer(row.id, 1);
    if (!ids.includes(id) || row.uid !== scope.uid || row.staff_id !== scope.adminId
      || row.type !== 0 || row.activity_id !== 0 || row.store_id !== 0 || row.is_new !== 0 || row.is_pay !== 0 || row.is_del !== 0 || row.status !== 1
      || row.product_id !== product.id || sku.product_id !== product.id || sku.unique !== row.product_attr_unique || product.is_presale_product !== 0) throw Error('报价商品范围无效');
    const p = row.truePrice;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 9_999_999_999.99 || Math.abs(p*100-Math.round(p*100)) > .0001) throw Error('报价单价无效');
    return { id, name: text(product.store_name,512), sku: text(sku.suk,512), quantity: integer(row.cart_num,1,32767),
      productType: integer(product.product_type,0,4), price: p.toFixed(2) };
  }));
  if (items.length !== ids.length || !items.length || new Set(items.map(item=>item.productType)).size !== 1) throw Error('报价商品不完整');
  const requiresAddress = input.shipping_type === 1 && ![1,2,3].includes(items[0].productType);
  if (context.addressRequired !== requiresAddress || (!requiresAddress && address)) throw Error('报价配送范围无效');
  integer(raw.integral_ratio_status,0,1);
  const group = object(raw.priceGroup), account = object(raw.userInfo);
  if (account.uid !== scope.uid) throw Error('报价买家无效');
  const formId = integer(context.systemFormId);
  let form: SystemFormInfo | null = null;
  if (formId) {
    const template = object(raw.systemForm);
    if (template.version !== 1 || template.id !== formId) throw Error('报价表单与商品不符');
    form = { id: formId, name: text(template.name, 256),
      value: parseOrderSystemFormTemplate(template.value) as SystemFormComponent[] };
  } else if (raw.systemForm !== null) throw Error('报价表单范围无效');
  return { key, token: assistedKey(raw.quoteToken), owner, cartIds: [...ids], options: structuredOptions(input), items,
    address, addressRequired: requiresAddress, formId, form, integralEnabled: raw.integral_ratio_status === 1,
    points: integer(account.integral), usedPoints: integer(group.usedIntegral), remainingPoints: integer(group.SurplusIntegral),
    amounts: { original: money(group.sumPrice), products: money(group.totalPrice), membership: money(group.vipPrice), coupon: money(group.couponPrice),
      firstOrder: money(group.firstOrderPrice), points: money(group.deduction_price), originalPostage: money(group.total_postage),
      postageDiscount: money(group.storePostageDiscount), postage: money(group.pay_postage), payable: money(group.pay_price) } };
}
function signedImage(value: unknown, id: number) {
  const url = text(value, 512), match = /^\/api\/assets\/([1-9]\d*)\?expires=(\d+)&signature=([A-Za-z0-9_-]{43})$/.exec(url);
  if (!match || Number(match[1]) !== id || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) * 1000 <= Date.now()) throw Error('表单图片预览链接无效或已过期');
  return `${API_BASE}${url}`;
}
/** No shopper token, member media library or caller-supplied ownership metadata. */
export async function apiAssistedFormUpload(scope: AssistedOwner, key: string, filePath: string): Promise<{ url: string; src: string }> {
  own(scope); key = assistedKey(key);
  const session = useAdminSession();
  if (session.expiresAt <= Date.now()) { session.clear(); throw new RequestError('管理员登录已过期，请重新登录', 410001); }
  const version = session.version, token = session.token;
  const current = () => session.version === version && session.token === token;
  try {
    const data = await new Promise<unknown>((resolve, reject) => uni.uploadFile({
      url: `${API_BASE}/api/admin/order/form_image/${key}/${scope.uid}`, filePath, name: 'file',
      header: { Authorization: `Bearer ${token}`, 'Form-type': getFormType() },
      success: response => {
        try {
          if (response.statusCode === 401) throw new RequestError('管理员登录已过期', 410001, undefined, 401);
          if (response.statusCode < 200 || response.statusCode >= 300 || response.data.length > 16000) throw Error('图片上传响应无效');
          const body = object(JSON.parse(response.data));
          if (body.status !== 200) throw new RequestError(typeof body.msg === 'string' ? body.msg : '图片上传失败', typeof body.status === 'number' ? body.status : undefined);
          resolve(body.data);
        } catch (error) { reject(error); }
      }, fail: error => reject(Error(error.errMsg || '图片上传失败')),
    }));
    if (!current()) throw Error('管理员身份已变化，请重新加载');
    const row = object(data), id = integer(row.att_id, 1);
    if (assistedImageId(row.url) !== id) throw Error('表单图片引用不符');
    return { url: `/api/assets/${id}`, src: signedImage(row.src, id) };
  } catch (error) {
    if (!current()) throw Error('管理员身份已变化，请重新加载');
    if (error instanceof RequestError && [410000,410001,410002].includes(error.status ?? 0)) session.clear();
    throw error;
  }
}
export async function apiAssistedFormPreviews(scope: AssistedOwner, key: string, references: string[]): Promise<Record<string, string>> {
  own(scope);
  const ids = [...new Set(references.map(assistedImageId))];
  if (!ids.length || ids.length > 900) throw Error('表单图片列表无效');
  const data = list(await adminRequest('POST', `admin/order/form_preview/${assistedKey(key)}/${scope.uid}`, { ids }, 'order.assisted'), 900);
  if (data.length !== ids.length) throw Error('表单图片预览不完整');
  return Object.fromEntries(data.map((value, index) => {
    const row = object(value), id = integer(row.att_id, 1);
    if (id !== ids[index] || assistedImageId(row.reference) !== id) throw Error('表单图片预览归属不符');
    return [`/api/assets/${id}`, signedImage(row.url, id)];
  }));
}
function structuredOptions(input: AssistedOptions) { return assistedOptions(JSON.parse(JSON.stringify(input))); }
export async function apiAssistedQuote(scope: AssistedOwner, ids: number[], options: AssistedOptions, key?: string): Promise<AssistedQuote | { orderId: string }> {
  own(scope); ids = assistedIds(ids); const input = structuredOptions(options);
  const data = object(await adminRequest('POST', key ? `admin/order/computed/${assistedKey(key)}/${scope.uid}` : `admin/order/confirm/${scope.uid}`,
    { ...input, cartId: ids, new: 0, tourist_uid: scope.touristUid }, 'order.assisted'));
  if (key) {
    const result = object(data.result);
    if (result.orderId !== undefined) {
      const orderId = text(result.orderId,32);
      if (result.key !== key || !/^[A-Za-z0-9_-]+$/.test(orderId)) throw Error('已存在订单结果无效');
      return { orderId };
    }
    return parseQuote(result, scope, ids, input, key);
  }
  return parseQuote(data,scope,ids,input);
}
export async function apiAssistedCreate(intent: AssistedIntent) {
  own(intent);
  const response = object(await adminRequest('POST', `admin/order/create/${assistedKey(intent.key)}/${intent.uid}`,
    { ...intent.payload, tourist_uid: intent.touristUid, new: 0, from: 'h5' }, 'order.assisted'));
  const result = object(response.result), orderId = text(result.order_id,32);
  if (result.key !== intent.key || !/^[A-Za-z0-9_-]+$/.test(orderId) || typeof result.extended !== 'boolean') throw Error('建单结果无法核验，请用原请求重试');
  return { orderId, payPrice: money(result.pay_price) };
}
export async function apiAssistedAddresses(scope: AssistedOwner): Promise<AssistedSavedAddress[]> {
  own(scope); if (!scope.uid) return [];
  return unique(list(await adminRequest('GET',`admin/user/address/list/${scope.uid}`,{},'user.view'),200).map(value=>{
    const row=object(value); if(row.uid!==scope.uid || row.is_del!==0) throw Error('收货地址归属无效');
    return { ...assistedAddress({...row,realName:row.real_name,cityId:row.city_id}),id:integer(row.id,1),isDefault:integer(row.is_default,0,1)===1 };
  }));
}
export async function apiAssistedStores(): Promise<AssistedStore[]> {
  return unique(list(await baseRequest('store/list','GET',{}, {noAuth:true}),200).map(value=>{
    const row=object(value);return {id:integer(row.id,1),name:text(row.name,128),address:text(row.address,512)+' '+text(row.detailed_address,512)};
  }));
}
export async function apiAssistedCities(parent: number): Promise<AssistedCity[]> {
  integer(parent);
  return unique(list(await baseRequest('city','GET',{pid:parent},{noAuth:true}),1000).map(value=>{
    const row=object(value);if(row.pid!==parent || row.id!==row.value)throw Error('地区目录归属错误');
    return {id:integer(row.id,1),name:text(row.label,64),parent,expandable:Array.isArray(row.children)};
  }));
}
export async function apiAssistedCoupons(scope: AssistedOwner, ids: number[], options: AssistedOptions): Promise<AssistedCoupon[]> {
  own(scope); if(!scope.uid)return [];
  const data=await adminRequest('GET',`admin/order/coupons/${scope.uid}`,{cartId:assistedIds(ids).join(','),new:0,
    shipping_type:options.shipping_type,store_id:options.store_id},'order.assisted');
  return unique(list(data,100).map(value=>{const row=object(value);return {id:integer(row.id,1),title:text(row.coupon_title,256),discount:money(row.true_coupon_price)};}));
}
