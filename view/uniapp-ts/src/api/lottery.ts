import { http } from "@/utils/request";

export interface LotteryPrize {
  id: number;
  type: number;
  lottery_id: number;
  name: string;
  prompt: string;
  image: string;
}

export interface LotteryInfo {
  id: number;
  type: number;
  name: string;
  desc: string;
  image: string;
  factor: number;
  factor_num: number;
  lottery_num: number;
  todayCount: number;
  totalCount: number;
  content: string;
  prize: LotteryPrize[];
  all_record: LotteryRecord[];
  user_record: LotteryRecord[];
  cache_time: number;
}

export interface LotteryRecord {
  id: number;
  uid: number;
  type: number;
  prize?: LotteryPrize & { product_id?: number };
  prize_info?: LotteryPrize & { product_id?: number };
  isReceive?: number;
  is_receive?: number;
  isDeliver?: number;
  is_deliver?: number;
  receive_info?: Record<string, string>;
  deliver_info?: Record<string, string>;
  addTime?: number;
  add_time?: number;
}

export function apiLotteryInfo(factor = 1): Promise<LotteryInfo | []> {
  return http.get<LotteryInfo | []>(`/v2/lottery/info/${factor}`);
}

export function apiLotteryDraw(id: number, type: number): Promise<LotteryPrize & { lottery_record_id: number; is_receive: number }> {
  return http.post(`/v2/lottery`, { id, type });
}

export function apiLotteryReceive(data: { id: number; name?: string; phone?: string; address?: string; mark?: string }): Promise<null> {
  return http.post<null>("/v2/lottery/receive", data);
}

export function apiLotteryRecords(page = 1, limit = 20): Promise<LotteryRecord[]> {
  return http.get<LotteryRecord[]>("/v2/lottery/record", { page, limit });
}
