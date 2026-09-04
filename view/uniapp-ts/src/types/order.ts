/** 订单/购物车类型 */
import type { SystemFormComponent } from "@/types/systemForm";

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
    integral: number;
    stock: number;
    otPrice: string;
    suk: string;
    systemFormId: number;
    productType: number;
  } | null;
  sumPrice: string;
  checked?: boolean;
}

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

export interface DiscountPackageSku {
  id: number;
  unique: string;
  suk: string;
  price: string;
  stock: number;
  image?: string;
  product_price: string;
}

export interface DiscountPackageProduct {
  id: number;
  product_id: number;
  title: string;
  image: string;
  type: number;
  productValue: DiscountPackageSku[];
}

export interface DiscountPackage {
  id: number;
  title: string;
  image: string;
  type: number;
  freeShipping: number;
  isSupportRefund: number;
  min_price: string;
  max_discounts_price: string;
  products: DiscountPackageProduct[];
}

export interface FirstOrderQuote {
  eligible: boolean;
  couponExclusive: boolean;
  subtotal: string;
  firstOrderPrice: string;
  payPercent: number;
  discountLimit: string;
}

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

export interface OrderCartInfo {
  id: number;
  oid: number;
  product_id: number;
  product_type: number;
  unique: string;
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

export interface UserAddress {
  id: number;
  uid: number;
  real_name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  city_id: number;
  detail: string;
  is_default: number;
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
