import request, { getData } from "@/utils/request";

export interface LotteryPrize {
  id?: number;
  type: number;
  name: string;
  prompt: string;
  image: string;
  chance: number;
  total: number;
  couponId?: number;
  productId?: number;
  unique?: string;
  num: string;
  sort: number;
  status: number;
}

export interface LotteryActivity {
  id: number;
  type: number;
  name: string;
  desc: string;
  image: string;
  factor: number;
  factorNum: number;
  attendsUser: number;
  userLevel: number[] | string;
  userLabel: number[] | string;
  isSvip: number;
  startTime: number;
  endTime: number;
  lotteryNumTerm: number;
  lotteryNum: number;
  totalLotteryNum: number;
  spreadNum: number;
  isAllRecord: number;
  isPersonalRecord: number;
  isContent: number;
  content: string;
  status: number;
  sort: number;
  time_status?: number;
  prize?: LotteryPrize[];
}

export interface LotteryRecord {
  id: number;
  uid: number;
  lotteryId: number;
  type: number;
  isReceive: number;
  isDeliver: number;
  receiveTime: number;
  deliverTime: number;
  addTime: number;
  prize?: LotteryPrize;
  user?: { nickname?: string; realName?: string; phone?: string };
  receive_info?: Record<string, string>;
  deliver_info?: Record<string, string>;
}

export function apiLotteryList(params: Record<string, unknown> = {}): Promise<{ list: LotteryActivity[]; count: number }> {
  return getData(request.get<{ list: LotteryActivity[]; count: number }>("/lottery/list", { params }));
}

export function apiLotteryDetail(id: number): Promise<LotteryActivity> {
  return getData(request.get<LotteryActivity>(`/lottery/detail/${id}`));
}

export function apiLotteryAdd(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/lottery/add", data));
}

export function apiLotteryEdit(id: number, data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.put<{ id: number }>(`/lottery/edit/${id}`, data));
}

export function apiLotteryDelete(id: number): Promise<null> {
  return getData(request.delete<null>(`/lottery/del/${id}`));
}

export function apiLotteryStatus(id: number, status: number): Promise<null> {
  return getData(request.post<null>(`/lottery/set_status/${id}/${status}`));
}

export function apiLotteryRecords(params: Record<string, unknown> = {}, activityId?: number): Promise<{ list: LotteryRecord[]; count: number }> {
  const suffix = activityId ? `/${activityId}` : "";
  return getData(request.get<{ list: LotteryRecord[]; count: number }>(`/lottery/record/list${suffix}`, { params }));
}

export function apiLotteryDeliver(data: Record<string, unknown>): Promise<null> {
  return getData(request.post<null>("/lottery/record/deliver", data));
}
