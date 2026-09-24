import request, { getData } from "@/utils/request";

export interface SeckillStatisticsHead {
  id: number;
  store_name: string;
  order_count: number;
  all_price: string;
  pay_count: number;
  pay_rate: string;
}

export interface SeckillStatisticsQuery {
  page: number;
  limit: number;
  real_name?: string;
  status?: 0 | 1 | 2 | 3 | 4;
}

export interface SeckillStatisticsPage<T> {
  list: T[];
  count: number;
  page: number;
  limit: number;
}

export interface SeckillParticipant {
  uid: number;
  real_name: string;
  goods_num: number;
  order_num: number;
  total_price: string;
  add_time: number;
}

export interface SeckillOrder {
  id: number;
  order_id: string;
  uid: number;
  real_name: string;
  status: string;
  pay_price: string;
  total_num: number;
  add_time: number;
  pay_time: number;
}

function validId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;
}

function requireId(id: number): void {
  if (!validId(id)) throw new Error("秒杀商品ID无效");
}

export async function apiSeckillStatisticsHead(id: number, signal?: AbortSignal): Promise<SeckillStatisticsHead> {
  requireId(id);
  return getData(request.get(`/activity/seckill-statistics/${id}/head`, { signal }));
}

export async function apiSeckillStatisticsPeople(id: number, query: SeckillStatisticsQuery, signal?: AbortSignal): Promise<SeckillStatisticsPage<SeckillParticipant>> {
  requireId(id);
  return getData(request.get(`/activity/seckill-statistics/${id}/people`, { params: query, signal }));
}

export async function apiSeckillStatisticsOrders(id: number, query: SeckillStatisticsQuery, signal?: AbortSignal): Promise<SeckillStatisticsPage<SeckillOrder>> {
  requireId(id);
  return getData(request.get(`/activity/seckill-statistics/${id}/orders`, { params: query, signal }));
}
