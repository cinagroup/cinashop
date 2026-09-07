import type { GoodsDetail } from "../types/product";
import { normalizeGoodsSkus } from "./productPurchase";

/** The detail endpoint uses ORM camelCase plus computed snake_case fields;
 * older clients/responses use snake_case. Keep that wire format out of views. */
export function normalizeGoodsDetail(value: unknown): GoodsDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("商品详情数据格式错误");
  }
  const source = value as Record<string, unknown>;
  // An explicit legacy value (including 0, false, [] and "") wins.
  const field = (snake: string, camel = snake) => source[snake] ?? source[camel];
  const text = (snake: string, camel = snake) => {
    const result = field(snake, camel);
    return typeof result === "string" ? result : "";
  };
  const integer = (snake: string, camel = snake, fallback = 0) => {
    const result = field(snake, camel);
    return typeof result === "number" && Number.isSafeInteger(result) && result >= 0
      ? result : fallback;
  };
  const strings = (snake: string, camel: string) => {
    const result = field(snake, camel);
    return Array.isArray(result) ? result.filter((item): item is string => typeof item === "string") : [];
  };
  const id = integer("id");
  const stock = integer("stock", "stock", -1);
  const price = text("price");
  if (id < 1 || stock < 0 || !/^\d+(?:\.\d+)?$/.test(price) || !Number.isFinite(Number(price))) {
    throw new Error("商品价格或库存数据格式错误");
  }
  const productType = integer("product_type", "productType", -1);
  const presale = integer("is_presale_product", "isPresaleProduct", -1);
  const systemForm = integer("system_form_id", "systemFormId", -1);
  const explicitCart = Object.hasOwn(source, "cart_button") ? source.cart_button : source.cartButton;
  const restricted = productType > 0 || presale > 0 || systemForm > 0;
  const inferredCart = productType === 0 && presale === 0 && systemForm === 0;
  const cartAllowed = explicitCart === undefined ? inferredCart : explicitCart === 1;
  const isShow = integer("is_show", "isShow");
  const isDel = integer("is_del", "isDel", 1);
  return {
    id,
    store_name: text("store_name", "storeName"),
    store_info: text("store_info", "storeInfo"),
    image: text("image"),
    slider_image: strings("slider_image", "sliderImage"),
    skus: normalizeGoodsSkus(source.skus ?? source.attr_value),
    price, // Preserve decimal strings; this adapter does not recalculate prices.
    ot_price: text("ot_price", "otPrice"),
    vip_price: text("vip_price", "vipPrice"),
    stock,
    sales: integer("sales"),
    ficti: integer("ficti"),
    fsales: integer("fsales"),
    star: text("star"),
    cart_button: cartAllowed && !restricted && stock > 0 && isShow === 1 && isDel === 0 ? 1 : 0,
    video_link: text("video_link", "videoLink"),
    delivery_type: strings("delivery_type", "deliveryType"),
    spec_type: integer("spec_type", "specType"),
    is_vip: integer("is_vip", "isVip"),
    is_vip_product: integer("is_vip_product", "isVipProduct"),
    is_presale_product: Math.max(0, presale),
    is_show: isShow,
    is_del: isDel,
    unit_name: text("unit_name", "unitName"),
    keyword: text("keyword"),
    cate_id: text("cate_id", "cateId"),
    min_price: typeof source.min_price === "number" ? source.min_price : 0,
    max_price: typeof source.max_price === "number" ? source.max_price : 0,
    price_type: text("price_type"),
    level_name: text("level_name"),
    userCollect: field("userCollect") === true || field("userCollect") === 1,
    userLike: integer("userLike"),
    uid: integer("uid"),
  };
}
