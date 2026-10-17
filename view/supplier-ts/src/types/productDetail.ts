import type { SupplierProductMedia } from '@/utils/productMedia';

export interface SupplierProductDetail {
  version: 'supplier-product-detail-v1';
  actor_id: number;
  supplier_id: number;
  product_id: number;
  bounded: true;
  product: {
    product_type: number; store_name: string; store_info: string; keyword: string;
    unit_name: string; bar_code: string; image: string; slider_image: string[];
    price: string; ot_price: string; vip_price: string; stock: number; sales: number;
    spec_type: number; freight: number; postage: string; temp_id: number;
    is_postage: number; is_support_refund: number; is_limit: number; limit_type: number;
    limit_num: number; is_show: number; is_verify: number; refusal: string;
    sort: number; ficti: number; add_time: number; video_link: string; video_preview_url: string;
  };
  attributes: Array<{ name: string; values: string[] }>;
  skus: Array<{ id: number; suk: string; price: string; ot_price: string; vip_price: string;
    stock: number; sales: number; image: string; bar_code: string; is_retired: 0 }>;
  /** Canonical, sanitized HTML; resolve its original references exactly once. */
  media: SupplierProductMedia;
}

export interface SupplierProductDetailContext { actorId: number; supplierId: number; productId: number }
