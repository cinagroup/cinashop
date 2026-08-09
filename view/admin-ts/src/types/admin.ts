/** Admin 相关类型 (与后端 /adminapi 契约对齐) */

/** 响应信封 */
export interface ApiResponse<T = unknown> {
  status: number;
  msg: string;
  data: T;
}

/** 登录成功响应 (CRMEB 前端格式) */
export interface AdminLoginResult {
  token: string;
  expires_time: number;
  user_info: {
    id: number;
    account: string;
    head_pic: string;
    real_name: string;
    level: number;
    roles: string;
  };
  unique_auth: string[];
  menus: MenuNode[];
  logo: string;
  logo_square: string;
  version: string;
}

/** 菜单节点 (嵌套) */
export interface MenuNode {
  id: number;
  pid: number;
  path: string;
  name: string;
  icon: string;
  sort: number;
  type: number;
  children: MenuNode[];
}

/** Dashboard 统计 */
export interface DashboardData {
  sales: StatCard;
  order: StatCard;
  user: StatCard;
}

export interface StatCard {
  today: string | number;
  yesterday: string | number;
  today_ratio: number;
  total: string | number;
  title: string;
  total_name: string;
}

/** Admin 商品 */
export interface AdminProduct {
  id: number;
  store_name: string;
  store_info: string;
  image: string;
  price: string;
  ot_price: string;
  stock: number;
  sales: number;
  is_show: number;
  is_verify: number;
  is_del: number;
  cate_id: string;
  keyword: string;
  unit_name: string;
  sort?: number;
  is_vip?: number;
  vip_price?: string;
}

/** Admin 订单 */
export interface AdminOrder {
  id: number;
  order_id: string;
  uid: number;
  real_name: string;
  user_phone: string;
  total_num: number;
  total_price: string;
  pay_price: string;
  pay_type: string;
  paid: number;
  status: number;
  add_time: number;
  remark: string;
}

/** Admin 用户 */
export interface AdminUser {
  uid: number;
  account: string;
  nickname: string;
  phone: string;
  avatar: string;
  now_money: string;
  integral: number;
  level: number;
  status: number;
  add_time: number;
  spread_uid: number;
}
