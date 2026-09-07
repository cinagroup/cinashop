import type { GoodsDetail, GoodsSku } from "../types/product";
import { quoteMoney } from "../../../common/checkoutQuote";

function optionalSkuMoney(sku: Record<string, unknown>, snake: string, camel: string): string | null {
  const read = (value: unknown) => value === undefined || value === null || value === "" ? null : quoteMoney(value);
  const a = read(sku[snake]), b = read(sku[camel]);
  if (sku[snake] !== undefined && sku[camel] !== undefined && a !== b) throw new Error("商品规格金额别名不一致");
  return a ?? b;
}

export function normalizeMobileGoods(value: unknown): GoodsDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("商品详情格式错误");
  const raw = value as Record<string, unknown>;
  const field = (snake: string, camel: string = snake) => raw[snake] ?? raw[camel];
  const text = (snake: string, camel: string = snake) => typeof field(snake, camel) === "string" ? field(snake, camel) as string : "";
  const number = (snake: string, camel: string = snake) => typeof field(snake, camel) === "number" && Number.isFinite(field(snake, camel)) ? field(snake, camel) as number : 0;
  if (!Number.isSafeInteger(raw.id) || Number(raw.id) <= 0 || !Number.isSafeInteger(raw.stock) || Number(raw.stock) < 0
    || typeof raw.price !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(raw.price)) throw new Error("商品价格或库存格式错误");
  const source = raw.skus ?? raw.attr_value ?? [];
  if (!Array.isArray(source)) throw new Error("商品规格格式错误");
  const seen = new Set<string>();
  const skus = source.map((value: unknown): GoodsSku => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("商品规格格式错误");
    const sku = value as Record<string, unknown>;
    if (typeof sku.unique !== "string" || !sku.unique.trim() || sku.unique.length > 16 || seen.has(sku.unique)
      || !Number.isSafeInteger(sku.stock) || Number(sku.stock) < 0 || typeof sku.price !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(sku.price)) throw new Error("商品规格价格、库存或标识无效");
    seen.add(sku.unique);
    return { unique: sku.unique, suk: typeof sku.suk === "string" ? sku.suk : "默认规格", stock: Number(sku.stock), price: quoteMoney(sku.price),
      ot_price: optionalSkuMoney(sku, "ot_price", "otPrice"), vip_price: optionalSkuMoney(sku, "vip_price", "vipPrice") };
  });
  const slider = field("slider_image", "sliderImage");
  return { id: Number(raw.id), stock: Number(raw.stock), price: quoteMoney(raw.price), skus,
    store_name: text("store_name", "storeName"), store_info: text("store_info", "storeInfo"), image: text("image"),
    slider_image: Array.isArray(slider) ? slider.filter((image): image is string => typeof image === "string") : [],
    ot_price: text("ot_price", "otPrice"), vip_price: text("vip_price", "vipPrice"), sales: number("sales"), ficti: number("ficti"), fsales: number("fsales"),
    star: text("star"), cart_button: number("cart_button", "cartButton"), is_vip: number("is_vip", "isVip"), is_vip_product: number("is_vip_product", "isVipProduct"),
    unit_name: text("unit_name", "unitName"), min_price: number("min_price"), max_price: number("max_price"), userCollect: raw.userCollect === true || raw.userCollect === 1, uid: number("uid") };
}
