import { http } from "@/utils/request";

export interface ReplyStats {
  total: number;
  avgScore: string;
  goodRate: number;
  picsCount: number;
}

export interface ProductReviewListItem {
  id: number;
  product_id: number;
  uid: number;
  nickname: string;
  avatar: string;
  comment: string;
  suk: string;
  sku: string;
  product_score: number;
  service_score: number;
  delivery_score: number;
  star: number;
  pics: string[];
  merchant_reply: string;
  merchant_reply_content: string;
  merchant_reply_time: string;
  add_time: string;
  praise: number;
  is_praise: boolean;
}

export interface ReplyCommentUser {
  uid: number;
  nickname: string;
  avatar: string;
  level_name: string;
  vip_status: number;
}

export interface ReplyCommentItem {
  id: number;
  reply_id: number;
  pid: number;
  uid: number;
  content: string;
  praise: number;
  create_time: string;
  update_time: string;
  is_praise: boolean;
  user: ReplyCommentUser;
  children?: Omit<ReplyCommentItem, "children"> | null;
}

export interface ProductReviewDetail {
  reply: {
    id: number;
    product_id: number;
    uid: number;
    nickname: string;
    avatar: string;
    comment: string;
    sku: string;
    suk: string;
    product_score: number;
    service_score: number;
    delivery_score: number;
    pics: string[];
    praise: number;
    views_num: number;
    add_time: string;
    comment_sum: number;
  };
  product: {
    id?: number;
    store_name?: string;
    image?: string;
    is_presale_product?: number;
  };
  user: {
    uid?: number;
    nickname: string;
    avatar?: string;
    is_money_level?: number;
    level_name: string;
    vip_status: number;
  };
  star: string;
  is_praise: boolean;
}

export function apiReplyConfig(productId: number): Promise<ReplyStats> {
  return http.get(`/reply/config/${productId}`);
}

export function apiReplyList(productId: number, page = 1, limit = 20): Promise<ProductReviewListItem[]> {
  return http.get(`/reply/list/${productId}`, { page, limit });
}

export function apiReplyInfo(id: number): Promise<ProductReviewDetail> {
  return http.get(`/reply/info/${id}`);
}

export function apiReplyComments(id: number, page = 1, limit = 20): Promise<ReplyCommentItem[]> {
  return http.get(`/reply/comment/${id}`, { page, limit });
}

export function apiCreateReplyComment(id: number, content: string): Promise<null> {
  return http.post<null>(`/reply/comment/${id}`, { content });
}

export function apiPraiseReplyComment(id: number): Promise<null> {
  return http.post<null>(`/reply/praise/${id}`);
}

export function apiUnpraiseReplyComment(id: number): Promise<null> {
  return http.post<null>(`/reply/un_praise/${id}`);
}

export function apiPraiseProductReview(id: number): Promise<{ praise: number; isPraise: boolean }> {
  return http.post<{ praise: number; isPraise: boolean }>(`/reply/reply_praise/${id}`);
}

export function apiUnpraiseProductReview(id: number): Promise<{ praise: number; isPraise: boolean }> {
  return http.post<{ praise: number; isPraise: boolean }>(`/reply/un_reply_praise/${id}`);
}
