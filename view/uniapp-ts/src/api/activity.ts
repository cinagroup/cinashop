/**
 * 营销活动 API（PHP UniApp 兼容字段）。
 */
import { http } from "@/utils/request";
import type { PageResult } from "@/types/api";
import type { GoodsItem } from "@/types/product";

export interface ActivityPageParams {
  page?: number;
  limit?: number;
}

export interface SeckillTimeItem {
  id: number;
  title: string | null;
  pic: string;
  describe: string;
  start_time: string;
  end_time: string;
  status: 0 | 1 | 2;
  state: string;
  time: string;
  stop: number;
  add_time: number;
}

export interface SeckillIndexData {
  lovely: string;
  seckillTime: SeckillTimeItem[];
  seckillTimeIndex: number;
}

export interface SeckillListItem {
  id: number;
  product_id: number;
  activity_id: number;
  title: string;
  image: string;
  price: number;
  ot_price: number;
  quota: number;
  quota_show: number;
  stock: number;
  percent: number;
  discount_num: number;
  activity_image: string;
}

export interface CombinationListItem {
  id: number;
  product_id: number;
  title: string;
  image: string;
  price: number;
  product_price: number;
  ot_price: number;
  people: number;
  pink_count: number;
  stock: number;
}

export interface BargainListItem {
  id: number;
  product_id: number;
  title: string;
  image: string;
  price: number;
  min_price: number;
  ot_price: number;
  people: number;
  sales: number;
  stock: number;
}

export interface IntegralListItem {
  id: number;
  product_id: number;
  title: string;
  image: string;
  integral: number;
  price: number;
  sales: number;
  stock: number;
}

export interface PresaleListItem extends GoodsItem {
  presale_pay_status: number;
  presale_start_time?: number;
  presale_end_time?: number;
}

export interface CouponListItem {
  id: number;
  type: number;
  coupon_type: number;
  coupon_title: string;
  coupon_price: string;
  use_min_price: string;
  is_use: boolean | 2;
  remain_count: number;
  receive_limit: number;
  coupon_time: number;
}

export interface CouponListData {
  list: CouponListItem[];
  count: [number, number, number, number];
}

export interface LiveGoodsItem {
  id: number;
  name: string;
  cover_img: string;
  price: string;
}

export interface LiveRoomListItem {
  id: number;
  room_id: number;
  name: string;
  cover_img: string;
  show_time: string;
  anchor_name: string;
  anchor_img: string;
  live_status: number;
  goods: LiveGoodsItem[];
}

export function apiSeckillIndex(): Promise<SeckillIndexData> {
  return http.get<SeckillIndexData>("/seckill/index");
}

export function apiSeckillList(time: string | number, params: ActivityPageParams = {}): Promise<SeckillListItem[]> {
  return http.get<SeckillListItem[]>(`/seckill/list/${encodeURIComponent(String(time))}`, params as Record<string, unknown>);
}

export function apiBargainList(params: ActivityPageParams = {}): Promise<BargainListItem[]> {
  return http.get<BargainListItem[]>("/bargain/list", params as Record<string, unknown>);
}

export function apiBargainStart(bargainId: number): Promise<{ id: number }> {
  return http.post<{ id: number }>("/bargain/start", { bargain_id: bargainId });
}

export function apiMyBargains(): Promise<unknown[]> {
  return http.get<unknown[]>("/bargain/user/list");
}

export function apiCombinationList(params: ActivityPageParams = {}): Promise<CombinationListItem[]> {
  return http.get<CombinationListItem[]>("/combination/list", params as Record<string, unknown>);
}

export function apiIntegralList(params: ActivityPageParams = {}): Promise<IntegralListItem[]> {
  return http.get<IntegralListItem[]>("/store_integral/list", params as Record<string, unknown>);
}

export function apiPresaleList(params: ActivityPageParams & { time_type?: number } = {}): Promise<PageResult<PresaleListItem>> {
  return http.get<PageResult<PresaleListItem>>("/presale/list", params as Record<string, unknown>);
}

export function apiCouponList(params: ActivityPageParams = {}): Promise<CouponListData> {
  return http.get<CouponListData>("/v2/coupons", params as Record<string, unknown>);
}

export function apiCouponReceive(id: number): Promise<{ couponUserId: number }> {
  return http.post<{ couponUserId: number }>("/coupon/receive", { id });
}

export function apiLiveRooms(params: ActivityPageParams = {}): Promise<LiveRoomListItem[]> {
  return http.get<LiveRoomListItem[]>("/wechat/live", params as Record<string, unknown>);
}
