/**
 * 财务模块 API (提现审核)
 */
import request, { AdminResponseError, getData } from "@/utils/request";

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
  /** 0=待审核 1=已通过 -1=已拒绝（旧响应也可能为2） */
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

const previewExtracts: ExtractItem[] = [
  { id: 51, uid: 7, extractType: "bank", bankName: "预览银行", realName: "预览用户", extractNumber: "6222 **** **** 0123", extractPrice: "19.50", status: 0, failMsg: "", addTime: 1788580000, nickname: "预览申请人" },
  { id: 52, uid: 8, extractType: "alipay", bankName: "", realName: "历史预览用户", extractNumber: "preview@example.invalid", extractPrice: "10.00", status: 1, failMsg: "", addTime: 1788570000, nickname: "已审核预览" },
];

export function previewExtractPendingCount(): number {
  return previewExtracts.filter((row) => row.status === 0).length;
}

/** 提现列表 (可按状态筛选) */
export function apiAdminExtractList(params: {
  status?: number;
  page?: number;
  limit?: number;
}): Promise<ExtractListResult> {
  if (previewMode) {
    const rows = previewExtracts.filter((row) => params.status === undefined || row.status === params.status);
    const start = ((params.page ?? 1) - 1) * (params.limit ?? 20);
    return Promise.resolve({ list: rows.slice(start, start + (params.limit ?? 20)).map((row) => ({ ...row })), total: rows.length });
  }
  return getData(
    request.get<ExtractListResult>("/extract/list", {
      params: params as Record<string, unknown>,
    }),
  );
}

/** 提现审核 (status=1 通过 / 2 拒绝) */
export async function apiAdminExtractStatus(
  id: number,
  data: { status: number; fail_msg?: string },
): Promise<null> {
  if (previewMode) {
    const row = previewExtracts.find((item) => item.id === id);
    if (!row || row.status !== 0 || ![1, 2].includes(data.status)) throw new Error("预览记录已审核或参数错误");
    row.status = data.status === 2 ? -1 : 1;
    row.failMsg = data.status === 2 ? data.fail_msg ?? "审核拒绝" : "";
  } else {
    await getData(request.post<null>(`/extract/status/${id}`, data));
  }
  window.dispatchEvent(new Event("cinashop:admin-todos-changed"));
  return null;
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

/** Platform cash movement in capital_flow; /bill/list reads the separate user_bill ledger. */
export interface CapitalFlowItem {
  id: number;
  flow_id: string;
  order_id: string;
  store_id: number;
  uid: number;
  nickname: string;
  phone: string;
  price: string;
  trading_type_code: number;
  trading_type: string;
  pay_type_code: string;
  pay_type: string;
  mark: string;
  /** Server-formatted Asia/Shanghai wall time, YYYY-MM-DD HH:mm:ss. */
  add_time: string;
}

export interface CapitalFlowListResult {
  list: CapitalFlowItem[];
  count: number;
  status: string[];
}

export function apiAdminCapitalFlowList(params: {
  trading_type?: number;
  keywords?: string;
  start?: number;
  stop?: number;
  page: number;
  limit: number;
}): Promise<CapitalFlowListResult> {
  return getData(
    request.get<CapitalFlowListResult>("/flow/get_list", {
      params: params as Record<string, unknown>,
    }),
  );
}

export function apiAdminCapitalFlowSetMark(id: number, mark: string): Promise<{ id: number; mark: string }> {
  if (!Number.isSafeInteger(id) || id <= 0 || mark.length > 200) {
    return Promise.reject(new Error("流水 ID 或备注长度无效"));
  }
  return getData(request.post<{ id: number; mark: string }>(`/flow/set_mark/${id}`, { mark }));
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
  withdrawable: string;
}

export interface SupplierExtractSupplier { id: number; supplierName: string }

export interface SupplierExtractQuery {
  supplier_id?: number | "";
  start_time?: string;
  end_time?: string;
  status?: -1 | 0 | 1;
  pay_status?: 0 | 1;
  extract_type?: string;
  keyword?: string;
  page: number;
  limit: number;
}

function shanghaiWallTime(value: string): number {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("请选择有效的上海时间范围");
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utc);
  if (year < 1970 || year > 2038 || check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second || (utc - 8 * 3_600_000) / 1000 < 0 ||
    (utc - 8 * 3_600_000) / 1000 > 2_147_483_647) {
    throw new Error("请选择有效的上海时间范围");
  }
  return utc;
}

/** Picker values are Asia/Shanghai wall times, independent of the browser timezone. */
export function supplierExtractTimeRange(value: string[] | null): { start_time: string; end_time: string } {
  if (!value || value.length === 0) return { start_time: "", end_time: "" };
  if (value.length !== 2) throw new Error("请选择完整的上海时间范围");
  const start = shanghaiWallTime(value[0]);
  const end = shanghaiWallTime(value[1]);
  if (end < start) throw new Error("结束时间不得早于开始时间");
  const endEpoch = (end - 8 * 3_600_000) / 1000;
  if ((end === start || value[1].endsWith(" 00:00:00")) && endEpoch + 86_400 > 2_147_483_647) {
    throw new Error("结束时间超出可查询范围");
  }
  return { start_time: value[0], end_time: value[1] };
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

function previewSupplierStatistics(supplierId?: number | ""): SupplierExtractStatistics {
  const scoped = previewSupplierExtracts.filter((row) => supplierId === undefined || supplierId === "" || row.supplierId === supplierId);
  const sum = (predicate: (row: SupplierExtractItem) => boolean) =>
    scoped
      .filter(predicate)
      .reduce((total, row) => total + Number(row.extractPrice), 0)
      .toFixed(2);
  return {
    pending_review: sum((row) => row.status === 0),
    pending_transfer: sum((row) => row.status === 1 && row.payStatus === 0),
    paid: sum((row) => row.status === 1 && row.payStatus === 1),
    rejected: sum((row) => row.status === -1),
    withdrawable: scoped.reduce((total, row) => total + Number(row.balance), 0).toFixed(2),
  };
}

export function apiAdminSupplierExtractSuppliers(signal?: AbortSignal): Promise<{ list: SupplierExtractSupplier[] }> {
  if (previewMode) {
    return Promise.resolve({ list: previewSupplierExtracts.map((row) => ({ id: row.supplierId, supplierName: row.supplierName })) });
  }
  return getData(request.get("/supplier/extract/suppliers", { signal }));
}

export async function apiAdminSupplierExtractList(params: SupplierExtractQuery, signal?: AbortSignal): Promise<SupplierExtractListResult> {
  if (previewMode) {
    const keyword = params.keyword?.trim().toLowerCase();
    const dates = params.start_time && params.end_time
      ? [shanghaiWallTime(params.start_time), shanghaiWallTime(params.end_time)] : null;
    const rows = previewSupplierExtracts.filter((row) =>
      (params.supplier_id === undefined || params.supplier_id === "" || row.supplierId === params.supplier_id) &&
      (!dates || (row.addTime >= (dates[0] - 8 * 3_600_000) / 1000 &&
        row.addTime <= (dates[1] - 8 * 3_600_000) / 1000 +
          (dates[0] === dates[1] || params.end_time?.endsWith(" 00:00:00") ? 86_400 : 0))) &&
      (params.status === undefined || row.status === params.status) &&
      (params.pay_status === undefined || row.payStatus === params.pay_status) &&
      (!params.extract_type || row.extractType === params.extract_type) &&
      (!keyword || `${row.id}${row.supplierName}${row.contactName}${row.phone}`.toLowerCase().includes(keyword)),
    );
    const start = (params.page - 1) * params.limit;
    return { list: rows.slice(start, start + params.limit).map((row) => ({ ...row })), count: rows.length,
      page: params.page, limit: params.limit, extract_statistics: previewSupplierStatistics(params.supplier_id) };
  }
  return getData(
    request.get<SupplierExtractListResult>("/supplier/extract/list", {
      params: { ...params },
      signal,
    }),
  );
}

export async function apiAdminSupplierExtractReview(
  id: number,
  data: { type: 1 | 0; message?: string },
  signal?: AbortSignal,
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
  return getData(request.post<null>(`/supplier/extract/verify/${id}`, data, { signal }));
}

export async function apiAdminSupplierExtractTransfer(
  id: number,
  data: { voucher_title: string; voucher_image: string },
  signal?: AbortSignal,
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
  return getData(request.post<null>(`/supplier/extract/save_transfer/${id}`, data, { signal }));
}

export async function apiAdminSupplierExtractMark(
  id: number, mark: string, expectedSupplierMark: string, signal?: AbortSignal,
): Promise<{ id: number; supplierMark: string }> {
  if (!Number.isSafeInteger(id) || id <= 0 || !mark.trim() || [...mark].length > 200 ||
    typeof expectedSupplierMark !== "string") {
    throw new Error("备注须填写且不能超过 200 字");
  }
  if (previewMode) {
    const row = previewSupplierExtracts.find((item) => item.id === id);
    if (!row) throw new Error("提现记录不存在");
    if (row.supplierMark !== expectedSupplierMark) throw new AdminResponseError("备注已被更新", 409);
    row.supplierMark = mark.trim();
    return { id, supplierMark: row.supplierMark };
  }
  return getData(request.post(`/supplier/extract/mark/${id}`,
    { mark, expected_supplier_mark: expectedSupplierMark }, { signal }));
}
