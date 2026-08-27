import { eq, inArray, sql } from "drizzle-orm";
import type { Env, OrderNotificationOutboxMessage, OrderMessage } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderOutbox,
  orderNotificationDelivery,
  notificationTemplate,
  storeOrderRefund,
  storeOrderStatus,
  systemConfig,
  systemMessage,
  systemNotification,
  user,
  wechatUser,
} from "@/models/schema";
import {
  enqueueOrderDeliveryNoticeEvent,
  ORDER_DELIVERY_NOTICE_EVENT,
  ORDER_REFUND_REFUSED_NOTICE_EVENT,
} from "@/services/order/OrderNotificationOutboxService";
import { OrderOutboxService } from "@/services/order/OrderOutboxService";
import {
  isOrderNotificationDeliveryMessage,
  OrderNotificationDeliveryService,
} from "@/services/order/OrderNotificationDeliveryService";
import { OrderNotificationAdminService } from "@/services/order/OrderNotificationAdminService";
import { StoreOrderRefundService } from "@/services/order/StoreOrderRefundService";
import { SupplierFulfillmentService } from "@/services/supplier/SupplierFulfillmentService";

const TABLES = [
  "user",
  "store_order",
  "store_order_cart_info",
  "store_order_refund",
  "store_order_refund_payment",
  "store_order_status",
  "store_order_outbox",
  "order_notification_delivery",
  "order_notification_delivery_action",
  "notification_template",
  "system_config",
  "system_notification",
  "system_message",
  "wechat_user",
] as const;

const SERIAL_COLUMNS: Partial<Record<(typeof TABLES)[number], string>> = {
  user: "uid",
  store_order: "id",
  store_order_cart_info: "id",
  store_order_refund: "id",
  store_order_refund_payment: "id",
  store_order_status: "id",
  store_order_outbox: "id",
  order_notification_delivery: "id",
  order_notification_delivery_action: "id",
  notification_template: "id",
  system_config: "id",
  system_notification: "id",
  system_message: "id",
  wechat_user: "id",
};

interface Fingerprint {
  tables: Record<string, { count: string; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface OrderNotificationOutboxPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  business_transaction: Record<string, boolean | number>;
  consumption: Record<string, boolean | number | number[]>;
  operations: Record<string, boolean | number>;
  templates: Array<{ mark: string; rows: number; system_enabled: number }>;
}

function assertCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Order notification outbox integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_order_notice_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  const sequences: Fingerprint["sequences"] = {};
  for (const table of TABLES) {
    const rows = await db.$client.unsafe<Array<{ count: string; digest: string }>>(
      `SELECT count(*)::text AS count,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY to_jsonb(t)::text), '')) AS digest
       FROM public.${identifier(table)} t`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
    const column = SERIAL_COLUMNS[table];
    if (!column) continue;
    const sequenceRows = await db.$client<{ sequence_name: string | null }[]>`
      SELECT pg_get_serial_sequence(${`public.${table}`}, ${column}) AS sequence_name
    `;
    const sequenceName = sequenceRows[0]?.sequence_name?.split(".").at(-1) ?? null;
    if (!sequenceName) {
      sequences[table] = null;
      continue;
    }
    const valueRows = await db.$client<{ value: string | null }[]>`
      SELECT last_value::text AS value FROM pg_sequences
      WHERE schemaname = 'public' AND sequencename = ${sequenceName}
    `;
    sequences[table] = valueRows[0]?.value ?? null;
  }
  return { tables, sequences };
}

async function setupSchema(db: DbClient, name: string): Promise<void> {
  const schema = identifier(name);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      const tableName = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      const column = SERIAL_COLUMNS[table];
      if (!column) continue;
      const sequence = `${table}_audit_seq`;
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequence)} START WITH 1800000000`);
      await tx.unsafe(`ALTER SEQUENCE ${schema}.${identifier(sequence)} OWNED BY ${schema}.${tableName}.${identifier(column)}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN ${identifier(column)} SET DEFAULT nextval('${name}.${sequence}'::regclass)`,
      );
    }
  });
}

async function seed(container: Container, base: number): Promise<{
  delivery: number;
  deliveryRollback: number;
  refusal: number;
  refusalRollback: number;
  disabled: number;
  refunds: [number, number];
}> {
  const now = Math.floor(Date.now() / 1_000);
  const uid = base + 100;
  const delivery = base + 1;
  const deliveryRollback = base + 2;
  const refusal = base + 3;
  const refusalRollback = base + 4;
  const disabled = base + 5;
  const refundIds: [number, number] = [base + 201, base + 202];
  await container.db.insert(user).values({
    uid,
    account: `notice-audit-${base}`.slice(0, 32),
    nickname: "通知审计用户",
    phone: "13800000000",
    status: 1,
    isDel: 0,
    addTime: now,
  });
  const common = {
    uid,
    supplierId: 5,
    storeId: 0,
    paid: 1,
    shippingType: 1,
    totalNum: 1,
    totalPrice: "19.90",
    payPrice: "19.90",
    userAddress: "Singapore audit address",
    userPhone: "13800000000",
    realName: "通知审计用户",
    isDel: 0,
    isSystemDel: 0,
    addTime: now,
  } as const;
  await container.db.insert(storeOrder).values([
    { ...common, id: delivery, orderId: `NOD${delivery}`, unique: `notice-${delivery}`, status: 0,
      isChannel: 1, payType: "weixin", tradeNo: `WX${delivery}` },
    { ...common, id: deliveryRollback, orderId: `NOD${deliveryRollback}`, unique: `notice-${deliveryRollback}`, status: 0,
      isChannel: 1, payType: "weixin", tradeNo: `WX${deliveryRollback}` },
    { ...common, id: refusal, orderId: `NOR${refusal}`, unique: `notice-${refusal}`, status: 1, refundStatus: 1, refundType: 2 },
    { ...common, id: refusalRollback, orderId: `NOR${refusalRollback}`, unique: `notice-${refusalRollback}`, status: 1, refundStatus: 1, refundType: 2 },
    { ...common, id: disabled, orderId: `NOD${disabled}`, unique: `notice-${disabled}`, status: 1,
      deliveryType: "send", isChannel: 1, payType: "weixin", tradeNo: `WX${disabled}` },
  ]);
  await container.db.insert(storeOrderCartInfo).values(
    [delivery, deliveryRollback, refusal, refusalRollback, disabled].map((orderId, index) => ({
      id: base + 300 + index,
      uid,
      oid: orderId,
      cartId: String(base + 400 + index),
      productId: base + 500 + index,
      cartNum: 1,
      surplusNum: 1,
      splitSurplusNum: 1,
      unique: `n${index}`,
      cartInfo: JSON.stringify({ productInfo: { store_name: `审计商品${index + 1}` } }),
      addTime: now,
    })),
  );
  await container.db.insert(storeOrderRefund).values([
    {
      id: refundIds[0], storeOrderId: refusal, orderId: `RF${refundIds[0]}`, storeId: 0,
      uid, supplierId: 5, applyType: 2, applyPrice: "19.90", refundType: 2,
      refundNum: 1, refundPrice: "19.90", refundedPrice: "0.00", refundReason: "audit",
      isCancel: 0, isDel: 0, addTime: now,
    },
    {
      id: refundIds[1], storeOrderId: refusalRollback, orderId: `RF${refundIds[1]}`, storeId: 0,
      uid, supplierId: 5, applyType: 2, applyPrice: "19.90", refundType: 2,
      refundNum: 1, refundPrice: "19.90", refundedPrice: "0.00", refundReason: "audit",
      isCancel: 0, isDel: 0, addTime: now,
    },
  ]);
  await container.db.insert(systemNotification).values([
    {
      id: base + 600, mark: "order_postage_success", name: "快递通知", isSystem: 1,
      isSms: 1, isWechat: 1, isRoutine: 1, smsId: "SMS_AUDIT_DELIVERY",
      systemTitle: "订单{order_id}已发货",
      systemText: "{nickname}|{store_name}|{delivery_name}|{delivery_id}|{user_address}",
      addTime: now,
    },
    {
      id: base + 601, mark: "send_order_refund_no_status", name: "售后拒绝", isSystem: 1,
      isSms: 1, isWechat: 1, isRoutine: 1, smsId: "SMS_AUDIT_REFUSAL",
      systemTitle: "订单{order_id}退款未通过", systemText: "{store_name}|{pay_price}", addTime: now,
    },
    {
      id: base + 602, mark: "order_deliver_success", name: "配送通知", isSystem: 0,
      isSms: 1, isRoutine: 1, smsId: "SMS_AUDIT_DELIVERY",
      systemTitle: "disabled", systemText: "disabled", addTime: now,
    },
  ]);
  await container.db.insert(notificationTemplate).values([
    { id: base + 700, title: "routine express", type: "wechat", mark: "1458",
      legacyType: 0, tempid: "routine-express-audit", status: 1, addTime: now },
    { id: base + 701, title: "routine delivery", type: "wechat", mark: "1128",
      legacyType: 0, tempid: "routine-delivery-audit", status: 1, addTime: now },
    { id: base + 702, title: "routine refund", type: "wechat", mark: "1451",
      legacyType: 0, tempid: "routine-refund-audit", status: 1, addTime: now },
    { id: base + 703, title: "official express", type: "wechat", mark: "42984",
      legacyType: 1, tempid: "official-express-audit", status: 1, addTime: now },
    { id: base + 704, title: "official refund", type: "wechat", mark: "46232",
      legacyType: 1, tempid: "official-refund-audit", status: 1, addTime: now },
  ]);
  await container.db.insert(systemConfig).values({
    id: base + 800,
    menuName: "order_shipping_open",
    value: JSON.stringify("1"),
    status: 1,
  });
  await container.db.insert(wechatUser).values([
    { id: base + 900, uid, openid: `official-audit-${base}`, userType: "wechat",
      subscribe: 1, isDel: 0, addTime: now },
    { id: base + 901, uid, openid: `routine-audit-${base}`, userType: "routine",
      subscribe: 1, isDel: 0, addTime: now },
  ]);
  return { delivery, deliveryRollback, refusal, refusalRollback, disabled, refunds: refundIds };
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

function fakeEnv(): { env: Env; queued: OrderMessage[] } {
  const queued: OrderMessage[] = [];
  const queue = {
    send: async (body: OrderMessage) => { queued.push(body); },
    sendBatch: async (messages: Array<{ body: OrderMessage }>) => {
      queued.push(...messages.map((message) => message.body));
    },
  } as unknown as Queue<OrderMessage>;
  const config = new Map<string, string>([
    ["cfg_wechat_appid", "official-audit-app"],
    ["cfg_wechat_appsecret", "official-audit-secret"],
    ["cfg_routine_appId", "routine-audit-app"],
    ["cfg_routine_appsecret", "routine-audit-secret"],
    ["cfg_pay_weixin_mchid", "merchant-audit"],
  ]);
  return {
    env: {
      ORDER_QUEUE: queue,
      CONFIG_KV: {
        get: async (key: string) => config.get(key) ?? null,
        put: async () => undefined,
        delete: async () => undefined,
      },
      ALIYUN_SMS_ACCESS_KEY_ID: "audit-access-key",
      ALIYUN_SMS_ACCESS_KEY_SECRET: "audit-access-secret",
      ALIYUN_SMS_SIGN_NAME: "audit-sign",
    } as unknown as Env,
    queued,
  };
}

async function runScenario(container: Container, name: string, base: number) {
  const scoped = <T>(fn: (scopedContainer: Container) => Promise<T>) =>
    withTx(container, async (tx) => fn(createContainerFromDb(tx)));
  const fixtures = await scoped((scopedContainer) => seed(scopedContainer, base));
  const { env, queued } = fakeEnv();
  const fulfillment = new SupplierFulfillmentService(container, env);
  const refuseRefund = (refundId: number, reason: string) => scoped((scopedContainer) =>
    new StoreOrderRefundService(scopedContainer, env).refuseRefund(refundId, reason, 5));
  const deliveryInput = {
    deliveryType: "express" as const,
    deliveryName: "Audit Express",
    deliveryCode: "AUDIT",
    deliveryId: "TRACK-001",
    fictitiousContent: "",
    deliveryUid: 0,
  };

  await fulfillment.deliver(5, fixtures.delivery, deliveryInput);
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}.store_order_outbox ADD CONSTRAINT audit_reject_delivery_notice
     CHECK (event_type <> '${ORDER_DELIVERY_NOTICE_EVENT}') NOT VALID`,
  ));
  const deliveryRolledBack = await rejects(() => fulfillment.deliver(
    5,
    fixtures.deliveryRollback,
    { ...deliveryInput, deliveryId: "TRACK-ROLLBACK" },
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}.store_order_outbox DROP CONSTRAINT audit_reject_delivery_notice`,
  ));
  const { deliveryRollbackState, deliveryRollbackEvidence } = await scoped(async (scopedContainer) => ({
    deliveryRollbackState: await scopedContainer.db.select({ status: storeOrder.status })
      .from(storeOrder).where(eq(storeOrder.id, fixtures.deliveryRollback)).limit(1),
    deliveryRollbackEvidence: await scopedContainer.db.select({ count: sql<number>`count(*)::int` })
      .from(storeOrderStatus).where(eq(storeOrderStatus.oid, fixtures.deliveryRollback)),
  }));
  await fulfillment.deliver(
    5,
    fixtures.deliveryRollback,
    { ...deliveryInput, deliveryId: "TRACK-ROLLBACK" },
  );

  await refuseRefund(fixtures.refunds[0], "生产隔离拒绝原因");
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}.store_order_outbox ADD CONSTRAINT audit_reject_refusal_notice
     CHECK (event_type <> '${ORDER_REFUND_REFUSED_NOTICE_EVENT}') NOT VALID`,
  ));
  const refusalRolledBack = await rejects(() => refuseRefund(
    fixtures.refunds[1],
    "生产隔离回滚原因",
  ));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}.store_order_outbox DROP CONSTRAINT audit_reject_refusal_notice`,
  ));
  const refusalRollbackState = await scoped((scopedContainer) => scopedContainer.db
    .select({ refundType: storeOrderRefund.refundType })
    .from(storeOrderRefund).where(eq(storeOrderRefund.id, fixtures.refunds[1])).limit(1));
  await refuseRefund(fixtures.refunds[1], "生产隔离回滚原因");

  const disabledOrder = await scoped((scopedContainer) => scopedContainer.db
    .select().from(storeOrder).where(eq(storeOrder.id, fixtures.disabled)).limit(1));
  assertCondition(disabledOrder[0], "disabled fixture missing");
  const disabledEvent = await withTx(container, (tx) => enqueueOrderDeliveryNoticeEvent(tx, {
    orderId: disabledOrder[0].id,
    orderNo: disabledOrder[0].orderId,
    userId: disabledOrder[0].uid,
    userAddress: disabledOrder[0].userAddress,
    deliveryType: "send",
    deliveryName: "Audit Courier",
    deliveryId: "13800000000",
  }));
  const duplicate = await scoped((scopedContainer) => enqueueOrderDeliveryNoticeEvent(
    scopedContainer.db,
    {
      orderId: disabledOrder[0].id,
      orderNo: disabledOrder[0].orderId,
      userId: disabledOrder[0].uid,
      userAddress: disabledOrder[0].userAddress,
      deliveryType: "send",
      deliveryName: "Audit Courier",
      deliveryId: "13800000000",
    },
  ));
  const immutableConflictRejected = await rejects(() => scoped((scopedContainer) =>
    enqueueOrderDeliveryNoticeEvent(scopedContainer.db, {
      orderId: disabledOrder[0].id,
      orderNo: disabledOrder[0].orderId,
      userId: disabledOrder[0].uid,
      userAddress: disabledOrder[0].userAddress,
      deliveryType: "send",
      deliveryName: "Audit Courier",
      deliveryId: "13999999999",
    })));

  const beforeProcessing = await scoped((scopedContainer) => scopedContainer.db
    .select().from(storeOrderOutbox)
    .where(inArray(storeOrderOutbox.aggregateId, [
      fixtures.delivery,
      fixtures.deliveryRollback,
      fixtures.refusal,
      fixtures.refusalRollback,
      fixtures.disabled,
    ])));
  assertCondition(beforeProcessing.length === 5, "unexpected outbox fixture count");
  const outbox = new OrderOutboxService(container, env);
  const failureTarget = beforeProcessing.find((event) => event.aggregateId === fixtures.delivery);
  assertCondition(failureTarget, "failure target missing");
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}.system_message ADD CONSTRAINT audit_reject_notice_message
     CHECK (event_key <> '${failureTarget.eventKey}') NOT VALID`,
  ));
  const processingFailed = await rejects(() => outbox.processMessage({
    action: "processOrderNotificationOutbox",
    outboxId: failureTarget.id,
    eventKey: failureTarget.eventKey,
  }));
  await container.db.execute(sql.raw(
    `ALTER TABLE ${identifier(name)}.system_message DROP CONSTRAINT audit_reject_notice_message`,
  ));
  const { failureCheckpoint, failureMessages } = await scoped(async (scopedContainer) => ({
    failureCheckpoint: await scopedContainer.db.select({
      status: storeOrderOutbox.status,
      attemptCount: storeOrderOutbox.attemptCount,
    }).from(storeOrderOutbox).where(eq(storeOrderOutbox.id, failureTarget.id)).limit(1),
    failureMessages: await scopedContainer.db.select({ count: sql<number>`count(*)::int` })
      .from(systemMessage).where(eq(systemMessage.eventKey, failureTarget.eventKey)),
  }));
  const retryResult = await outbox.processMessage({
    action: "processOrderNotificationOutbox",
    outboxId: failureTarget.id,
    eventKey: failureTarget.eventKey,
  });

  const concurrencyResults: string[] = [];
  const concurrentEvents = beforeProcessing.filter((row) => row.id !== failureTarget.id);
  for (const event of concurrentEvents) {
    const message: OrderNotificationOutboxMessage = {
      action: "processOrderNotificationOutbox",
      outboxId: event.id,
      eventKey: event.eventKey,
    };
    concurrencyResults.push(...await Promise.all([
      outbox.processMessage(message),
      outbox.processMessage(message),
    ]));
  }
  const busyReplays = await Promise.all(concurrentEvents.map((event) => outbox.processMessage({
    action: "processOrderNotificationOutbox",
    outboxId: event.id,
    eventKey: event.eventKey,
  })));
  const replay = await outbox.processMessage({
    action: "processOrderNotificationOutbox",
    outboxId: failureTarget.id,
    eventKey: failureTarget.eventKey,
  });

  const deliveryService = new OrderNotificationDeliveryService(container, env);
  const dispatch = await deliveryService.dispatchPending(100);
  const providerMessages = queued.filter(isOrderNotificationDeliveryMessage);
  let firstSmsAmbiguous = true;
  const providerFetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("dysmsapi.aliyuncs.com")) {
      if (firstSmsAmbiguous) {
        firstSmsAmbiguous = false;
        throw new Error("audit simulated network loss");
      }
      return Response.json({ Code: "OK", BizId: "audit-biz", RequestId: "audit-request" });
    }
    if (url.includes("/cgi-bin/token")) {
      return Response.json({ access_token: "audit-token", expires_in: 7_200 });
    }
    if (url.includes("get_delivery_list")) {
      return Response.json({
        errcode: 0,
        errmsg: "ok",
        delivery_list: [{ delivery_name: "Audit Express", delivery_id: "AUDIT" }],
      });
    }
    return Response.json({ errcode: 0, errmsg: "ok", msgid: "audit-msg" });
  }) as typeof fetch;
  const providerResults = [];
  for (const message of providerMessages) {
    providerResults.push(await deliveryService.processMessage(message, providerFetch));
  }
  const providerReplays = [];
  for (const message of providerMessages) {
    providerReplays.push(await deliveryService.processMessage(message, providerFetch));
  }

  const [orders, refundRows, outboxes, messages, deliveries] = await scoped((scopedContainer) => Promise.all([
    scopedContainer.db.select({ id: storeOrder.id, status: storeOrder.status })
      .from(storeOrder).where(inArray(storeOrder.id, [fixtures.delivery, fixtures.deliveryRollback])),
    scopedContainer.db.select({ id: storeOrderRefund.id, refundType: storeOrderRefund.refundType })
      .from(storeOrderRefund).where(inArray(storeOrderRefund.id, fixtures.refunds)),
    scopedContainer.db.select().from(storeOrderOutbox),
    scopedContainer.db.select().from(systemMessage),
    scopedContainer.db.select().from(orderNotificationDelivery),
  ]));
  const enabledEventKeys = new Set(outboxes
    .filter((event) => event.aggregateId !== fixtures.disabled)
    .map((event) => event.eventKey));
  const rendered = messages.map((message) => `${message.title}|${message.content}`).join("\n");
  const unknownDelivery = deliveries.find((delivery) => delivery.status === "UNKNOWN");
  assertCondition(unknownDelivery, "ambiguous delivery fixture missing");
  const { id: _unknownId, ...clone } = unknownDelivery;
  const operationFixtures = await scoped((scopedContainer) => scopedContainer.db
    .insert(orderNotificationDelivery).values([
    {
      ...clone,
      eventKey: `order.delivery.notice:${base + 901}`,
      status: "UNKNOWN",
      responseCode: "",
      lastError: "audit_manual_confirm_sent",
      providerReference: "",
      providerRequestId: "",
      sentTime: 0,
    },
    {
      ...clone,
      eventKey: `order.delivery.notice:${base + 902}`,
      status: "UNKNOWN",
      responseCode: "",
      lastError: "audit_manual_close",
      providerReference: "",
      providerRequestId: "",
      sentTime: 0,
    },
    ]).returning());
  assertCondition(operationFixtures.length === 2, "manual operation fixtures missing");
  const adminService = new OrderNotificationAdminService(container, env);
  const retryRequestKey = crypto.randomUUID();
  const retryResultAdmin = await adminService.confirmRetry(unknownDelivery.id, base + 77, {
    requestKey: retryRequestKey,
    reason: "生产隔离审计确认允许重发",
  });
  const retryReplay = await adminService.confirmRetry(unknownDelivery.id, base + 77, {
    requestKey: retryRequestKey,
    reason: "生产隔离审计确认允许重发",
  });
  const changedReplayRejected = await rejects(() => adminService.confirmRetry(
    unknownDelivery.id,
    base + 77,
    {
      requestKey: retryRequestKey,
      reason: "相同请求键不允许改变理由",
    },
  ));
  const sentResultAdmin = await adminService.confirmSent(operationFixtures[0]!.id, base + 78, {
    requestKey: crypto.randomUUID(),
    reason: "提供商后台已核验发送成功",
    providerReference: "audit-provider-reference",
  });
  const closeResultAdmin = await adminService.closeWithoutRetry(operationFixtures[1]!.id, base + 79, {
    requestKey: crypto.randomUUID(),
    reason: "业务决定关闭且不再重发",
  });
  const [adminDeliveries, retryActions, sentActions, closeActions] = await Promise.all([
    adminService.listDeliveries({ limit: 100 }),
    adminService.listDeliveryActions(unknownDelivery.id),
    adminService.listDeliveryActions(operationFixtures[0]!.id),
    adminService.listDeliveryActions(operationFixtures[1]!.id),
  ]);
  const retryProjection = adminDeliveries.list.find((delivery) => delivery.id === unknownDelivery.id);
  const operations = {
    retry_transitioned: !retryResultAdmin.duplicate
      && retryResultAdmin.delivery.status === "RETRYABLE"
      && retryResultAdmin.delivery.replayCount === 1,
    duplicate_request_idempotent: retryReplay.duplicate && retryActions.length === 1,
    changed_request_content_rejected: changedReplayRejected,
    confirm_sent_transitioned: sentResultAdmin.delivery.status === "SENT"
      && sentResultAdmin.delivery.providerReference === "audit-provider-reference"
      && sentActions.length === 1,
    close_without_retry_transitioned: closeResultAdmin.delivery.status === "DEAD"
      && closeActions.length === 1,
    admin_projection_redacted: Boolean(retryProjection)
      && !("target" in retryProjection!) && !("payload" in retryProjection!)
      && retryProjection!.maskedTarget.length > 0,
    immutable_action_rows: retryActions.length + sentActions.length + closeActions.length,
  };

  return {
    business_transaction: {
      delivery_rollback_triggered: deliveryRolledBack,
      delivery_rollback_clean: deliveryRollbackState[0]?.status === 0
        && deliveryRollbackEvidence[0]?.count === 0,
      refusal_rollback_triggered: refusalRolledBack,
      refusal_rollback_clean: refusalRollbackState[0]?.refundType === 2,
      delivered_orders: orders.filter((order) => order.status === 1).length,
      refused_refunds: refundRows.filter((refund) => refund.refundType === 3).length,
      outbox_rows: outboxes.length,
      duplicate_enqueue_same_id: duplicate.id === disabledEvent.id,
      immutable_conflict_rejected: immutableConflictRejected,
    },
    consumption: {
      processing_failure_recorded: processingFailed
        && failureCheckpoint[0]?.status === "FAILED"
        && failureCheckpoint[0]?.attemptCount === 1,
      failed_transaction_left_no_message: failureMessages[0]?.count === 0,
      retry_completed: retryResult === "completed",
      final_replay_idempotent: replay === "already-completed",
      concurrent_completed: concurrencyResults.filter((result) => result === "completed").length,
      concurrent_already_completed: concurrencyResults.filter((result) => result === "already-completed").length,
      concurrent_busy: concurrencyResults.filter((result) => result === "busy").length,
      busy_replays_already_completed: busyReplays
        .filter((result) => result === "already-completed").length,
      outbox_completed: outboxes.filter((event) => event.status === "COMPLETED").length,
      message_rows: messages.length,
      enabled_message_keys_exact: messages.length === enabledEventKeys.size
        && messages.every((message) => message.eventKey && enabledEventKeys.has(message.eventKey)),
      disabled_channel_suppressed: !messages.some((message) => message.eventKey === disabledEvent.eventKey),
      templates_rendered: rendered.includes("通知审计用户")
        && rendered.includes("Audit Express")
        && rendered.includes("退款未通过")
        && !rendered.includes("{order_id}"),
      external_delivery_rows: deliveries.length,
      external_delivery_pending: deliveries.filter((delivery) => delivery.status === "PENDING").length,
      external_delivery_enqueuing: deliveries.filter((delivery) => delivery.status === "ENQUEUING").length,
      external_delivery_enqueued: deliveries.filter((delivery) => delivery.status === "ENQUEUED").length,
      external_delivery_processing: deliveries.filter((delivery) => delivery.status === "PROCESSING").length,
      external_delivery_retryable: deliveries.filter((delivery) => delivery.status === "RETRYABLE").length,
      external_delivery_sent: deliveries.filter((delivery) => delivery.status === "SENT").length,
      external_delivery_unknown: deliveries.filter((delivery) => delivery.status === "UNKNOWN").length,
      external_delivery_skipped: deliveries.filter((delivery) => delivery.status === "SKIPPED").length,
      external_delivery_dead: deliveries.filter((delivery) => delivery.status === "DEAD").length,
      external_sms_sent: deliveries.filter((delivery) =>
        delivery.channel === "sms" && delivery.status === "SENT").length,
      external_sms_unknown: deliveries.filter((delivery) =>
        delivery.channel === "sms" && delivery.status === "UNKNOWN").length,
      external_official_sent: deliveries.filter((delivery) =>
        delivery.channel === "wechat_official" && delivery.status === "SENT").length,
      external_official_unknown: deliveries.filter((delivery) =>
        delivery.channel === "wechat_official" && delivery.status === "UNKNOWN").length,
      external_routine_sent: deliveries.filter((delivery) =>
        delivery.channel === "wechat_routine" && delivery.status === "SENT").length,
      external_routine_unknown: deliveries.filter((delivery) =>
        delivery.channel === "wechat_routine" && delivery.status === "UNKNOWN").length,
      external_shipping_sent: deliveries.filter((delivery) =>
        delivery.channel === "wechat_shipping" && delivery.status === "SENT").length,
      external_shipping_unknown: deliveries.filter((delivery) =>
        delivery.channel === "wechat_shipping" && delivery.status === "UNKNOWN").length,
      external_channel_counts_exact: [
        ["sms", 5],
        ["wechat_official", 4],
        ["wechat_routine", 5],
        ["wechat_shipping", 3],
      ].every(([channel, count]) =>
        deliveries.filter((delivery) => delivery.channel === channel).length === count),
      provider_payloads_stay_in_database: deliveries.every((delivery) =>
        delivery.eventKey && delivery.target && delivery.payload),
      provider_dispatch_exact: dispatch.claimed === 17 && dispatch.enqueued === 17
        && providerMessages.length === 17,
      queue_payloads_are_references_only: providerMessages.every((message) =>
        !("target" in message) && !("payload" in message)),
      ambiguous_result_not_retried: providerResults.filter((result) => result === "unknown").length === 1
        && providerReplays.filter((result) => result === "unknown").length === 1,
      sent_replays_idempotent: providerResults.filter((result) => result === "sent").length === 16
        && providerReplays.filter((result) => result === "already-sent").length === 16,
      provider_result_sent: providerResults.filter((result) => result === "sent").length,
      provider_result_unknown: providerResults.filter((result) => result === "unknown").length,
      provider_result_dead: providerResults.filter((result) => result === "dead").length,
      provider_result_busy: providerResults.filter((result) => result === "busy").length,
      provider_result_retry_scheduled: providerResults
        .filter((result) => result === "retry-scheduled").length,
      attempts: outboxes.map((event) => event.attemptCount).sort((left, right) => left - right),
    },
    operations,
  };
}

export async function productionNotificationTemplateState(db: DbClient) {
  const marks = [
    "order_postage_success",
    "order_deliver_success",
    "order_fictitious_success",
    "send_order_refund_no_status",
  ];
  return db.$client<{ mark: string; rows: number; system_enabled: number }[]>`
    SELECT mark, count(*)::int AS rows,
      count(*) FILTER (WHERE is_system = 1)::int AS system_enabled
    FROM public.system_notification
    WHERE mark = ANY(${marks})
    GROUP BY mark ORDER BY mark
  `;
}

export async function runOrderNotificationOutboxPostgresScenario(
  connectionString: string,
  strict = true,
): Promise<OrderNotificationOutboxPostgresReport> {
  const name = randomSchemaName();
  const schema = identifier(name);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_order_notice_audit_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 2, {
    searchPath: name,
    applicationName: "cinashop_order_notice_audit_scenario",
  });
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let scenario: Awaited<ReturnType<typeof runScenario>> | undefined;
  let templates: Array<{ mark: string; rows: number; system_enabled: number }> = [];
  let serverVersion = "unknown";
  let rootEnded = false;
  let scopedEnded = false;
  try {
    const versions = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await fingerprint(root);
    templates = [...await productionNotificationTemplateState(root)];
    await setupSchema(root, name);
    created = true;
    await root.$client.end({ timeout: 1 });
    rootEnded = true;
    scenario = await runScenario(createContainerFromDb(scoped), name, 1_600_000_000 + Date.now() % 10_000_000);
  } finally {
    if (!scopedEnded) {
      await scoped.$client.end({ timeout: 1 }).catch(() => undefined);
      scopedEnded = true;
    }
    if (!rootEnded) {
      await root.$client.end({ timeout: 1 }).catch(() => undefined);
      rootEnded = true;
    }
    const cleanup = createDbFromConnectionString(connectionString, 1, {
      applicationName: "cinashop_order_notice_audit_cleanup",
    });
    try {
      if (created) {
        await cleanup.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '20s'`;
          await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        });
      }
      const state = await cleanup.$client<{ removed: boolean; count: number }[]>`
        SELECT to_regnamespace(${name}) IS NULL AS removed,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_order_notice_%') AS count
      `;
      removed = state[0]?.removed === true;
      prefixCount = state[0]?.count ?? -1;
      after = await fingerprint(cleanup);
    } finally {
      await cleanup.$client.end({ timeout: 1 });
    }
  }
  assertCondition(scenario, "scenario report missing");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const business = scenario.business_transaction;
  const consumption = scenario.consumption;
  const operations = scenario.operations;
  if (strict) {
    assertCondition(
      business.delivery_rollback_triggered && business.delivery_rollback_clean
        && business.refusal_rollback_triggered && business.refusal_rollback_clean
        && business.delivered_orders === 2 && business.refused_refunds === 2
        && business.outbox_rows === 5 && business.duplicate_enqueue_same_id
        && business.immutable_conflict_rejected,
      `business/outbox transaction contract diverged: ${JSON.stringify(business)}`,
    );
    assertCondition(
      consumption.processing_failure_recorded && consumption.failed_transaction_left_no_message
        && consumption.retry_completed && consumption.final_replay_idempotent
        && consumption.concurrent_completed === 4
        && consumption.concurrent_already_completed + consumption.concurrent_busy === 4
        && consumption.busy_replays_already_completed === 4
        && consumption.outbox_completed === 5 && consumption.message_rows === 4
        && consumption.enabled_message_keys_exact && consumption.disabled_channel_suppressed
        && consumption.templates_rendered
        && consumption.external_delivery_rows === 17
        && consumption.external_delivery_pending === 0
        && consumption.external_delivery_sent === 16
        && consumption.external_delivery_unknown === 1
        && consumption.external_delivery_skipped === 0
        && consumption.external_channel_counts_exact
        && consumption.provider_payloads_stay_in_database
        && consumption.provider_dispatch_exact
        && consumption.queue_payloads_are_references_only
        && consumption.ambiguous_result_not_retried
        && consumption.sent_replays_idempotent
        && JSON.stringify(consumption.attempts) === JSON.stringify([1, 1, 1, 1, 2]),
      `notification consumption contract diverged: ${JSON.stringify(consumption)}`,
    );
    assertCondition(
      operations.retry_transitioned && operations.duplicate_request_idempotent
        && operations.changed_request_content_rejected
        && operations.confirm_sent_transitioned && operations.close_without_retry_transitioned
        && operations.admin_projection_redacted && operations.immutable_action_rows === 3,
      `notification operation contract diverged: ${JSON.stringify(operations)}`,
    );
  }
  assertCondition(removed && prefixCount === 0 && unchanged, "cleanup or public state diverged");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    business_transaction: business,
    consumption,
    operations,
    templates,
  };
}
