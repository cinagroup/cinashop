/** 订单/购物车类型 */

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
  checked?: boolean;
}

export interface OrderInfo {
  id: number;
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
  refund_status: number;
  cart_info?: OrderCartInfo[];
}

export interface OrderCartInfo {
  id: number;
  oid: number;
  product_id: number;
  cart_num: number;
  cart_info: {
    product: { id: number; storeName: string; image: string };
    sku: { unique: string; suk: string; price: string };
  } | null;
}

export interface CreateOrderResult {
  orderId: string;
  key: string;
}

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
}
