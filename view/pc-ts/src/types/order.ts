/**
 * 订单/购物车相关类型
 * 与后端 schema 对齐
 */
import type { SystemFormComponent } from "@/types/systemForm";

/** 购物车项 */
export interface CartItem {
  id: number;
  productId: number;
  cartNum: number;
  type: number;
  unique: string;
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
  } | null;
  sumPrice: string;
  /** 前端选中状态 */
  checked?: boolean;
}

/** 订单 */
export interface OrderInfo {
  id: number;
  type: number;
  pid: number;
  order_id: string;
  supplier_id: number;
  supplier_allocation_status: number;
  uid: number;
  total_num: number;
  total_price: string;
  pay_price: string;
  pay_type: string;
  paid: number;
  status: number;
  product_type: number;
  shipping_type: number;
  store_id: number;
  verify_code: string;
  delivery_type: string;
  fictitious_content: string;
  delivery_uid: number;
  virtual_info?: VirtualDeliveryItem[] | string | null;
  add_time: number;
  pay_time: number;
  real_name: string;
  user_phone: string;
  province: string;
  user_address: string;
  mark: string;
  refund_status: number;
  pink_status?: number | null;
  pink_info?: {
    id: number;
    people: number;
    member_count: number;
    stop_time: string | null;
  } | null;
  cart_info?: OrderCartInfo[];
  split_orders?: OrderPackage[];
  custom_form?: SystemFormComponent[];
  pickup_store?: Pick<
    PickupStore,
    "id" | "name" | "phone" | "address" | "detailed_address" | "image" | "latitude" | "longitude" | "valid_time" | "day_time"
  > | null;
}

export interface FirstOrderQuote {
  eligible: boolean;
  couponExclusive: boolean;
  subtotal: string;
  firstOrderPrice: string;
  payPercent: number;
  discountLimit: string;
}

/** 支付后按经营主体拆出的履约包裹。 */
export interface OrderPackage {
  id: number;
  pid: number;
  order_id: string;
  supplier_id: number;
  total_num: number;
  pay_price: string;
  paid: number;
  status: number;
  product_type: number;
  fictitious_content: string;
  virtual_info?: VirtualDeliveryItem[] | string | null;
  cart_info: OrderCartInfo[];
}

export interface VirtualDeliveryItem {
  card_no?: string;
  card_pwd?: string;
  disk_info?: string;
  product_id?: number;
  sku_unique?: string;
  quantity?: number;
}

/** 订单商品快照 */
export interface OrderCartInfo {
  id: number;
  oid: number;
  product_id: number;
  unique: string;
  product_type: number;
  sku_unique: string;
  cart_num: number;
  write_times: number;
  write_surplus_times: number;
  write_start: number;
  write_end: number;
  is_writeoff: number;
  cart_info: {
    product: { id: number; storeName: string; image: string };
    sku: { unique: string; suk: string; price: string };
  } | null;
}

/** 创建订单响应 */
export interface CreateOrderResult {
  orderId: string;
  key: string;
}

export type CheckoutPaymentMethod = "yue" | "weixin" | "alipay" | "offline";

export interface PaymentMethodReadiness {
  enabled: boolean;
  reason: string;
}

export type PaymentReadiness = Record<CheckoutPaymentMethod, PaymentMethodReadiness>;

export interface CheckoutCashier {
  type: "order" | "vip" | "recharge";
  order_id: string;
  pay_price: string;
  pay_postage: string;
  pay_integral: number;
  now_money: string;
  integral: number;
  invalid_time: number;
  paid: boolean;
  payable: boolean;
  payable_reason: string;
  zero_pay: boolean;
  methods: PaymentReadiness;
}

export interface CheckoutPaymentResult {
  order_id: string;
  paid: boolean;
  pay_type: CheckoutPaymentMethod;
  pay_mode?: "jsapi" | "native" | "h5" | "app";
  payUrl?: string;
  jsConfig?: Record<string, unknown>;
  offline?: boolean;
}

/** 地址 */
export interface UserAddress {
  id: number;
  uid: number;
  real_name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  is_default: number;
  add_time: number;
}

export interface PickupStore {
  id: number;
  name: string;
  introduction: string;
  phone: string;
  address: string;
  detailed_address: string;
  image: string;
  latitude: string;
  longitude: string;
  valid_time: string;
  day_time: string;
}
