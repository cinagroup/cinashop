/**
 * 订单/购物车相关类型
 * 与后端 schema 对齐
 */

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
  } | null;
  sumPrice: string;
  /** 前端选中状态 */
  checked?: boolean;
}

/** 订单 */
export interface OrderInfo {
  id: number;
  type: number;
  order_id: string;
  uid: number;
  total_num: number;
  total_price: string;
  pay_price: string;
  pay_type: string;
  paid: number;
  status: number;
  shipping_type: number;
  add_time: number;
  pay_time: number;
  real_name: string;
  user_phone: string;
  province: string;
  user_address: string;
  mark: string;
  refund_status: number;
  cart_info?: OrderCartInfo[];
}

/** 订单商品快照 */
export interface OrderCartInfo {
  id: number;
  oid: number;
  product_id: number;
  product_type: number;
  sku_unique: string;
  cart_num: number;
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
