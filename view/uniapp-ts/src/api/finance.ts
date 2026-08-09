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
}

export interface Invoice {
  id: number;
  headerType: number;
  type: number;
  name: string;
  dutyNumber: string;
  email: string;
  isDefault: number;
  addTime: number;
}

/** 佣金中心 (GET /api/commission) */
export function apiCommission(): Promise<CommissionInfo> {
  return http.get<CommissionInfo>("/commission");
}

/** 佣金明细 (GET /api/spread/commission/:type 1=一级 2=二级 3=提现) */
export function apiCommissionList(type: number): Promise<CommissionItem[]> {
  return http.get<CommissionItem[]>(`/spread/commission/${type}`);
}

/** 推广人列表 (POST /api/spread/people) */
export function apiSpreadPeople(page = 1, limit = 20): Promise<SpreadUser[]> {
  return http.post<SpreadUser[]>("/spread/people", { page, limit });
}

/** 绑定推广人 (POST /api/user/spread) */
export function apiBindSpread(spreadUid: number): Promise<null> {
  return http.post<null>("/user/spread", { spread_uid: spreadUid });
}

/** 提现申请 (POST /api/extract/cash) */
export function apiExtractCash(params: {
  extract_type: string;
  real_name: string;
  extract_number: string;
  extract_price: string;
  bank_name?: string;
}): Promise<{ id: number }> {
  return http.post<{ id: number }>("/extract/cash", params);
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
