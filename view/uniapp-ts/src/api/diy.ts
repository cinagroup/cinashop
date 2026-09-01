/**
 * Legacy DIY-home compatibility client.
 *
 * The response field names intentionally stay in the PHP snake_case shape.
 * Component payloads are editor-owned JSON and are narrowed by the renderer
 * allowlist before any field is consumed.
 */
import { http } from "@/utils/request";

export const DIY_COMPONENT_NAMES = [
  "homeComb",
  "headerSerch",
  "userInfor",
  "newVip",
  "articleList",
  "bargain",
  "blankPage",
  "combination",
  "coupon",
  "customerService",
  "goodList",
  "guide",
  "liveBroadcast",
  "menus",
  "news",
  "pictureCube",
  "promotionList",
  "richText",
  "seckill",
  "swiperBg",
  "swipers",
  "tabNav",
  "titles",
  "ranking",
  "presale",
  "pointsMall",
  "videos",
  "signIn",
  "hotspot",
  "follow",
  "community",
  "activeParty",
  "pageFoot",
] as const;

export type DiyComponentName = (typeof DIY_COMPONENT_NAMES)[number];

export interface DiyComponent {
  name: DiyComponentName;
  timestamp?: number | string;
  isHide?: number | string | boolean;
  [key: string]: unknown;
}

export interface DiyPage {
  title: string;
  value: DiyComponent[];
  is_show: number | string | boolean;
  is_bg_color: number | string | boolean;
  color_picker: string;
  bg_pic: string;
  bg_tab_val: number | string;
  is_bg_pic: number | string | boolean;
  order_status: number | string;
}

export interface DiyVersion {
  version: string | null;
}

export interface DiyUserInfo {
  uid: number;
  nickname: string;
  phone: string;
  avatar: string;
  level: number;
  integral: number;
  now_money: string | number;
  exp: number;
  is_money_level: number;
  bar_code: string;
  coupon_num: number;
  vip_name: string;
  next_exp: number;
  collectCount: number;
  visit_num: number;
}

export interface DiyProduct {
  id: number;
  product_id?: number;
  store_name: string;
  image: string;
  price: string | number;
  ot_price?: string | number;
  vip_price?: string | number;
  sales?: number;
  star?: string | number;
  stock?: number;
  [key: string]: unknown;
}

export interface DiyVideoItem {
  id: number;
  image: string;
  desc: string;
  video_url: string;
  product_info?: DiyProduct[];
  [key: string]: unknown;
}

export interface DiyNewcomerCoupon {
  id: number;
  coupon_price?: string | number;
  use_min_price?: string | number;
  coupon_type?: number;
  [key: string]: unknown;
}

export interface DiyNewcomerData {
  newcomer_products: DiyProduct[];
  newcomer_integral: number | unknown[];
  newcomer_coupon: DiyNewcomerCoupon[];
}

export interface DiyProductRanks {
  sales: DiyProduct[];
  star: DiyProduct[];
  collect: DiyProduct[];
}

export interface DiySignDay {
  day: string;
  is_sign: boolean;
  sign_day: boolean;
  type: number;
  point: number;
}

export interface DiySignReward {
  id?: number;
  days: number;
  point: number;
  exp?: number;
}

export interface DiySignData {
  signList: DiySignDay[][];
  nextContinuousSignRewardList: DiySignReward[];
  checkSign: boolean;
  signStatus: boolean | number;
  sign_give_point: number;
}

export interface DiySuspendedButton {
  img: string;
  url: string;
}

export interface DiySuspendedConfig {
  is_show: number | string | boolean;
  index: number | string;
  shifting: number | string;
  main_ago_image: string;
  main_after_image: string;
  button: DiySuspendedButton[];
}

function safeDiyId(id: number): number {
  return Number.isSafeInteger(id) && id >= 0 ? id : 0;
}

export function apiDiyPage(id = 0): Promise<DiyPage | []> {
  return http.get<DiyPage | []>(`diy/get_diy/${safeDiyId(id)}`, {}, { noAuth: true });
}

export function apiDiyVersion(id = 0): Promise<DiyVersion> {
  return http.get<DiyVersion>(`diy/diy_version/${safeDiyId(id)}`, {}, { noAuth: true });
}

/** Optional auth: anonymous callers receive PHP's empty-array shape. */
export function apiDiyUserInfo(): Promise<DiyUserInfo | []> {
  return http.get<DiyUserInfo | []>("diy/user_info");
}

export function apiDiyVideoList(page = 1, limit = 10): Promise<DiyVideoItem[]> {
  return http.get<DiyVideoItem[]>("diy/video_list", { page, limit });
}

export function apiDiyNewcomerList(page = 1, limit = 10): Promise<DiyNewcomerData> {
  return http.get<DiyNewcomerData>("diy/newcomer_list", { page, limit });
}

export function apiDiyProductRank(limit = 3): Promise<DiyProductRanks> {
  return http.get<DiyProductRanks>("diy/product_rank", { limit });
}

export function apiDiySign(): Promise<DiySignData> {
  return http.get<DiySignData>("diy/sign");
}

export function apiDiySuspended(): Promise<DiySuspendedConfig> {
  return http.get<DiySuspendedConfig>("diy/get_suspended");
}
