/** 商品类型 (与后端对齐) */

export interface GoodsItem {
  id: number;
  store_name: string;
  image: string;
  price: string;
  ot_price: string;
  vip_price: string;
  sales: number;
  stock: number;
  is_vip: number;
  is_vip_product: number;
  cart_button: number;
  unit_name: string;
  star: string;
}

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
  is_vip: number;
  is_vip_product: number;
  unit_name: string;
  min_price: number;
  max_price: number;
  userCollect: boolean;
  uid: number;
}

export interface CategoryNode {
  id: number;
  pid: number;
  cate_name: string;
  pic: string;
  children: CategoryNode[];
}
