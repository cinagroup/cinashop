/** Transport-neutral cart snapshot used by both storefront checkout clients. */
export interface CheckoutCartItem {
  id: number;
  productId: number;
  cartNum: number;
  type: number;
  unique: string;
  isNew: number;
  isValid: boolean;
  productInfo: {
    storeName: string;
    image: string;
    price: string;
    stock: number;
    otPrice: string;
    suk: string;
    systemFormId: number;
    productType: number;
    integral?: number;
  } | null;
  sumPrice: string;
  checked?: boolean;
}

export type CheckoutSelection = { mode: "cart" } | { mode: "buy"; ids: number[] };
export function parseCheckoutSelection(query: Record<string, unknown>): CheckoutSelection {
  const raw = query.cartIds ?? query.cartId;
  if (query.mode === undefined && raw === undefined) return { mode: "cart" };
  if (query.mode !== "buy" || typeof raw !== "string" || raw.length > 1600 || !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
    throw new Error("立即购买商品参数无效，请返回商品页重新选择");
  }
  if (query.cartIds !== undefined && query.cartId !== undefined) throw new Error("立即购买参数重复");
  const ids = raw.split(",").map(Number);
  if (ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) {
    throw new Error("立即购买商品参数无效");
  }
  return { mode: "buy", ids };
}

/** Exact selection: never silently discard invalid rows or fall back to the ordinary cart. */
export function validateCheckoutItems(value: unknown, ids: readonly number[], isNew: 0 | 1): CheckoutCartItem[] {
  if (!ids.length || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || new Set(ids).size !== ids.length || !Array.isArray(value) || value.length !== ids.length) throw new Error("结算商品不完整");
  const seen = new Set<number>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("结算商品无效");
    const row = raw as CheckoutCartItem;
    if (!ids.includes(row.id) || seen.has(row.id) || row.isNew !== isNew || row.isValid !== true
      || !Number.isSafeInteger(row.productId) || row.productId <= 0 || !Number.isSafeInteger(row.cartNum) || row.cartNum <= 0
      || !Number.isSafeInteger(row.type) || row.type < 0 || typeof row.unique !== "string" || !row.unique.trim()
      || !row.productInfo || typeof row.productInfo !== "object" || Array.isArray(row.productInfo)
      || !Number.isSafeInteger(row.productInfo.systemFormId) || row.productInfo.systemFormId < 0
      || !Number.isSafeInteger(row.productInfo.productType) || row.productInfo.productType < 0) throw new Error("结算商品或购买模式已失效");
    seen.add(row.id);
    return { ...row, productInfo: { ...row.productInfo } };
  });
}
