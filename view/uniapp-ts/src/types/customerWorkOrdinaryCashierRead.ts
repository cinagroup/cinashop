import type { SystemFormInfo } from './systemForm';
export interface OrdinaryReadiness { writes: boolean; reason: string }
export interface OrdinaryCatalogProduct { id: number; store_name: string; image: string; product_type: 0; system_form_id: number }
export interface OrdinaryCatalogRow extends OrdinaryCatalogProduct { sku_count: number }
export interface OrdinaryCatalogList { list: OrdinaryCatalogRow[]; page: number; limit: number; has_more: boolean; readiness: OrdinaryReadiness }
export interface OrdinaryCatalogSku { sku_unique: string; sku: string; image: string; price: string; stock: number }
export interface OrdinaryCatalogSelection { product: OrdinaryCatalogProduct; skus: OrdinaryCatalogSku[]; system_form: SystemFormInfo | null; readiness: OrdinaryReadiness }
export interface OrdinaryBuyer { uid: number; nickname: string; phone: string; integral: number; now_money: string }
export interface OrdinaryBuyerList { list: OrdinaryBuyer[]; page: number; limit: number; has_more: boolean }
export interface OrdinaryBuyerAddress { id: number; real_name: string; phone: string; province: string; city: string; district: string;
  street: string; detail: string; city_id: number; is_default: boolean }
export interface OrdinaryAddressList { buyer_uid: number; list: OrdinaryBuyerAddress[] }
export interface OrdinaryCoupon { id: number; cid: number; title: string; discount_type: 1 | 2; scope_type: 0 | 1 | 2 | 3;
  coupon_price: string; use_min_price: string; start_time: string | null; end_time: string | null; availability: string;
  availability_message: string; rule: string; rule_truncated: boolean; estimated_discount: string; eligible_subtotal: string }
export interface OrdinaryCouponPage { list: OrdinaryCoupon[]; next_cursor: number | null }
export interface OrdinaryPricing {
  currency: 'CNY'; amount: string; total: string; raw_total: string; quantity: number; postage: string; raw_postage: string;
  coupon_discount: string; integral_discount: string; first_order_discount: string; membership_discount: string; promotion_discount: string;
  used_integral: number; remaining_integral: number; integral_policy: { enabled: boolean; ratio: number };
  gives_integral: number; product_gives_integral: number; promotion_gives_integral: number;
}
export interface OrdinaryPromotionGifts { integral: number; coupons: { issue_id: number; title: string; price: string; min_price: string }[];
  products: { cart_id: string; product_id: number; sku_unique: string; quantity: number; promotion_id: number }[];
  promotions: { id: number; tier_id: number; name: string; threshold: string; threshold_type: 1 | 2; repetitions: number }[] }
export interface OrdinaryQuoteData { request_key: string; request_hash: string; draft_key: string; draft_hash: string; quote_token: string;
  quote_fingerprint: string; expires_at: number; pricing: OrdinaryPricing;
  items: { cart_id: number; raw_unit_price: string; unit_price: string; total_price: string; discount: string; price_type: string }[];
  system_form: SystemFormInfo | null; coupons: OrdinaryCouponPage; promotion_gifts: OrdinaryPromotionGifts }
export interface OrdinaryCouponRead { request_key: string; quote_token: string; coupons: OrdinaryCouponPage }
