/**
 * Public article compatibility API.
 *
 * These routes intentionally keep the original cinashop-php paths and
 * snake_case response fields so migrated clients do not need an adapter.
 */
import { http } from "@/utils/request";

export interface ArticleCategory {
  id: number;
  title: string;
}

export interface ArticleListParams {
  page: number;
  limit: number;
}

export interface ArticleListItem {
  id: number;
  title: string;
  image_input: string[];
  /** PHP's list projection preserves the legacy varchar shape. */
  visit: string;
  likes?: number;
  add_time: string;
  synopsis: string;
  url: string;
}

export interface ArticleProduct {
  id: number;
  store_name: string;
  image: string;
  price: string | number;
  ot_price: string | number;
}

export interface ArticleDetail {
  id: number;
  cid: string;
  title: string;
  author: string;
  content: string | null;
  synopsis: string;
  status: number;
  add_time: string;
  image_input: string[];
  share_title: string;
  share_synopsis: string;
  visit: number;
  likes: number;
  sort: number;
  url: string;
  hide: number;
  admin_id: number;
  mer_id: number;
  product_id: number;
  is_hot: number;
  is_banner: number;
  catename: string | null;
  storeInfo?: ArticleProduct | null;
  store_info?: ArticleProduct | null;
  is_like: boolean | 0 | 1;
}

export interface ArticleLikeParams {
  status: 0 | 1;
}

function pageParams(params: ArticleListParams): Record<string, unknown> {
  return { page: params.page, limit: params.limit };
}

export function apiArticleCategoryList(): Promise<ArticleCategory[]> {
  return http.get<ArticleCategory[]>("article/category/list", {}, { noAuth: true });
}

export function apiArticleList(
  cid: number,
  params: ArticleListParams,
): Promise<ArticleListItem[]> {
  return http.get<ArticleListItem[]>(`article/list/${cid}`, pageParams(params), { noAuth: true });
}

export function apiArticleHotList(params: ArticleListParams): Promise<ArticleListItem[]> {
  return http.get<ArticleListItem[]>("article/hot/list", pageParams(params), { noAuth: true });
}

export function apiArticleNewList(params: ArticleListParams): Promise<ArticleListItem[]> {
  return http.get<ArticleListItem[]>("article/new/list", pageParams(params), { noAuth: true });
}

export function apiArticleBannerList(params: ArticleListParams): Promise<ArticleListItem[]> {
  return http.get<ArticleListItem[]>("article/banner/list", pageParams(params), { noAuth: true });
}

/** Optional auth is preserved so signed-in readers receive the exact is_like state. */
export function apiArticleDetails(id: number): Promise<ArticleDetail> {
  return http.get<ArticleDetail>(`article/details/${id}`);
}

/** The caller must enforce login before invoking this optional-auth legacy route. */
export function apiArticleLike(id: number, params: ArticleLikeParams): Promise<void> {
  // The compatibility success envelope intentionally has no data member.
  return http.get<void>(`article/like/${id}`, { status: params.status });
}
