/**
 * 财务模块 API (提现审核)
 */
import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

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

export interface SupplierExtractItem {
  id: number;
  supplierId: number;
  supplierName: string;
  contactName: string;
  phone: string;
  extractType: string;
  bankCode: string;
  bankAddress: string;
  alipayAccount: string;
  wechat: string;
  qrcodeUrl: string;
  extractPrice: string;
  balance: string;
  mark: string;
  supplierMark: string;
  status: number;
  payStatus: number;
  adminId: number;
  adminName: string;
  failMsg: string;
  failTime: number;
  voucherImage: string;
  voucherTitle: string;
  payTime: number;
  addTime: number;
}

export interface SupplierExtractStatistics {
  pending_review: string;
  pending_transfer: string;
  paid: string;
  rejected: string;
}

export interface SupplierExtractListResult {
  list: SupplierExtractItem[];
  count: number;
  page: number;
  limit: number;
  extract_statistics: SupplierExtractStatistics;
}

const previewSupplierExtracts: SupplierExtractItem[] = [
  { id: 2001, supplierId: 1, supplierName: "优选贸易有限公司", contactName: "林经理", phone: "138****1024", extractType: "bank", bankCode: "6222 **** **** 3188", bankAddress: "招商银行深圳科技园支行", alipayAccount: "", wechat: "", qrcodeUrl: "", extractPrice: "10000.00", balance: "118640.50", mark: "", supplierMark: "季度结算", status: 0, payStatus: 0, adminId: 0, adminName: "", failMsg: "", failTime: 0, voucherImage: "", voucherTitle: "", payTime: 0, addTime: 1786240000 },
  { id: 2002, supplierId: 2, supplierName: "星辰数码供应链", contactName: "周女士", phone: "136****8821", extractType: "alipay", bankCode: "", bankAddress: "", alipayAccount: "finance@stars.example", wechat: "", qrcodeUrl: "https://cdn.example.com/alipay.png", extractPrice: "6800.00", balance: "32200.00", mark: "", supplierMark: "八月第一批", status: 1, payStatus: 0, adminId: 1, adminName: "平台管理员", failMsg: "", failTime: 0, voucherImage: "", voucherTitle: "", payTime: 0, addTime: 1786236000 },
  { id: 2003, supplierId: 3, supplierName: "华南生活馆", contactName: "陈经理", phone: "159****3006", extractType: "weixin", bankCode: "", bankAddress: "", alipayAccount: "", wechat: "south-shop", qrcodeUrl: "https://cdn.example.com/wechat.png", extractPrice: "3500.00", balance: "16800.00", mark: "已复核", supplierMark: "日常提现", status: 1, payStatus: 1, adminId: 1, adminName: "平台管理员", failMsg: "", failTime: 0, voucherImage: "https://cdn.example.com/voucher.png", voucherTitle: "银行转账回单", payTime: 1786245000, addTime: 1786229000 },
];

function previewSupplierStatistics(): SupplierExtractStatistics {
  const sum = (predicate: (row: SupplierExtractItem) => boolean) =>
    previewSupplierExtracts
      .filter(predicate)
      .reduce((total, row) => total + Number(row.extractPrice), 0)
      .toFixed(2);
  return {
    pending_review: sum((row) => row.status === 0),
    pending_transfer: sum((row) => row.status === 1 && row.payStatus === 0),
    paid: sum((row) => row.status === 1 && row.payStatus === 1),
    rejected: sum((row) => row.status === -1),
  };
}

export async function apiAdminSupplierExtractList(params: {
  status?: number;
  pay_status?: number;
  extract_type?: string;
  keyword?: string;
  page?: number;
  limit?: number;
}): Promise<SupplierExtractListResult> {
  if (previewMode) {
    const keyword = params.keyword?.trim().toLowerCase();
    const list = previewSupplierExtracts.filter((row) =>
      (params.status === undefined || row.status === params.status) &&
      (params.pay_status === undefined || row.payStatus === params.pay_status) &&
      (!params.extract_type || row.extractType === params.extract_type) &&
      (!keyword || `${row.id}${row.supplierName}${row.contactName}${row.phone}`.toLowerCase().includes(keyword)),
    );
    return { list: list.map((row) => ({ ...row })), count: list.length, page: 1, limit: 20, extract_statistics: previewSupplierStatistics() };
  }
  return getData(
    request.get<SupplierExtractListResult>("/supplier/extract/list", {
      params: params as Record<string, unknown>,
    }),
  );
}

export async function apiAdminSupplierExtractReview(
  id: number,
  data: { type: 1 | 0; message?: string },
): Promise<null> {
  if (previewMode) {
    const row = previewSupplierExtracts.find((item) => item.id === id);
    if (row) {
      row.status = data.type === 1 ? 1 : -1;
      row.failMsg = data.type === 1 ? "" : data.message ?? "";
      row.adminId = 1;
      row.adminName = "平台管理员";
    }
    return null;
  }
  return getData(request.post<null>(`/supplier/extract/verify/${id}`, data));
}

export async function apiAdminSupplierExtractTransfer(
  id: number,
  data: { voucher_title: string; voucher_image: string },
): Promise<null> {
  if (previewMode) {
    const row = previewSupplierExtracts.find((item) => item.id === id);
    if (row) {
      row.payStatus = 1;
      row.voucherTitle = data.voucher_title;
      row.voucherImage = data.voucher_image;
      row.payTime = Math.floor(Date.now() / 1000);
    }
    return null;
  }
  return getData(request.post<null>(`/supplier/extract/save_transfer/${id}`, data));
}
