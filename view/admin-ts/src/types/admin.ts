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
    division_id?: number;
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
  info: StatCard[];
}

export interface StatCard {
  today: string | number;
  yesterday: string | number;
  today_ratio: number;
  total: string | number;
  title: string;
  total_name: string;
  date: string;
}

export type DashboardCycle = "thirtyday" | "week" | "month" | "year";

export interface DashboardOrderSeries {
  name: string;
  type: "bar" | "line";
  data: number[];
  yAxisIndex?: number;
}

export interface DashboardOrderChart {
  yAxis: { maxnum: number; maxprice: number };
  legend: string[];
  xAxis: string[];
  series: DashboardOrderSeries[];
  pre_cycle: {
    count: { data: number };
    price: { data: number };
  };
  cycle: {
    count: { data: number; percent: number; is_plus: -1 | 0 | 1 };
    price: { data: number; percent: number; is_plus: -1 | 0 | 1 };
  };
}

export interface DashboardUserChart {
  legend: string[];
  yAxis: { maxnum: number };
  xAxis: string[];
  series: number[];
  bing_xdata: string[];
  bing_data: Array<{
    name: string;
    value: number;
    itemStyle: { color: string };
  }>;
}

/** Admin 商品 */
export interface AdminProduct {
  id: number;
  product_type: number;
  type: number;
  relation_id: number;
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
  cate_id: string | number[];
  keyword: string;
  unit_name: string;
  sort?: number;
  is_vip?: number;
  vip_price?: string;
}

/** Admin 订单 */
export interface AdminOrder {
  id: number;
  orderId: string;
  uid: number;
  realName: string;
  userPhone: string;
  totalNum: number;
  totalPrice: string;
  payPrice: string;
  payType: string;
  paid: number;
  status: number;
  shippingType: number;
  deliveryType: string;
  addTime: number;
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
