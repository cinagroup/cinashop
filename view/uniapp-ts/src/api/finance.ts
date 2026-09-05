/**
 * 分销/财务 API (佣金/提现/发票/充值)
 */
import { http } from "@/utils/request";

export interface CommissionInfo {
  yesterdayCommission: string;
  totalCommission: string;
  frozenCommission: string;
  withdrawable: string;
  spreadCount: number;
}

export interface CommissionItem {
  id: number;
  uid: number;
  linkId: string;
  pm: number;
  title: string;
  category: string;
  type: string;
  number: string;
  balance: string;
  mark: string;
  status: number;
  addTime: number;
}

export interface SpreadUser {
  uid: number;
  nickname: string;
  avatar: string;
  addTime: number;
  time: string;
  childCount: number;
  orderCount: number;
  numberCount: string;
}

export interface SpreadPeopleResult { list: SpreadUser[]; total: number; totalLevel: number; count: number; brokerage_level: number; price: string }
export interface ExtractConfig { commissionCount: string; extractBank: string[]; minPrice: string; maxPrice: string; withdraw_fee: string; extract_wechat_type: number; user_extract_balance_status: number }
export interface ExtractInput { extract_type: string; real_name: string; extract_number: string; extract_price: string; bank_name?: string; bank_address?: string; qrcode_url?: string; request_id?: string }
export interface ExtractRecord { id: number; status: number; extractPrice: string; extractFee: string; failMsg: string }

export const apiExtractConfig = () => http.get<ExtractConfig>("/extract/bank");
export const apiExtractRequests = (requestId: string) => http.get<ExtractRecord[]>("/user/extract/list", { request_id: requestId });

export interface Invoice {
  id: number;
  headerType: number;
  type: number;
  name: string;
  dutyNumber: string;
  drawerPhone: string;
  email: string;
  isDefault: number;
  addTime: number;
}

/** 佣金中心 (GET /api/commission) */
export function apiCommission(): Promise<CommissionInfo> {
  return http.get<CommissionInfo>("/commission");
}

/** New-client classification is separate from PHP's monthly 0..4 contract. */
export function apiCommissionList(type: number, page = 1, limit = 20): Promise<CommissionItem[]> {
  return http.get<CommissionItem[]>(`/user/commission/list/${type}`, { page, limit });
}

/** 推广人列表 (POST /api/spread/people) */
export function apiSpreadPeople(page = 1, limit = 20, filters: { grade?: number; keyword?: string; sort?: string } = {}): Promise<SpreadPeopleResult> {
  return http.post<SpreadPeopleResult>("/spread/people", { page, limit, ...filters });
}

/** 绑定推广人 (POST /api/user/spread) */
export function apiBindSpread(spreadUid: number): Promise<null> {
  return http.post<null>("/user/spread", { spread_uid: spreadUid });
}

/** 提现申请 (POST /api/extract/cash) */
export function apiExtractCash(params: ExtractInput): Promise<{ id: number }> {
  return http.post<{ id: number }>("/extract/cash", { ...params });
}

/** 发票列表 (GET /api/invoice) */
export function apiInvoiceList(): Promise<Invoice[]> {
  return http.get<Invoice[]>("/invoice");
}

/** 保存发票 (POST /api/invoice/save) */
export function apiInvoiceSave(params: {
  id?: number;
  header_type: number;
  type: number;
  name: string;
  duty_number?: string;
  drawer_phone?: string;
  drawerPhone?: string;
  email?: string;
  is_default?: number;
}): Promise<{ id: number }> {
  return http.post<{ id: number }>("/invoice/save", params);
}

/** 删除发票 (DELETE /api/invoice/del/:id) */
export function apiInvoiceDel(id: number): Promise<null> {
  return http.delete<null>(`/invoice/del/${id}`);
}

/** 设置默认发票 (POST /api/invoice/set_default/:id) */
export function apiInvoiceSetDefault(id: number): Promise<null> {
  return http.post<null>(`/invoice/set_default/${id}`);
}
