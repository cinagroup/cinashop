/**
 * 商品相关类型
 * 与后端 src/models/schema/product.ts 对齐
 */

/** 商品列表项 (对应后端 getGoodsList 的返回) */
export interface GoodsItem {
  id: number;
  relation_id: number;
  type: number;
  pid: number;
  delivery_type: string;
  product_type: number;
  store_name: string;
  cate_id: string;
  image: string;
  /** 展示销量 = 真实 + 虚拟 */
  sales: number;
  price: string;
  stock: number;
  activity: string;
  ot_price: string;
  spec_type: number;
  recommend_image: string;
  unit_name: string;
  is_vip: number;
  vip_price: string;
  is_presale_product: number;
  is_vip_product: number;
  system_form_id: number;
  presale_start_time: number;
  presale_end_time: number;
  is_limit: number;
  limit_num: number;
  video_open: number;
  video_link: string;
  freight: number;
  star: string;
  store_label_id: string;
  brand_id: number;
  /** 后处理字段 */
  price_type: string;
  level_name: string;
  cart_button: number;
}

/** 商品详情 */
export interface GoodsDetail {
  id: number;
  store_name: string;
  store_info: string;
  image: string;
  slider_image: string[];
  price: string;
  ot_price: string;
  vip_price: string;
  stock: number;
  sales: number;
  ficti: number;
  fsales: number;
  star: string;
  cart_button: number;
  video_link: string;
  delivery_type: string[];
  spec_type: number;
  is_vip: number;
  is_vip_product: number;
  is_presale_product: number;
  is_show: number;
  is_del: number;
  unit_name: string;
  keyword: string;
  cate_id: string;
  min_price: number;
  max_price: number;
  price_type: string;
  level_name: string;
  userCollect: boolean;
  userLike: number;
  uid: number;
}

/** 分页列表结果 */
export interface PageResult<T> {
  list: T[];
  count: number | null;
}

/** 商品分类节点 */
export interface CategoryNode {
  id: number;
  pid: number;
  cate_name: string;
  pic: string;
  big_pic: string;
  children: CategoryNode[];
}
