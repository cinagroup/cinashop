/**
 * 分销 + 发票 API
 */
import request, { getData } from "@/utils/request";

/** 佣金中心 (GET /api/commission) */
export function apiCommission(): Promise<{
  yesterdayCommission: string;
  totalCommission: string;
  frozenCommission: string;
  withdrawable: string;
  spreadCount: number;
}> {
  return getData(request.get("/commission"));
}

/** 推广人列表 (POST /api/spread/people) */
export function apiSpreadPeople(page = 1, limit = 10): Promise<
  { uid: number; nickname: string; avatar: string; addTime: number }[]
> {
  return getData(request.post("/spread/people", { page, limit }));
}

/** 佣金明细 (GET /api/spread/commission/:type) */
export function apiCommissionList(type: number): Promise<unknown[]> {
  return getData(request.get(`/spread/commission/${type}`));
}

/** 提现申请 (POST /api/extract/cash) */
export function apiExtractCash(params: {
  extract_type: string;
  real_name: string;
  extract_number: string;
  extract_price: string;
}): Promise<{ id: number }> {
  return getData(request.post("/extract/cash", params));
}

/** 发票列表 (GET /api/invoice) */
export function apiInvoiceList(): Promise<unknown[]> {
  return getData(request.get("/invoice"));
}

/** 保存发票 (POST /api/invoice/save) */
export function apiInvoiceSave(params: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post("/invoice/save", params));
}

/** 删除发票 (DELETE /api/invoice/del/:id) */
export function apiInvoiceDel(id: number): Promise<null> {
  return getData(request.delete(`/invoice/del/${id}`));
}

/** 充值套餐 (GET /api/recharge/index) */
export function apiRechargeIndex(): Promise<unknown> {
  return getData(request.get("/recharge/index"));
}

/** 创建充值订单 (POST /api/recharge/recharge) */
export function apiRechargeCreate(price: number, channel = "h5"): Promise<{ orderId: string; price: string }> {
  return getData(request.post("/recharge/recharge", { price, channel }));
}
