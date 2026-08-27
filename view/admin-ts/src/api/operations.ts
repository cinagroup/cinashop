import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export type OrderOutboxStatus =
  | "PENDING"
  | "ENQUEUING"
  | "ENQUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "DEAD";

export interface OrderOutboxItem {
  id: number;
  eventKey: string;
  aggregateType: string;
  aggregateId: number;
  eventType: string;
  payload: { orderId: number; orderNo: string };
  status: OrderOutboxStatus;
  dispatchCount: number;
  attemptCount: number;
  replayCount: number;
  availableTime: number;
  leaseUntil: number;
  leaseToken: string;
  lastError: string;
  enqueuedTime: number;
  processedTime: number;
  addTime: number;
  updateTime: number;
}

export interface OrderOutboxListResult {
  list: OrderOutboxItem[];
  next_cursor: number | null;
}

export interface OrderOutboxReplayResult {
  claimed: number;
  enqueued: number;
}

const now = Math.floor(Date.now() / 1000);
const previewOrderOutbox: OrderOutboxItem[] = [
  {
    id: 4108,
    eventKey: "order.paid:28108",
    aggregateType: "order",
    aggregateId: 28108,
    eventType: "order.paid",
    payload: { orderId: 28108, orderNo: "wx202608090018" },
    status: "DEAD",
    dispatchCount: 9,
    attemptCount: 8,
    replayCount: 0,
    availableTime: 0,
    leaseUntil: 0,
    leaseToken: "",
    lastError: "推广用户账户不存在，事务已回滚；达到最大重试次数",
    enqueuedTime: now - 2700,
    processedTime: 0,
    addTime: now - 3600,
    updateTime: now - 900,
  },
  {
    id: 4107,
    eventKey: "order.paid:28107",
    aggregateType: "order",
    aggregateId: 28107,
    eventType: "order.paid",
    payload: { orderId: 28107, orderNo: "ali202608090017" },
    status: "FAILED",
    dispatchCount: 3,
    attemptCount: 3,
    replayCount: 1,
    availableTime: now + 120,
    leaseUntil: 0,
    leaseToken: "",
    lastError: "PostgreSQL connection reset during post-payment transaction",
    enqueuedTime: now - 760,
    processedTime: 0,
    addTime: now - 980,
    updateTime: now - 60,
  },
  {
    id: 4106,
    eventKey: "order.paid:28106",
    aggregateType: "order",
    aggregateId: 28106,
    eventType: "order.paid",
    payload: { orderId: 28106, orderNo: "yue202608090016" },
    status: "ENQUEUED",
    dispatchCount: 1,
    attemptCount: 0,
    replayCount: 0,
    availableTime: now - 300,
    leaseUntil: now + 300,
    leaseToken: "",
    lastError: "",
    enqueuedTime: now - 25,
    processedTime: 0,
    addTime: now - 40,
    updateTime: now - 25,
  },
  {
    id: 4105,
    eventKey: "order.paid:28105",
    aggregateType: "order",
    aggregateId: 28105,
    eventType: "order.paid",
    payload: { orderId: 28105, orderNo: "wx202608090015" },
    status: "COMPLETED",
    dispatchCount: 1,
    attemptCount: 1,
    replayCount: 0,
    availableTime: now - 520,
    leaseUntil: 0,
    leaseToken: "",
    lastError: "",
    enqueuedTime: now - 500,
    processedTime: now - 480,
    addTime: now - 530,
    updateTime: now - 480,
  },
];

export async function apiAdminOrderOutboxList(params: {
  status?: OrderOutboxStatus;
  after_id?: number;
  limit?: number;
}): Promise<OrderOutboxListResult> {
  if (previewMode) {
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const filtered = previewOrderOutbox
      .filter((row) => !params.status || row.status === params.status)
      .filter((row) => !params.after_id || row.id < params.after_id)
      .sort((a, b) => b.id - a.id);
    const list = filtered.slice(0, limit).map((row) => ({ ...row, payload: { ...row.payload } }));
    return {
      list,
      next_cursor: filtered.length > limit ? list.at(-1)?.id ?? null : null,
    };
  }
  return getData(
    request.get<OrderOutboxListResult>("/order/outbox", {
      params: params as Record<string, unknown>,
    }),
  );
}

export async function apiAdminOrderOutboxReplay(id: number): Promise<OrderOutboxReplayResult> {
  if (previewMode) {
    const row = previewOrderOutbox.find((item) => item.id === id);
    if (!row) throw new Error("outbox 事件不存在");
    if (row.status === "COMPLETED") throw new Error("已完成事件不能重放");
    row.status = "ENQUEUED";
    row.attemptCount = 0;
    row.replayCount += 1;
    row.dispatchCount += 1;
    row.availableTime = now;
    row.leaseUntil = now + 600;
    row.lastError = "";
    row.enqueuedTime = now;
    row.updateTime = now;
    return { claimed: 1, enqueued: 1 };
  }
  return getData(request.post<OrderOutboxReplayResult>(`/order/outbox/${id}/replay`));
}

export type QueueDeadLetterStatus = "OPEN" | "REPLAYING" | "REPLAYED" | "RESOLVED";
export type QueueDeadLetterReplayPolicy = "ALLOW" | "BLOCK_SENSITIVE" | "BLOCK_UNSUPPORTED";

export interface QueueDeadLetterItem {
  id: number;
  queueName: string;
  messageId: string;
  messageTimestampMs: number;
  dlqAttempts: number;
  messageType: string;
  body: unknown;
  bodySha256: string;
  replayPolicy: QueueDeadLetterReplayPolicy;
  status: QueueDeadLetterStatus;
  occurrenceCount: number;
  replayCount: number;
  firstSeenTime: number;
  lastSeenTime: number;
  replayRequestedTime: number;
  replayedTime: number;
  resolvedTime: number;
  replayLeaseUntil: number;
  replayRequestedBy: number;
  resolvedBy: number;
  replayReason: string;
  resolutionReason: string;
  lastError: string;
  addTime: number;
  updateTime: number;
}

export interface QueueDeadLetterAlertSummary {
  openCount: number;
  replayingCount: number;
  blockedCount: number;
  oldestOpenTime: number;
}

export interface QueueDeadLetterListResult {
  list: QueueDeadLetterItem[];
  nextAfterId: number | null;
  alert: QueueDeadLetterAlertSummary;
}

const previewQueueDeadLetters: QueueDeadLetterItem[] = [
  {
    id: 7304,
    queueName: "cinashop-order-dlq",
    messageId: "9fbd8905e0f6477fa9186ced5e707304",
    messageTimestampMs: (now - 5_400) * 1_000,
    dlqAttempts: 1,
    messageType: "processOrderPaidOutbox",
    body: { action: "processOrderPaidOutbox", outboxId: 4108, eventKey: "order.paid:28108" },
    bodySha256: "debd94fa728cc7f1d41709df26c9e69ed83bf2ea70d6dc3a2f0f84c8a6de7304",
    replayPolicy: "ALLOW",
    status: "OPEN",
    occurrenceCount: 2,
    replayCount: 0,
    firstSeenTime: now - 5_200,
    lastSeenTime: now - 4_800,
    replayRequestedTime: 0,
    replayedTime: 0,
    resolvedTime: 0,
    replayLeaseUntil: 0,
    replayRequestedBy: 0,
    resolvedBy: 0,
    replayReason: "",
    resolutionReason: "",
    lastError: "PostgreSQL transaction failed after the final Queue retry",
    addTime: now - 5_200,
    updateTime: now - 4_800,
  },
  {
    id: 7303,
    queueName: "cinashop-order-dlq",
    messageId: "bf120a516c004c2a9851036ff0167303",
    messageTimestampMs: (now - 3_800) * 1_000,
    dlqAttempts: 1,
    messageType: "sendSmsVerification",
    body: {
      action: "sendSmsVerification",
      recordId: 211,
      phone: "138****8000",
      code: "[REDACTED]",
      templateCode: "[REDACTED]",
    },
    bodySha256: "9a3de38cde8fd2b811ced3450ccb50825751325a0ff3df3bfb68c3f0a9787303",
    replayPolicy: "BLOCK_SENSITIVE",
    status: "OPEN",
    occurrenceCount: 1,
    replayCount: 0,
    firstSeenTime: now - 3_700,
    lastSeenTime: now - 3_700,
    replayRequestedTime: 0,
    replayedTime: 0,
    resolvedTime: 0,
    replayLeaseUntil: 0,
    replayRequestedBy: 0,
    resolvedBy: 0,
    replayReason: "",
    resolutionReason: "",
    lastError: "Aliyun request timed out after the final retry",
    addTime: now - 3_700,
    updateTime: now - 3_700,
  },
  {
    id: 7302,
    queueName: "cinashop-order-dlq",
    messageId: "0f933ba9684142b9b78c489daf4b7302",
    messageTimestampMs: (now - 2_100) * 1_000,
    dlqAttempts: 1,
    messageType: "cancelOrder",
    body: { action: "cancelOrder", orderId: "wx-legacy-28", uid: 3 },
    bodySha256: "86af131634acc72bbd7839c9da54c2b51115df87dd957cbba7a3882b61577302",
    replayPolicy: "BLOCK_UNSUPPORTED",
    status: "RESOLVED",
    occurrenceCount: 1,
    replayCount: 0,
    firstSeenTime: now - 2_000,
    lastSeenTime: now - 2_000,
    replayRequestedTime: 0,
    replayedTime: 0,
    resolvedTime: now - 1_500,
    replayLeaseUntil: 0,
    replayRequestedBy: 0,
    resolvedBy: 1,
    replayReason: "",
    resolutionReason: "旧版动作没有可验证的幂等消费者，已转人工核对",
    lastError: "Legacy message type is no longer supported",
    addTime: now - 2_000,
    updateTime: now - 1_500,
  },
  {
    id: 7301,
    queueName: "cinashop-order-dlq",
    messageId: "e94dc02abc294ec0ab277a2444027301",
    messageTimestampMs: (now - 900) * 1_000,
    dlqAttempts: 1,
    messageType: "deleteAttachmentObjects",
    body: {
      action: "deleteAttachmentObjects",
      keys: ["attachments/admin/1/2026/08/ab2b51dc-5670-4daf-ac1b-fbcb86fd7301.png"],
    },
    bodySha256: "ff2f86b734bf935e7bdf9a9a6016500c6e3e86d25382d409ccb458558faa7301",
    replayPolicy: "ALLOW",
    status: "REPLAYED",
    occurrenceCount: 1,
    replayCount: 1,
    firstSeenTime: now - 820,
    lastSeenTime: now - 820,
    replayRequestedTime: now - 420,
    replayedTime: now - 415,
    resolvedTime: 0,
    replayLeaseUntil: 0,
    replayRequestedBy: 1,
    resolvedBy: 0,
    replayReason: "对象存储凭据已恢复，确认重新执行附件清理",
    resolutionReason: "",
    lastError: "",
    addTime: now - 820,
    updateTime: now - 415,
  },
];

function cloneDeadLetter(row: QueueDeadLetterItem): QueueDeadLetterItem {
  return { ...row, body: JSON.parse(JSON.stringify(row.body)) as unknown };
}

function previewDeadLetterAlert(): QueueDeadLetterAlertSummary {
  const open = previewQueueDeadLetters.filter((row) => row.status === "OPEN");
  return {
    openCount: open.length,
    replayingCount: previewQueueDeadLetters.filter((row) => row.status === "REPLAYING").length,
    blockedCount: open.filter((row) => row.replayPolicy !== "ALLOW").length,
    oldestOpenTime: open.length ? Math.min(...open.map((row) => row.firstSeenTime)) : 0,
  };
}

export async function apiAdminQueueDeadLetterList(params: {
  status?: QueueDeadLetterStatus;
  message_type?: string;
  after_id?: number;
  limit?: number;
}): Promise<QueueDeadLetterListResult> {
  if (previewMode) {
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const filtered = previewQueueDeadLetters
      .filter((row) => !params.status || row.status === params.status)
      .filter((row) => !params.message_type || row.messageType === params.message_type)
      .filter((row) => !params.after_id || row.id < params.after_id)
      .sort((a, b) => b.id - a.id);
    const list = filtered.slice(0, limit).map(cloneDeadLetter);
    return {
      list,
      nextAfterId: filtered.length > limit ? list.at(-1)?.id ?? null : null,
      alert: previewDeadLetterAlert(),
    };
  }
  return getData(
    request.get<QueueDeadLetterListResult>("/order/outbox/dead-letter", {
      params: params as Record<string, unknown>,
    }),
  );
}

export async function apiAdminQueueDeadLetterReplay(
  id: number,
  reason: string,
): Promise<QueueDeadLetterItem> {
  if (previewMode) {
    const row = previewQueueDeadLetters.find((item) => item.id === id);
    if (!row) throw new Error("死信记录不存在");
    if (row.status !== "OPEN" || row.replayPolicy !== "ALLOW") throw new Error("该死信不能重放");
    row.status = "REPLAYED";
    row.replayCount += 1;
    row.replayRequestedTime = now;
    row.replayedTime = now;
    row.replayRequestedBy = 1;
    row.replayReason = reason;
    row.lastError = "";
    row.updateTime = now;
    return cloneDeadLetter(row);
  }
  return getData(request.post<QueueDeadLetterItem>(`/order/outbox/dead-letter/${id}/replay`, {
    confirm: "REPLAY_DEAD_LETTER",
    reason,
  }));
}

export async function apiAdminQueueDeadLetterResolve(
  id: number,
  reason: string,
): Promise<QueueDeadLetterItem> {
  if (previewMode) {
    const row = previewQueueDeadLetters.find((item) => item.id === id);
    if (!row) throw new Error("死信记录不存在");
    if (row.status !== "OPEN") throw new Error("该死信不能标记解决");
    row.status = "RESOLVED";
    row.resolvedTime = now;
    row.resolvedBy = 1;
    row.resolutionReason = reason;
    row.updateTime = now;
    return cloneDeadLetter(row);
  }
  return getData(request.post<QueueDeadLetterItem>(`/order/outbox/dead-letter/${id}/resolve`, {
    confirm: "RESOLVE_DEAD_LETTER",
    reason,
  }));
}
