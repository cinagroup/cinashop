/**
 * Admin 退款审核 API
 */
import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

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
  returnContact?: {
    source: "platform" | "store" | "supplier";
    name: string;
    phone: string;
    address: string;
  };
}

let previewRefunds: AdminRefund[] = [
  {
    id: 802,
    storeOrderId: 505,
    orderId: "R202609030002",
    uid: 10028,
    applyType: 2,
    applyPrice: "1280.00",
    refundType: 4,
    refundNum: 2,
    refundPrice: "1280.00",
    refundReason: "质量问题",
    refundExplain: "外包装完好，申请退货",
    isCancel: 0,
    isDel: 0,
    addTime: 1788409500,
    returnContact: {
      source: "platform",
      name: "CinaShop 售后中心",
      phone: "400-800-8888",
      address: "杭州市滨江区示例路88号售后仓",
    },
  },
  {
    id: 801,
    storeOrderId: 501,
    orderId: "R202609030001",
    uid: 10018,
    applyType: 1,
    applyPrice: "680.00",
    refundType: 0,
    refundNum: 1,
    refundPrice: "680.00",
    refundReason: "商品与描述不符",
    refundExplain: "",
    isCancel: 0,
    isDel: 0,
    addTime: 1788409000,
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 退款申请列表 (GET /adminapi/refund/list) */
export function apiAdminRefundList(): Promise<AdminRefund[]> {
  if (previewMode) return Promise.resolve(clone(previewRefunds));
  return getData(request.get("/refund/list"));
}

/** 退款详情 (GET /adminapi/refund/detail/:id) */
export function apiAdminRefundDetail(id: number): Promise<AdminRefund> {
  if (previewMode) {
    const row = previewRefunds.find((item) => item.id === id);
    return row ? Promise.resolve(clone(row)) : Promise.reject(new Error("退款记录不存在"));
  }
  return getData(request.get(`/refund/detail/${id}`));
}

/** 同意退款 (POST /adminapi/refund/refund/:id) */
export function apiAdminRefundAgree(id: number): Promise<null> {
  if (previewMode) {
    previewRefunds = previewRefunds.map((item) => item.id === id
      ? { ...item, refundType: 6 }
      : item);
    return Promise.resolve(null);
  }
  return getData(request.post(`/refund/refund/${id}`));
}

/** 拒绝退款 (POST /adminapi/refund/refuse/:id) */
export function apiAdminRefundRefuse(id: number, reason: string): Promise<null> {
  if (previewMode) {
    previewRefunds = previewRefunds.map((item) => item.id === id
      ? { ...item, refundType: 3, refundExplain: reason }
      : item);
    return Promise.resolve(null);
  }
  return getData(request.post(`/refund/refuse/${id}`, { refuse_reason: reason }));
}
