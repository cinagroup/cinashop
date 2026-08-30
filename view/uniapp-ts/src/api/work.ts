/**
 * Enterprise WeChat customer/group workbench API.
 *
 * The short-lived work-context token is intentionally separate from the shop
 * login token. Callers should keep it in memory and re-run OAuth after reload.
 */
import { http, type RequestOptions } from "@/utils/request";

export interface WorkContextChallenge {
  authorization_url: string;
  state: string;
  expires_in: number;
}

export type WorkContextTarget =
  | { target_type: "client"; external_userid: string }
  | { target_type: "group"; chat_id: string };

export interface WorkContextExchange {
  token: string;
  token_type: "Bearer";
  expires_in: number;
  target: { type: "client" | "group"; id: number };
}

export interface WorkGroupInfo {
  id: number;
  chat_id: string;
  name: string;
  owner: string;
  group_create_time: string;
  notice: string;
  member_num: number;
  retreat_group_num: number;
  todaySum: number;
  todayReturnSum: number;
}

export interface WorkGroupMember {
  id: number;
  userid: string;
  type: number;
  join_time: string;
  group_nickname: string;
  member: Record<string, unknown> | null;
  client: Record<string, unknown> | null;
  group_chat_num: number;
  tags: string[];
}

export interface WorkProductSummary {
  id: number;
  store_name: string;
  image: string;
  stock: number;
  price: string;
  sales: number;
  visit_time?: number;
}

function contextOptions(token: string): RequestOptions {
  if (!token || token.length > 4_096 || /\s/.test(token)) {
    throw new Error("企业微信上下文令牌无效");
  }
  return {
    noAuth: true,
    withCredentials: true,
    headers: { Authorization: `Bearer ${token}` },
  };
}

export function createWorkContextChallenge(redirectUri: string) {
  return http.post<WorkContextChallenge>(
    "/work/context/challenge",
    { redirect_uri: redirectUri },
    { noAuth: true, withCredentials: true },
  );
}

export function exchangeWorkContext(
  state: string,
  code: string,
  target: WorkContextTarget,
) {
  return http.post<WorkContextExchange>(
    "/work/context/exchange",
    { state, code, ...target },
    { noAuth: true, withCredentials: true },
  );
}

export function getWorkGroupInfo(token: string) {
  return http.get<WorkGroupInfo>("/work/groupInfo", {}, contextOptions(token));
}

export function getWorkGroupMembers(
  token: string,
  groupId: number,
  query: { page?: number; limit?: number; name?: string } = {},
) {
  return http.get<{ list: WorkGroupMember[]; count: number }>(
    `/work/groupMember/${groupId}`,
    query,
    contextOptions(token),
  );
}

export function getWorkClientInfo(token: string) {
  return http.get<Record<string, unknown>>("/work/client/info", {}, contextOptions(token));
}

export function getWorkOrderList(
  token: string,
  query: { page?: number; limit?: number; type?: number; search?: string } = {},
) {
  return http.get<Array<Record<string, unknown>>>("/work/order/list", query, contextOptions(token));
}

export function getWorkOrderInfo(token: string, orderId: number) {
  return http.get<{
    orderInfo: Record<string, unknown>;
    userInfo: Record<string, unknown>;
  }>(`/work/order/info/${orderId}`, {}, contextOptions(token));
}

export function getWorkPurchasedProducts(
  token: string,
  query: { page?: number; limit?: number; store_name?: string } = {},
) {
  return http.get<WorkProductSummary[]>("/work/product/cart_list", query, contextOptions(token));
}

export function getWorkVisitedProducts(
  token: string,
  query: { page?: number; limit?: number; store_name?: string } = {},
) {
  return http.get<WorkProductSummary[]>("/work/product/visit_list", query, contextOptions(token));
}
