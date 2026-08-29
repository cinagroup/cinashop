import { apiRequest, queryString } from "@/api/client";
import type {
  AttachmentUpload,
  ChatMessage,
  KefuIdentity,
  KefuClientConfig,
  KefuOrderDetail,
  KefuOrderEditResult,
  KefuOrderSummary,
  KefuDeliveryAgent,
  KefuExpressOption,
  KefuFulfillmentResult,
  KefuManagementForm,
  KefuProductDetail,
  KefuProductSummary,
  KefuRefundDetail,
  KefuRefundListResult,
  KefuRefundSummary,
  KefuRemarkResult,
  KefuSplitCartItem,
  KefuWriteoffInfo,
  KefuWriteoffResult,
  LoginResult,
  KefuScanChallenge,
  KefuScanPollResult,
  SessionPage,
  Speechcraft,
  SpeechcraftCategory,
  UserGroup,
  UserInfo,
  UserLabelCategory,
  TransferResult,
  TransferTarget,
} from "@/types/kefu";

export const kefuApi = {
  login: (account: string, password: string) => apiRequest<LoginResult>("/kefuapi/login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  }),
  config: () => apiRequest<KefuClientConfig>("/kefuapi/config"),
  createScanChallenge: () => apiRequest<KefuScanChallenge>("/kefuapi/key", {
    method: "POST",
  }),
  pollScanChallenge: (key: string, pollToken: string) =>
    apiRequest<KefuScanPollResult>(`/kefuapi/scan/${encodeURIComponent(key)}`, {
      headers: { "X-Scan-Poll-Token": pollToken },
    }),
  createOauthState: () => apiRequest<{ state: string; expires_in: number }>("/kefuapi/oauth_state", {
    method: "POST",
  }),
  wechatLogin: (code: string, state: string) =>
    apiRequest<LoginResult>(`/kefuapi/wechat${queryString({ code, state })}`),
  logout: () => apiRequest<null>("/kefuapi/user/logout", { method: "POST" }),
  info: () => apiRequest<KefuIdentity>("/kefuapi/service/info"),
  uploadImage: (file: File) => {
    const body = new FormData();
    body.set("file", file);
    body.set("pid", "0");
    return apiRequest<AttachmentUpload>("/kefuapi/upload", { method: "POST", body });
  },
  sessions: (input: { nickname?: string; cursor?: string; is_tourist?: number; limit?: number } = {}) =>
    apiRequest<SessionPage>(`/kefuapi/user/record${queryString(input)}`),
  history: (uid: number, input: { upperId?: number; is_tourist?: number; limit?: number } = {}) =>
    apiRequest<ChatMessage[]>(`/kefuapi/service/list${queryString({ uid, ...input })}`),
  transferTargets: (nickname = "") =>
    apiRequest<{ list: TransferTarget[]; count: number }>(`/kefuapi/service/transfer_list${queryString({ nickname, limit: 100 })}`),
  transfer: (input: { uid: number; kefuToUid: number; request_key: string; is_tourist: 0 | 1 }) =>
    apiRequest<TransferResult>("/kefuapi/service/transfer", {
      method: "POST",
      headers: { "Idempotency-Key": input.request_key },
      body: JSON.stringify(input),
    }),
  userInfo: (uid: number) => apiRequest<UserInfo>(`/kefuapi/user/info/${uid}`),
  userLabels: (uid: number) => apiRequest<UserLabelCategory[]>(`/kefuapi/user/label/${uid}`),
  setUserLabels: (uid: number, labelIds: number[], removedIds: number[]) =>
    apiRequest<null>(`/kefuapi/user/label/${uid}`, {
      method: "PUT",
      body: JSON.stringify({ label_ids: labelIds, un_label_ids: removedIds }),
    }),
  groups: () => apiRequest<UserGroup[]>("/kefuapi/user/group"),
  setGroup: (uid: number, groupId: number) =>
    apiRequest<null>(`/kefuapi/user/group/${uid}/${groupId}`, { method: "PUT" }),
  purchasedProducts: (uid: number, input: { store_name?: string; page?: number; limit?: number } = {}) =>
    apiRequest<KefuProductSummary[]>(`/kefuapi/product/cart/${uid}${queryString(input)}`),
  visitedProducts: (uid: number, input: { store_name?: string; page?: number; limit?: number } = {}) =>
    apiRequest<KefuProductSummary[]>(`/kefuapi/product/visit/${uid}${queryString(input)}`),
  hotProducts: (uid: number, storeName = "") =>
    apiRequest<KefuProductSummary[]>(`/kefuapi/product/hot/${uid}${queryString({ store_name: storeName })}`),
  productInfo: (id: number) => apiRequest<KefuProductDetail>(`/kefuapi/product/info/${id}`),
  customerOrders: (uid: number, input: { type?: number | string; search?: string; page?: number; limit?: number } = {}) =>
    apiRequest<KefuOrderSummary[] | KefuRefundSummary[]>(`/kefuapi/order/list/${uid}${queryString(input)}`),
  orderInfo: (id: number) => apiRequest<KefuOrderDetail>(`/kefuapi/order/info/${id}`),
  orderEditForm: (id: number) => apiRequest<KefuManagementForm>(`/kefuapi/order/edit/${id}`),
  updateOrder: (id: number, input: Record<string, string>) =>
    apiRequest<KefuOrderEditResult>(`/kefuapi/order/update/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  updateOrderRemark: (orderId: string, remark: string) =>
    apiRequest<KefuRemarkResult>("/kefuapi/order/remark", {
      method: "POST",
      body: JSON.stringify({ order_id: orderId, remark }),
    }),
  expressOptions: () => apiRequest<KefuExpressOption[]>("/kefuapi/order/export?status=1"),
  deliveryAgents: () => apiRequest<KefuDeliveryAgent[]>("/kefuapi/order/delivery_all?limit=100"),
  splitCartInfo: (id: number) => apiRequest<KefuSplitCartItem[]>(`/kefuapi/order/split_cart_info/${id}`),
  deliverOrder: (id: number, input: Record<string, unknown>) =>
    apiRequest<KefuFulfillmentResult>(`/kefuapi/order/delivery/${id}`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  splitDelivery: (id: number, input: Record<string, unknown>) =>
    apiRequest<KefuFulfillmentResult>(`/kefuapi/order/split_delivery/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  writeoffCartInfo: (id: number) =>
    apiRequest<KefuWriteoffInfo>(`/kefuapi/order/writeOff/cartInfo${queryString({ oid: id })}`),
  writeoffOrder: (orderId: string, cartIds: Array<{ cart_id: string; cart_num: number }>) =>
    apiRequest<KefuWriteoffResult>(`/kefuapi/order/write_update/${encodeURIComponent(orderId)}`, {
      method: "PUT",
      body: JSON.stringify({ cart_ids: cartIds }),
    }),
  orderRefundForm: (id: number) => apiRequest<KefuManagementForm>(`/kefuapi/order/refund_form/${id}`),
  refundDetail: (id: number) => apiRequest<KefuRefundDetail>(`/kefuapi/order/refund/detail/${id}`),
  refundList: (input: { order_id?: string; time?: string; refund_type?: number; page?: number; limit?: number } = {}) =>
    apiRequest<KefuRefundListResult>(`/kefuapi/refund/list${queryString(input)}`),
  updateRefundRemark: (id: number, remark: string) =>
    apiRequest<KefuRemarkResult>(`/kefuapi/refund/remark/${id}`, {
      method: "POST",
      body: JSON.stringify({ remark }),
    }),
  refundForm: (id: number) => apiRequest<KefuManagementForm>(`/kefuapi/refund/refund/${id}`),
  speechcraftCategories: (type: 0 | 1) =>
    apiRequest<SpeechcraftCategory[]>(`/kefuapi/service/cate${queryString({ type })}`),
  speechcraft: (type: 0 | 1, input: { cate_id?: number; title?: string; page?: number; limit?: number } = {}) =>
    apiRequest<Speechcraft[]>(`/kefuapi/service/speechcraft${queryString({ type, ...input })}`),
  createSpeechcraft: (input: { cate_id: number; title: string; message: string; sort?: number }) =>
    apiRequest<{ id: number }>("/kefuapi/service/speechcraft", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteSpeechcraft: (id: number) =>
    apiRequest<null>(`/kefuapi/service/speechcraft/${id}`, { method: "DELETE" }),
  createSpeechcraftCategory: (name: string, sort = 0) =>
    apiRequest<{ id: number }>("/kefuapi/service/cate", {
      method: "POST",
      body: JSON.stringify({ name, sort }),
    }),
};
