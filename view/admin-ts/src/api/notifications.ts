import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export type NotificationMark =
  | "order_postage_success"
  | "order_deliver_success"
  | "order_fictitious_success"
  | "send_order_refund_no_status";
export type ProviderTemplateType = "wechat" | "routine";
export type NotificationDeliveryChannel =
  | "sms"
  | "wechat_official"
  | "wechat_routine"
  | "wechat_shipping";
export type NotificationDeliveryStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "RETRYABLE"
  | "SENT"
  | "SKIPPED"
  | "UNKNOWN"
  | "DEAD";
export type NotificationDeliveryActionType =
  | "CONFIRM_SENT"
  | "CONFIRM_RETRY"
  | "CLOSE_NO_RETRY";

export interface NotificationTemplateItem {
  id: number;
  title: string;
  content: string | null;
  type: string;
  mark: string;
  status: number;
  addTime: number;
  legacyType: number;
  example: string;
  tempid: string;
}

export interface NotificationTemplateInput {
  id?: number;
  title: string;
  content: string;
  type: ProviderTemplateType;
  mark: string;
  tempid: string;
  example: string;
  status: number;
}

export interface OrderNotificationConfigItem {
  mark: NotificationMark;
  label: string;
  exists: boolean;
  ambiguous: boolean;
  rowCount: number;
  id: number;
  name: string;
  title: string;
  isSystem: boolean;
  isSms: boolean;
  isWechat: boolean;
  isRoutine: boolean;
  systemTitle: string;
  systemText: string;
  smsId: string;
  smsText: string;
  url: string;
  officialAllowed: boolean;
  routineAllowed: boolean;
  templateCount: number;
  enabledTemplateCount: number;
}

export interface NotificationReadiness {
  sms: {
    accessKeyIdConfigured: boolean;
    accessKeySecretConfigured: boolean;
    signNameConfigured: boolean;
    regionConfigured: boolean;
    verificationTemplateConfigured: boolean;
    verificationCacheConfigured: boolean;
  };
  wechat: {
    officialAppIdConfigured: boolean;
    officialSecretConfigured: boolean;
    routineAppIdConfigured: boolean;
    routineSecretConfigured: boolean;
    merchantIdConfigured: boolean;
    identityRows: number;
  };
  shipping: { enabled: boolean; configRows: number };
  site: { urlConfigured: boolean; urlRows: number };
  catalog: { notificationRows: number; templateRows: number };
  deliveries: NotificationDeliverySummary;
  secretPolicy: string;
}

export interface NotificationDeliverySummary {
  pending: number;
  sent: number;
  unknown: number;
  dead: number;
  skipped: number;
}

export interface NotificationDeliveryItem {
  id: number;
  outboxId: number;
  eventKey: string;
  orderId: number;
  userId: number;
  noticeMark: string;
  channel: NotificationDeliveryChannel;
  maskedTarget: string;
  templateCode: string;
  status: NotificationDeliveryStatus;
  dispatchCount: number;
  attemptCount: number;
  replayCount: number;
  availableTime: number;
  leaseUntil: number;
  providerReference: string;
  providerRequestId: string;
  responseCode: string;
  lastError: string;
  sentTime: number;
  addTime: number;
  updateTime: number;
}

export interface NotificationDeliveryActionItem {
  id: number;
  deliveryId: number;
  requestKey: string;
  action: NotificationDeliveryActionType;
  previousStatus: NotificationDeliveryStatus;
  nextStatus: NotificationDeliveryStatus;
  adminId: number;
  reason: string;
  providerReference: string;
  addTime: number;
}

export interface NotificationDeliveryListResult {
  list: NotificationDeliveryItem[];
  next_cursor: number | null;
  summary: NotificationDeliverySummary;
}

const now = Math.floor(Date.now() / 1_000);
let previewShippingEnabled = false;
const previewConfigs: OrderNotificationConfigItem[] = [
  {
    mark: "order_postage_success",
    label: "快递发货成功",
    exists: true,
    ambiguous: false,
    rowCount: 1,
    id: 101,
    name: "快递发货成功",
    title: "订单已发货",
    isSystem: true,
    isSms: true,
    isWechat: true,
    isRoutine: true,
    systemTitle: "订单已发货",
    systemText: "您的订单 {order_id} 已由 {delivery_name} 发出",
    smsId: "SMS_ORDER_SENT",
    smsText: "",
    url: "",
    officialAllowed: true,
    routineAllowed: true,
    templateCount: 2,
    enabledTemplateCount: 2,
  },
  {
    mark: "order_deliver_success",
    label: "平台配送成功",
    exists: true,
    ambiguous: false,
    rowCount: 1,
    id: 102,
    name: "平台配送成功",
    title: "订单开始配送",
    isSystem: true,
    isSms: true,
    isWechat: false,
    isRoutine: true,
    systemTitle: "订单开始配送",
    systemText: "您的订单 {order_id} 正在配送",
    smsId: "SMS_ORDER_DELIVERY",
    smsText: "",
    url: "",
    officialAllowed: false,
    routineAllowed: true,
    templateCount: 1,
    enabledTemplateCount: 1,
  },
  {
    mark: "order_fictitious_success",
    label: "虚拟交付成功",
    exists: false,
    ambiguous: false,
    rowCount: 0,
    id: 0,
    name: "虚拟交付成功",
    title: "虚拟商品已交付",
    isSystem: false,
    isSms: false,
    isWechat: false,
    isRoutine: false,
    systemTitle: "",
    systemText: "",
    smsId: "",
    smsText: "",
    url: "",
    officialAllowed: false,
    routineAllowed: false,
    templateCount: 0,
    enabledTemplateCount: 0,
  },
  {
    mark: "send_order_refund_no_status",
    label: "退款申请未通过",
    exists: false,
    ambiguous: false,
    rowCount: 0,
    id: 0,
    name: "退款申请未通过",
    title: "退款申请未通过",
    isSystem: false,
    isSms: false,
    isWechat: false,
    isRoutine: false,
    systemTitle: "",
    systemText: "",
    smsId: "",
    smsText: "",
    url: "",
    officialAllowed: true,
    routineAllowed: true,
    templateCount: 0,
    enabledTemplateCount: 0,
  },
];
const previewTemplates: NotificationTemplateItem[] = [
  { id: 1, title: "快递发货公众号模板", content: "thing1/order_number2", type: "wechat", mark: "order_postage_success", status: 1, addTime: now - 9000, legacyType: 1, example: "订单已发货", tempid: "official-template-audit" },
  { id: 2, title: "快递发货小程序模板", content: "thing1/character_string2", type: "routine", mark: "order_postage_success", status: 1, addTime: now - 8800, legacyType: 0, example: "订单已发货", tempid: "routine-template-audit" },
];
const previewDeliveries: NotificationDeliveryItem[] = [
  { id: 9204, outboxId: 8104, eventKey: "order.delivery.notice:28104", orderId: 28104, userId: 104, noticeMark: "order_postage_success", channel: "sms", maskedTarget: "138****8000", templateCode: "SMS_ORDER_SENT", status: "UNKNOWN", dispatchCount: 1, attemptCount: 1, replayCount: 0, availableTime: 0, leaseUntil: 0, providerReference: "", providerRequestId: "", responseCode: "", lastError: "provider_result_unknown_after_network_disconnect", sentTime: 0, addTime: now - 7200, updateTime: now - 7100 },
  { id: 9203, outboxId: 8103, eventKey: "order.delivery.notice:28103", orderId: 28103, userId: 103, noticeMark: "order_postage_success", channel: "wechat_routine", maskedTarget: "oABC…P9xy", templateCode: "routine-template-audit", status: "SENT", dispatchCount: 1, attemptCount: 1, replayCount: 0, availableTime: 0, leaseUntil: 0, providerReference: "audit-msg", providerRequestId: "", responseCode: "0", lastError: "", sentTime: now - 3600, addTime: now - 3650, updateTime: now - 3600 },
  { id: 9202, outboxId: 8102, eventKey: "order.refund.refused.notice:4412", orderId: 28102, userId: 102, noticeMark: "send_order_refund_no_status", channel: "wechat_official", maskedTarget: "oDEF…R8uv", templateCode: "official-refund-audit", status: "DEAD", dispatchCount: 2, attemptCount: 2, replayCount: 1, availableTime: 0, leaseUntil: 0, providerReference: "", providerRequestId: "", responseCode: "40037", lastError: "Provider rejected request: 40037", sentTime: 0, addTime: now - 5400, updateTime: now - 5000 },
];
const previewActions: NotificationDeliveryActionItem[] = [];

function deliverySummary(): NotificationDeliverySummary {
  return {
    pending: previewDeliveries.filter((row) => ["PENDING", "ENQUEUING", "ENQUEUED", "PROCESSING", "RETRYABLE"].includes(row.status)).length,
    sent: previewDeliveries.filter((row) => row.status === "SENT").length,
    unknown: previewDeliveries.filter((row) => row.status === "UNKNOWN").length,
    dead: previewDeliveries.filter((row) => row.status === "DEAD").length,
    skipped: previewDeliveries.filter((row) => row.status === "SKIPPED").length,
  };
}

export async function apiNotificationTemplates(): Promise<NotificationTemplateItem[]> {
  if (previewMode) return previewTemplates.map((row) => ({ ...row }));
  return getData(request.get<NotificationTemplateItem[]>("/notification/list"));
}

export async function apiSaveNotificationTemplate(input: NotificationTemplateInput) {
  if (previewMode) {
    const id = input.id ?? Math.max(0, ...previewTemplates.map((row) => row.id)) + 1;
    const row: NotificationTemplateItem = {
      ...input,
      id,
      addTime: now,
      legacyType: input.type === "routine" ? 0 : 1,
    };
    const index = previewTemplates.findIndex((item) => item.id === id);
    if (index >= 0) previewTemplates[index] = row;
    else previewTemplates.push(row);
    return { ...row };
  }
  return getData<NotificationTemplateItem>(request.post("/notification/save", input));
}

export async function apiOrderNotificationConfigs(): Promise<OrderNotificationConfigItem[]> {
  if (previewMode) return previewConfigs.map((row) => ({ ...row }));
  return getData(request.get<OrderNotificationConfigItem[]>("/notification/order-config"));
}

export async function apiSaveOrderNotificationConfig(mark: NotificationMark, input: Omit<OrderNotificationConfigItem, "mark" | "label" | "exists" | "ambiguous" | "rowCount" | "id" | "officialAllowed" | "routineAllowed" | "templateCount" | "enabledTemplateCount">) {
  if (previewMode) {
    const row = previewConfigs.find((item) => item.mark === mark);
    if (!row) throw new Error("通知配置不存在");
    Object.assign(row, input, { exists: true, rowCount: 1 });
    return { ...row };
  }
  return getData(request.put(`/notification/order-config/${encodeURIComponent(mark)}`, input));
}

export async function apiNotificationReadiness(): Promise<NotificationReadiness> {
  if (previewMode) {
    return {
      sms: { accessKeyIdConfigured: false, accessKeySecretConfigured: false, signNameConfigured: false, regionConfigured: false, verificationTemplateConfigured: false, verificationCacheConfigured: true },
      wechat: { officialAppIdConfigured: false, officialSecretConfigured: false, routineAppIdConfigured: false, routineSecretConfigured: false, merchantIdConfigured: false, identityRows: 0 },
      shipping: { enabled: previewShippingEnabled, configRows: previewShippingEnabled ? 1 : 0 },
      site: { urlConfigured: true, urlRows: 5 },
      catalog: { notificationRows: previewConfigs.filter((row) => row.exists).length, templateRows: previewTemplates.length },
      deliveries: deliverySummary(),
      secretPolicy: "Worker secrets are never returned or written through this API",
    };
  }
  return getData(request.get<NotificationReadiness>("/notification/readiness"));
}

export async function apiSaveNotificationShipping(enabled: boolean) {
  if (previewMode) {
    previewShippingEnabled = enabled;
    return { enabled };
  }
  return getData<{ enabled: boolean }>(request.put("/notification/shipping", { enabled }));
}

export async function apiNotificationDeliveries(params: {
  status?: NotificationDeliveryStatus;
  channel?: NotificationDeliveryChannel;
  event_key?: string;
  after_id?: number;
  limit?: number;
}): Promise<NotificationDeliveryListResult> {
  if (previewMode) {
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const rows = previewDeliveries
      .filter((row) => !params.status || row.status === params.status)
      .filter((row) => !params.channel || row.channel === params.channel)
      .filter((row) => !params.event_key || row.eventKey === params.event_key)
      .filter((row) => !params.after_id || row.id < params.after_id)
      .sort((left, right) => right.id - left.id);
    const list = rows.slice(0, limit).map((row) => ({ ...row }));
    return { list, next_cursor: rows.length > limit ? list.at(-1)?.id ?? null : null, summary: deliverySummary() };
  }
  return getData(request.get<NotificationDeliveryListResult>("/notification/deliveries", {
    params: params as Record<string, unknown>,
  }));
}

export async function apiNotificationDeliveryActions(id: number) {
  if (previewMode) return previewActions.filter((row) => row.deliveryId === id).map((row) => ({ ...row }));
  return getData<NotificationDeliveryActionItem[]>(request.get(`/notification/deliveries/${id}/actions`));
}

export async function apiOperateNotificationDelivery(
  id: number,
  action: "confirm-sent" | "confirm-retry" | "close",
  input: { request_key: string; reason: string; provider_reference?: string; confirm: string },
) {
  if (previewMode) {
    const row = previewDeliveries.find((item) => item.id === id);
    if (!row) throw new Error("投递记录不存在");
    const previousStatus = row.status;
    const nextStatus: NotificationDeliveryStatus = action === "confirm-sent"
      ? "SENT"
      : action === "confirm-retry"
        ? "RETRYABLE"
        : "DEAD";
    row.status = nextStatus;
    row.updateTime = now;
    if (action === "confirm-retry") row.replayCount += 1;
    if (action === "confirm-sent") row.sentTime = now;
    previewActions.unshift({
      id: previewActions.length + 1,
      deliveryId: id,
      requestKey: input.request_key,
      action: action === "confirm-sent" ? "CONFIRM_SENT" : action === "confirm-retry" ? "CONFIRM_RETRY" : "CLOSE_NO_RETRY",
      previousStatus,
      nextStatus,
      adminId: 1,
      reason: input.reason,
      providerReference: input.provider_reference ?? "",
      addTime: now,
    });
    return { duplicate: false, delivery: { ...row } };
  }
  return getData<{ duplicate: boolean; delivery: NotificationDeliveryItem }>(
    request.post(`/notification/deliveries/${id}/${action}`, input),
  );
}
