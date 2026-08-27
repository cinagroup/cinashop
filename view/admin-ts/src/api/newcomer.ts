import request, { getData } from "@/utils/request";

export interface NewcomerSku {
  unique: string;
  activity_unique?: string;
  suk: string;
  price: string;
  ot_price: string;
  stock: number;
}

export interface NewcomerProduct {
  id?: number;
  product_id: number;
  store_name: string;
  image: string;
  price: string;
  ot_price: string;
  stock: number;
  attr: NewcomerSku[];
}

export interface NewcomerCoupon {
  id: number;
  title: string;
  coupon_price: string;
  use_min_price: string;
  remain_count: number;
  is_permanent: number;
  status?: number;
}

export interface RegisterConfig {
  store_user_mobile: number;
  routine_auth_type: number[];
  store_user_agreement: number;
  newcomer_status: number;
  newcomer_limit_status: number;
  newcomer_limit_time: number;
  register_integral_status: number;
  register_give_integral: number;
  register_money_status: number;
  register_give_money: string;
  register_coupon_status: number;
  register_give_coupon: NewcomerCoupon[];
  first_order_status: number;
  first_order_discount: string;
  first_order_discount_limit: string;
  register_price_status: number;
  product: NewcomerProduct[];
  newcomer_agreement: string;
  register_notice: string;
  missing_config_keys: string[];
}

export interface NewcomerProductOption {
  id: number;
  store_name: string;
  image: string;
  price: string;
  ot_price: string;
  stock: number;
  spec_type: number;
  attr: NewcomerSku[];
}

export interface RegisterConfigPayload extends Omit<RegisterConfig, "register_notice" | "missing_config_keys" | "register_give_coupon" | "product"> {
  register_give_coupon: number[];
  product: Array<{
    product_id: number;
    attr: Array<{ unique: string; price: string }>;
  }>;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewProducts: NewcomerProductOption[] = [
  {
    id: 101,
    store_name: "轻量通勤双肩包",
    image: "",
    price: "129.00",
    ot_price: "169.00",
    stock: 86,
    spec_type: 1,
    attr: [
      { unique: "DEMO101A", suk: "雾蓝", price: "129.00", ot_price: "169.00", stock: 48 },
      { unique: "DEMO101B", suk: "石墨黑", price: "129.00", ot_price: "169.00", stock: 38 },
    ],
  },
  {
    id: 102,
    store_name: "手冲咖啡体验套装",
    image: "",
    price: "89.00",
    ot_price: "119.00",
    stock: 52,
    spec_type: 0,
    attr: [{ unique: "DEMO102A", suk: "默认", price: "89.00", ot_price: "119.00", stock: 52 }],
  },
];

const previewCoupons: NewcomerCoupon[] = [
  { id: 11, title: "新人满100减15", coupon_price: "15.00", use_min_price: "100.00", remain_count: 300, is_permanent: 0, status: 1 },
  { id: 12, title: "新客无门槛券", coupon_price: "5.00", use_min_price: "0.00", remain_count: 0, is_permanent: 1, status: 1 },
];

let previewConfig: RegisterConfig = {
  store_user_mobile: 0,
  routine_auth_type: [1, 2],
  store_user_agreement: 1,
  newcomer_status: 1,
  newcomer_limit_status: 1,
  newcomer_limit_time: 7,
  register_integral_status: 1,
  register_give_integral: 100,
  register_money_status: 1,
  register_give_money: "5.00",
  register_coupon_status: 1,
  register_give_coupon: [previewCoupons[0]],
  first_order_status: 1,
  first_order_discount: "90",
  first_order_discount_limit: "15.00",
  register_price_status: 1,
  product: [{ ...previewProducts[0], product_id: previewProducts[0].id }],
  newcomer_agreement: "新人礼仅限注册后 7 天内使用，每个账号限享一次。",
  register_notice: "多端账号统一可通过强制手机号登录或绑定微信开放平台实现。",
  missing_config_keys: [],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function apiRegisterConfig(): Promise<RegisterConfig> {
  if (previewMode) return clone(previewConfig);
  return getData(request.get<RegisterConfig>("/config/user/register"));
}

export async function apiSaveRegisterConfig(payload: RegisterConfigPayload): Promise<RegisterConfig> {
  if (previewMode) {
    previewConfig = {
      ...clone(payload),
      product: payload.product.map((selected) => {
        const option = previewProducts.find((product) => product.id === selected.product_id)!;
        const priceByUnique = new Map(selected.attr.map((sku) => [sku.unique, sku.price]));
        return {
          ...clone(option),
          product_id: selected.product_id,
          attr: option.attr
            .filter((sku) => priceByUnique.has(sku.unique))
            .map((sku) => ({ ...sku, price: priceByUnique.get(sku.unique)! })),
        };
      }),
      register_give_coupon: previewCoupons.filter((coupon) => payload.register_give_coupon.includes(coupon.id)),
      register_notice: previewConfig.register_notice,
      missing_config_keys: [],
    };
    return clone(previewConfig);
  }
  return getData(request.post<RegisterConfig>("/config/user/register", payload));
}

export async function apiNewcomerProducts(params: Record<string, unknown> = {}): Promise<{ list: NewcomerProductOption[]; count: number }> {
  if (previewMode) {
    const keyword = String(params.keyword ?? "").trim();
    const list = keyword ? previewProducts.filter((product) => product.store_name.includes(keyword)) : previewProducts;
    return { list: clone(list), count: list.length };
  }
  return getData(request.get<{ list: NewcomerProductOption[]; count: number }>("/config/user/register/products", { params }));
}

export async function apiNewcomerCoupons(params: Record<string, unknown> = {}): Promise<{ list: NewcomerCoupon[]; count: number }> {
  if (previewMode) return { list: clone(previewCoupons), count: previewCoupons.length };
  return getData(request.get<{ list: NewcomerCoupon[]; count: number }>("/config/user/register/coupons", { params }));
}
