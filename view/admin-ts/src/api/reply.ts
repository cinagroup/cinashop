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

/** Stored PHP reply-comment columns. create_time maps to the TS add_time column. */
export interface AdminProductReplyComment {
  id: number;
  type: number;
  relation_id: number;
  uid: number;
  praise: number;
  content: string;
  pid: number;
  reply_id: number;
  create_time: string;
  update_time: string;
}

export interface AdminProductReplyUser {
  uid?: number;
  nickname?: string;
  avatar?: string;
  is_money_level?: number;
  level_name?: number | string;
  vip_status?: number | string;
}

export interface AdminProductReplyThread extends AdminProductReplyComment {
  user: AdminProductReplyUser | null;
  children: (AdminProductReplyComment & { user: AdminProductReplyUser | null; is_praise: boolean }) | null;
  is_praise: boolean;
}

/** Legacy moderation projection; status is the existing TS visibility extension. */
export interface AdminProductReplyItem {
  id: number;
  uid: number;
  oid: number;
  type: number;
  relation_id: number;
  unique: string;
  product_id: number;
  sku_unique: string;
  sku: string;
  reply_type: string;
  reply_score: number;
  product_score: number;
  service_score: number;
  delivery_score: number;
  comment: string;
  pics: unknown;
  add_time: string;
  praise: number;
  views_num: number;
  merchant_reply_content: string;
  merchant_reply_time: number;
  is_del: number;
  is_reply: number;
  nickname: string;
  avatar: string;
  store_name: string | null;
  image: string | null;
  account: string;
  create_time: string;
  time: string | null;
  score: string;
  status: number;
  replyComment: AdminProductReplyComment | null;
}

export interface AdminProductReplyQuery {
  store_name: string;
  account: string;
  data: string;
  product_id: number;
  is_reply: "" | 0 | 1;
  page: number;
  limit: number;
}

export function apiAdminProductReplyList(query: AdminProductReplyQuery, signal?: AbortSignal): Promise<{ list: AdminProductReplyItem[]; count: number }> {
  return getData(request.get("/product/reply", { params: query, signal }));
}
export function apiAdminProductReplySet(id: number, content: string): Promise<void> {
  return getData(request.put(`/product/reply/set_reply/${id}`, { content }));
}
export function apiAdminProductReplyDelete(id: number): Promise<void> {
  return getData(request.delete(`/product/reply/${id}`));
}
export function apiAdminProductReplyGet(id: number, signal?: AbortSignal): Promise<AdminProductReplyComment | { content: "" }> {
  return getData(request.get(`/product/reply/get_reply/${id}`, { signal }));
}
export function apiAdminProductReplyComments(id: number, query: { time: string; page: number; limit: number }, signal?: AbortSignal): Promise<{ list: AdminProductReplyThread[]; count: number }> {
  return getData(request.get(`/product/reply/comment/${id}`, { params: query, signal }));
}
export function apiAdminProductReplySaveComment(replyId: number, id: number, content: string): Promise<void> {
  return getData(request.post(`/product/reply/save_comment/${replyId}/${id}`, { content }));
}
export function apiAdminProductReplyDeleteComment(id: number): Promise<void> {
  return getData(request.delete(`/product/reply/delete_comment/${id}`));
}

/** The source form is metadata; the active editor also supplies SKU/logistics fields. */
export interface AdminFictitiousReplyForm {
  title: string;
  action: string;
  method: string;
  rules: { field: string; type: string; value?: unknown; props?: Record<string, unknown> }[];
}

export interface AdminReplyProductSku {
  id: number;
  product_id: number;
  unique: string;
  suk: string;
  image: string;
  type: number;
  is_retired: number;
  stock: number;
  price: number | string;
}

export interface AdminReplyProduct {
  id: number;
  store_name: string;
  image: string;
  type: number;
  relation_id: number;
  is_show: number;
  attrValue: AdminReplyProductSku[];
}

export interface AdminReplyProductQuery {
  page: number;
  limit: number;
  cate_id: string;
  store_name: string;
  is_new: "" | 0 | 1;
  store_label_id: string;
  is_integral: 1;
}

export interface AdminFictitiousReplyInput {
  image: { product_id: number; image: string };
  unique: string;
  nickname: string;
  avatar: string;
  comment: string;
  product_score: number;
  service_score: number;
  delivery_score: number;
  reply_score: "1" | "2" | "3";
  pics: string[];
  add_time: string;
}

export function apiAdminProductReplyFictitiousForm(productId: number, signal?: AbortSignal): Promise<AdminFictitiousReplyForm> {
  return getData(request.get(`/product/reply/fictitious_reply/${productId}`, { signal }));
}

export function apiAdminProductReplySaveFictitious(input: AdminFictitiousReplyInput): Promise<void> {
  return getData(request.post("/product/reply/save_fictitious_reply", input));
}

/** Actual PHP goods selector, including ordinary SKU rows under attrValue. */
export function apiAdminReplyProductSelector(query: AdminReplyProductQuery, signal?: AbortSignal): Promise<{ list: AdminReplyProduct[]; count: number }> {
  return getData(request.get("/product/product/list", { params: query, signal }));
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
