/**
 * Admin 商品评价管理 API
 */
import request, { getData } from "@/utils/request";

export interface AdminReplyItem {
  id: number;
  productId: number;
  nickname: string;
  comment: string;
  productScore: number;
  pics: string[];
  status: number;
  addTime: number;
}

/** 评价列表 (GET /adminapi/reply/list) */
export function apiAdminReplyList(page = 1, limit = 10): Promise<AdminReplyItem[]> {
  return getData(request.get<AdminReplyItem[]>("/reply/list", { params: { page, limit } }));
}

/** 隐藏/显示 (POST /adminapi/reply/status/:id) */
export function apiAdminReplyStatus(id: number, status: number): Promise<null> {
  return getData(request.post<null>(`/reply/status/${id}`, { status }));
}

/** 删除 (DELETE /adminapi/reply/del/:id) */
export function apiAdminReplyDel(id: number): Promise<null> {
  return getData(request.delete<null>(`/reply/del/${id}`));
}
