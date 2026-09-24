import { adminRequest } from './adminRequest';
import { useAdminSession } from '@/stores/adminSession';

export const ASSISTED_SELECTION_PAGE_SIZE = 20;
export interface AssistedBuyer { uid: number; name: string; phone: string; avatar: string; balance: string; points: number; active: boolean }
export interface AssistedProduct { id: number; name: string; image: string; price: string; stock: number; presale: boolean }
export interface AssistedSku { id: number; productId: number; unique: string; label: string; image: string; price: string; stock: number }
export interface AssistedCartScope { adminId: number; uid: number; touristUid: string }
export interface AssistedCartRow { id: number; productId: number; productType: number; unique: string; name: string; sku: string; image: string; quantity: number; stock: number; price: string; valid: boolean }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('代客接口响应格式错误');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0, max = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw Error('代客接口数值无效');
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw Error('代客接口文字无效');
  return value;
}
function money(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw Error('代客接口金额无效');
  return value;
}
function image(value: unknown): string {
  const url = text(value, 2048);
  if (/[\u0000-\u0020\\]/.test(url)) return '';
  if (/^\/(?!\/)/.test(url)) return url;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? url : ''; } catch { return ''; }
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw Error('代客列表过大或格式错误');
  return value;
}
function unique<T>(rows: T[], key: (row: T) => unknown): T[] {
  if (new Set(rows.map(key)).size !== rows.length) throw Error('列表存在重复项，请刷新');
  return rows;
}
function pageInput(page: number, keyword: string) {
  integer(page, 1, 10_000); text(keyword, 100);
  if (/[\u0000-\u001f\u007f]/.test(keyword)) throw Error('搜索条件无效');
}
export async function apiAssistedBuyers(page: number, keyword: string): Promise<AssistedBuyer[]> {
  pageInput(page, keyword);
  const result = object(await adminRequest('GET', 'admin/user/list', { page, limit: ASSISTED_SELECTION_PAGE_SIZE, nickname: keyword }, 'user.view'));
  if (result.page !== page || result.limit !== ASSISTED_SELECTION_PAGE_SIZE) throw Error('用户列表页码无效');
  return unique(list(result.list, ASSISTED_SELECTION_PAGE_SIZE).map(value => {
    const row = object(value); integer(row.status, 0, 1);
    return { uid: integer(row.uid, 1), name: text(row.nickname, 120), phone: text(row.phone, 30), avatar: image(row.avatar),
      balance: money(row.now_money), points: integer(row.integral), active: row.status === 1 };
  }), row => row.uid);
}
export async function apiAssistedProducts(page: number, keyword: string): Promise<AssistedProduct[]> {
  pageInput(page, keyword);
  const result = object(await adminRequest('GET', 'admin/product/list', { page, limit: ASSISTED_SELECTION_PAGE_SIZE, store_name: keyword, status: 1 }, 'product.view'));
  if (result.page !== page || result.limit !== ASSISTED_SELECTION_PAGE_SIZE) throw Error('商品列表页码无效');
  return unique(list(result.list, ASSISTED_SELECTION_PAGE_SIZE).map(value => {
    const row = object(value); integer(row.is_presale_product, 0, 1);
    return { id: integer(row.id, 1), name: text(row.store_name, 512), image: image(row.image),
      price: money(row.price), stock: integer(row.stock), presale: row.is_presale_product === 1 };
  }), row => row.id);
}
export async function apiAssistedSkus(productId: number): Promise<AssistedSku[]> {
  integer(productId, 1);
  const result = await adminRequest('GET', `admin/product/get_attr/${productId}`, {}, 'product.view');
  return unique(list(result, 500).map(value => {
    const row = object(value), key = text(row.unique, 16);
    if (row.product_id !== productId || !/^[A-Za-z0-9_-]{1,16}$/.test(key)) throw Error('规格归属或标识无效');
    return { id: integer(row.id, 1), productId, unique: key, label: text(row.suk, 512), image: image(row.image), price: money(row.price), stock: integer(row.stock) };
  }), row => row.unique);
}
function scopeInput(scope: AssistedCartScope) {
  integer(scope.adminId, 1); integer(scope.uid);
  const session = useAdminSession();
  if (!session.authenticated || session.id !== scope.adminId) throw Error('代客管理员身份已变化');
  if (scope.uid === 0 ? !/^[A-Za-z0-9_-]{1,50}$/.test(scope.touristUid) : scope.touristUid !== '') throw Error('代客买家上下文无效');
  // adminId is a response assertion only. Never send a caller-selected actor.
  return { tourist_uid: scope.touristUid, new: 0 };
}
export async function apiAssistedCart(scope: AssistedCartScope): Promise<AssistedCartRow[]> {
  const input = scopeInput(scope);
  const result = await adminRequest('GET', `admin/order/cart/${scope.uid}`, input, 'order.assisted');
  return unique(list(result, 200).map(value => {
    const row = object(value), product = object(row.productInfo), sku = object(product.attrInfo);
    const productId = integer(row.product_id, 1), key = text(row.product_attr_unique, 16);
    if (row.uid !== scope.uid || row.staff_id !== scope.adminId || row.type !== 0 || row.activity_id !== 0 || row.store_id !== 0
      || row.is_new !== 0 || row.is_del !== 0 || row.is_pay !== 0 || row.status !== 1 || product.id !== productId
      || sku.product_id !== productId || sku.unique !== key || !/^[A-Za-z0-9_-]{1,16}$/.test(key)) throw Error('购物车不属于当前代客范围');
    const rawPrice = row.truePrice;
    if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice < 0 || rawPrice > 9_999_999_999.99
      || Math.abs(rawPrice * 100 - Math.round(rawPrice * 100)) > 0.0001) throw Error('购物车价格无效');
    integer(row.is_valid, 0, 1); integer(product.is_presale_product, 0, 1);
    const quantity = integer(row.cart_num, 1, 32767), stock = integer(row.trueStock);
    return { id: integer(row.id, 1), productId, productType: integer(product.product_type, 0, 4), unique: key, name: text(product.store_name, 512), sku: text(sku.suk, 512),
      image: image(sku.image || product.image), quantity, stock, price: rawPrice.toFixed(2),
      valid: row.is_valid === 1 && product.is_presale_product === 0 && quantity <= stock };
  }), row => row.id);
}
export async function apiAssistedCartAdd(scope: AssistedCartScope, sku: AssistedSku, quantity: number): Promise<number> {
  const input = scopeInput(scope); integer(quantity, 1, 32767); integer(sku.productId, 1);
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(sku.unique)) throw Error('规格标识无效');
  const result = object(await adminRequest('POST', `admin/order/cart/add/${scope.uid}`, { ...input,
    productId: sku.productId, uniqueId: sku.unique, cartNum: quantity }, 'order.assisted'));
  return integer(result.cartId, 1);
}
export async function apiAssistedCartQuantity(scope: AssistedCartScope, id: number, quantity: number): Promise<void> {
  const input = scopeInput(scope); integer(id, 1); integer(quantity, 1, 32767);
  await adminRequest('POST', `admin/order/cart/num/${scope.uid}`, { ...input, id, number: quantity }, 'order.assisted');
}
export async function apiAssistedCartDelete(scope: AssistedCartScope, id: number): Promise<void> {
  const input = scopeInput(scope); integer(id, 1);
  await adminRequest('DELETE', `admin/order/cart/del/${scope.uid}`, { ...input, ids: [id] }, 'order.assisted');
}
