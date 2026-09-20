/** An acknowledged direct cart, not an order/payment or an unconfirmed write. */
export interface PreparedProductCart { readonly ids: readonly number[]; readonly type: 0 | 5 }

export function prepareProductCart(value: unknown, type: 0 | 5, count = 1): PreparedProductCart {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('购买记录响应无效，请重新加载商品');
  const row = value as Record<string, unknown>;
  const ids = type === 5 ? row.cartIds : [row.id];
  if (!Number.isSafeInteger(count) || count < (type === 5 ? 2 : 1) || count > 100
    || !Array.isArray(ids) || ids.length !== count || ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
    || new Set(ids).size !== ids.length) throw Error('购买记录不完整或标识无效，请重新加载商品');
  if (row.cartId !== undefined && (type === 0 ? row.cartId !== ids[0]
    : !Array.isArray(row.cartId) || row.cartId.length !== ids.length || row.cartId.some((id, i) => id !== ids[i]))) {
    throw Error('购买记录标识不一致，请重新加载商品');
  }
  return Object.freeze({ ids: Object.freeze([...ids]), type });
}
