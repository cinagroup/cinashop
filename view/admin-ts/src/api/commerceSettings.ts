import request, { getData } from "@/utils/request";

export interface BasicCommerceSettings {
  station_open: number;
  site_name: string;
  site_url: string;
  site_phone: string;
  site_logo: string;
  site_logo_square: string;
  login_logo: string;
  wap_login_logo: string;
  navigation_open: number;
  video_func_status: number;
  product_video_status: number;
  product_poster_title: string;
  record_No: string;
}

export interface ProductCommerceSettings {
  store_stock: number;
}

export interface TradeCommerceSettings {
  order_cancel_time: number;
  order_activity_time: number;
  order_bargain_time: number;
  order_seckill_time: number;
  order_pink_time: number;
  rebate_points_orders_time: number;
  reminder_deadline_second_card_time: number;
  system_delivery_time: number;
  system_comment_time: number;
  refund_name: string;
  refund_phone: string;
  refund_address: string;
  stor_reason: string;
  refund_time_available: number;
}

export interface PaymentCommerceSettings {
  balance_func_status: number;
  yue_pay_status: number;
  offline_pay_status: number;
  pay_weixin_open: number;
  ali_pay_status: number;
}

export interface DivisionCommerceSettings {
  division_open: number;
  division_apply_open: number;
}

export type PaymentMethod = "yue" | "weixin" | "alipay" | "offline";

export interface PaymentMethodReadiness {
  enabled: boolean;
  reason: string;
}

export interface CommerceSettings {
  basic: BasicCommerceSettings;
  product: ProductCommerceSettings;
  trade: TradeCommerceSettings;
  payment: PaymentCommerceSettings;
  division: DivisionCommerceSettings;
  payment_readiness: Record<PaymentMethod, PaymentMethodReadiness>;
  missing_config_keys: string[];
}

export type CommerceSettingsPayload = Pick<
  CommerceSettings,
  "basic" | "product" | "trade" | "payment" | "division"
>;

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

let previewSettings: CommerceSettings = {
  basic: {
    station_open: 1,
    site_name: "CinaShop",
    site_url: "https://shop.example.com",
    site_phone: "400-800-8888",
    site_logo: "/uploads/system/logo-wide.png",
    site_logo_square: "/uploads/system/logo-square.png",
    login_logo: "/uploads/system/login-logo.png",
    wap_login_logo: "/uploads/system/mobile-logo.png",
    navigation_open: 1,
    video_func_status: 1,
    product_video_status: 1,
    product_poster_title: "品牌官方 · 交易保障 · 售后无忧",
    record_No: "ICP备案示例",
  },
  product: { store_stock: 20 },
  trade: {
    order_cancel_time: 1,
    order_activity_time: 1,
    order_bargain_time: 1,
    order_seckill_time: 1,
    order_pink_time: 1,
    rebate_points_orders_time: 1,
    reminder_deadline_second_card_time: 24,
    system_delivery_time: 7,
    system_comment_time: 7,
    refund_name: "售后中心",
    refund_phone: "400-800-8888",
    refund_address: "示例市示例区售后仓",
    stor_reason: "收货地址填写错误\n商品与描述不符\n收到商品损坏",
    refund_time_available: 7,
  },
  payment: {
    balance_func_status: 1,
    yue_pay_status: 1,
    offline_pay_status: 2,
    pay_weixin_open: 1,
    ali_pay_status: 0,
  },
  division: { division_open: 1, division_apply_open: 1 },
  payment_readiness: {
    yue: { enabled: true, reason: "" },
    weixin: { enabled: false, reason: "微信支付商户配置未完成" },
    alipay: { enabled: false, reason: "支付宝支付未开启" },
    offline: { enabled: false, reason: "线下支付未开启" },
  },
  missing_config_keys: [],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function previewReadiness(payment: PaymentCommerceSettings): CommerceSettings["payment_readiness"] {
  return {
    yue: {
      enabled: payment.balance_func_status === 1 && payment.yue_pay_status === 1,
      reason: payment.balance_func_status === 1 && payment.yue_pay_status === 1 ? "" : "余额支付未开启",
    },
    weixin: {
      enabled: false,
      reason: payment.pay_weixin_open === 1 ? "微信支付商户配置未完成" : "微信支付未开启",
    },
    alipay: {
      enabled: false,
      reason: payment.ali_pay_status === 1 ? "支付宝商户配置未完成" : "支付宝支付未开启",
    },
    offline: {
      enabled: payment.offline_pay_status === 1,
      reason: payment.offline_pay_status === 1 ? "" : "线下支付未开启",
    },
  };
}

export async function apiCommerceSettings(): Promise<CommerceSettings> {
  if (previewMode) return clone(previewSettings);
  return getData(request.get<CommerceSettings>("/config/commerce"));
}

export async function apiSaveCommerceSettings(payload: CommerceSettingsPayload): Promise<CommerceSettings> {
  if (previewMode) {
    previewSettings = {
      ...clone(previewSettings),
      ...clone(payload),
      payment_readiness: previewReadiness(payload.payment),
      missing_config_keys: [],
    };
    return clone(previewSettings);
  }
  return getData(request.post<CommerceSettings>("/config/commerce", payload));
}
