/**
 * 财务模块 API (提现审核)
 */
import request, { getData } from "@/utils/request";

export interface ExtractItem {
  id: number;
  uid: number;
  extractType: string;
  bankName: string;
  realName: string;
  extractNumber: string;
  extractPrice: string;
  /** 0=待审核 1=已通过 2=已拒绝 */
  status: number;
  failMsg: string;
  addTime: number;
  nickname?: string;
  account?: string;
}

export interface ExtractListResult {
  list: ExtractItem[];
  total: number;
}

/** 提现列表 (可按状态筛选) */
export function apiAdminExtractList(params: {
  status?: number;
  page?: number;
  limit?: number;
}): Promise<ExtractListResult> {
  return getData(
    request.get<ExtractListResult>("/extract/list", {
      params: params as Record<string, unknown>,
    }),
  );
}

/** 提现审核 (status=1 通过 / 2 拒绝) */
export function apiAdminExtractStatus(
  id: number,
  data: { status: number; fail_msg?: string },
): Promise<null> {
  return getData(request.post<null>(`/extract/status/${id}`, data));
}

export interface BillItem {
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
  addTime: number;
  nickname?: string;
  account?: string;
}

export interface BillListResult {
  list: BillItem[];
  total: number;
}

/** 资金流水 (GET /adminapi/bill/list) */
export function apiAdminBillList(params: {
  pm?: number;
  page?: number;
  limit?: number;
}): Promise<BillListResult> {
  return getData(
    request.get<BillListResult>("/bill/list", {
      params: params as Record<string, unknown>,
    }),
  );
}
