import type { GoodsDetail, GoodsSku } from "../types/product";

export function normalizeGoodsSkus(value: unknown): GoodsSku[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("商品规格数据格式错误");
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("商品规格数据格式错误");
    const row = entry as Record<string, unknown>;
    const { unique, stock, price } = row;
    if (typeof unique !== "string" || !unique.trim() || unique !== unique.trim() || unique.length > 16 ||
      seen.has(unique) || typeof stock !== "number" || !Number.isSafeInteger(stock) || stock < 0 ||
      typeof price !== "string" || !/^\d+(?:\.\d+)?$/.test(price) || !Number.isFinite(Number(price))) {
      throw new Error("商品规格价格、库存或标识无效");
    }
    seen.add(unique);
    const money = (value: unknown) => typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
      && Number.isFinite(Number(value)) ? value : "";
    return { unique, stock, price, suk: typeof row.suk === "string" ? row.suk : "默认规格",
      ot_price: money(row.ot_price ?? row.otPrice), vip_price: money(row.vip_price ?? row.vipPrice),
      image: typeof row.image === "string" ? row.image : "" };
  });
}

export function productCartInput(detail: GoodsDetail, unique: string, quantity: number, direct: boolean) {
  const sku = detail.skus.find((item) => item.unique === unique);
  if (detail.cart_button !== 1 || !sku || sku.stock <= 0) throw new Error("请选择可购买的商品规格");
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > Math.min(sku.stock, detail.stock, 32767)) {
    throw new Error("购买数量超过所选规格库存或无效");
  }
  return { productId: detail.id, unique: sku.unique, cartNum: quantity, new: direct ? 1 as const : 0 as const };
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
