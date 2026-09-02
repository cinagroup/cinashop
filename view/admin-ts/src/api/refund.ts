/**
 * Admin 退款审核 API
 */
import request, { getData } from "@/utils/request";

/** 退款申请类型 (后端返回驼峰字段) */
export interface AdminRefund {
  id: number;
  storeOrderId: number;
  orderId: string;
  uid: number;
  applyType: number;
  applyPrice: string;
  refundType: number;
  refundNum: number;
  refundPrice: string;
  refundReason: string;
  refundExplain: string;
  isCancel: number;
  isDel: number;
  addTime: number;
}

/** 退款申请列表 (GET /adminapi/refund/list) */
export function apiAdminRefundList(): Promise<AdminRefund[]> {
  return getData(request.get("/refund/list"));
}

/** 退款详情 (GET /adminapi/refund/detail/:id) */
export function apiAdminRefundDetail(id: number): Promise<AdminRefund> {
  return getData(request.get(`/refund/detail/${id}`));
}

/** 同意退款 (POST /adminapi/refund/refund/:id) */
export function apiAdminRefundAgree(id: number): Promise<null> {
  return getData(request.post(`/refund/refund/${id}`));
}

/** 拒绝退款 (POST /adminapi/refund/refuse/:id) */
export function apiAdminRefundRefuse(id: number, reason: string): Promise<null> {
  return getData(request.post(`/refund/refuse/${id}`, { refuse_reason: reason }));
}
