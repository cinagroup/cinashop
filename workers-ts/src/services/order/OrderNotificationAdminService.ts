import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  notificationTemplate,
  orderNotificationDelivery,
  orderNotificationDeliveryAction,
  systemConfig,
  systemNotification,
  wechatUser,
  type OrderNotificationChannel,
  type OrderNotificationDeliveryActionType,
  type OrderNotificationDeliveryStatus,
} from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { NotFoundException, ValidateException } from "@/utils/errors";

export const ORDER_NOTIFICATION_MARKS = [
  "order_postage_success",
  "order_deliver_success",
  "order_fictitious_success",
  "send_order_refund_no_status",
  "user_extract",
  "user_balance_change",
] as const;

export type OrderNotificationMark = (typeof ORDER_NOTIFICATION_MARKS)[number];
type ProviderTemplateType = "wechat" | "routine";

const DELIVERY_STATUSES = new Set<OrderNotificationDeliveryStatus>([
  "PENDING",
  "ENQUEUING",
  "ENQUEUED",
  "PROCESSING",
  "RETRYABLE",
  "SENT",
  "SKIPPED",
  "UNKNOWN",
  "DEAD",
]);
const DELIVERY_CHANNELS = new Set<OrderNotificationChannel>([
  "sms",
  "wechat_official",
  "wechat_routine",
  "wechat_shipping",
]);
const REQUEST_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANUAL_REPLAYS = 20;

const MARK_POLICY: Record<OrderNotificationMark, {
  label: string;
  official: boolean;
  routine: boolean;
}> = {
  order_postage_success: { label: "快递发货成功", official: true, routine: true },
  order_deliver_success: { label: "平台配送成功", official: false, routine: true },
  order_fictitious_success: { label: "虚拟交付成功", official: false, routine: false },
  send_order_refund_no_status: { label: "退款申请未通过", official: true, routine: true },
  user_extract: { label: "提现成功", official: true, routine: true },
  user_balance_change: { label: "提现拒绝退回", official: false, routine: true },
};

function positiveInt(value: unknown, label: string, maximum = 2_147_483_647): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return positiveInt(value, label);
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 0,
): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const text = value.trim();
  const length = [...text].length;
  if (length < minimum || length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ValidateException(`${label}长度必须为${minimum}到${maximum}个可见字符`);
  }
  return text;
}

function bit(value: unknown, label: string): number {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new ValidateException(`${label}必须为布尔值`);
}

function notificationMark(value: unknown): OrderNotificationMark {
  const mark = String(value ?? "").trim() as OrderNotificationMark;
  if (!ORDER_NOTIFICATION_MARKS.includes(mark)) throw new ValidateException("通知标记无效");
  return mark;
}

function templateMark(value: unknown): string {
  const mark = String(value ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(mark)) {
    throw new ValidateException("模板标记格式错误");
  }
  return mark;
}

function providerType(value: unknown): ProviderTemplateType {
  const type = String(value ?? "").trim();
  if (type !== "wechat" && type !== "routine") throw new ValidateException("模板渠道无效");
  return type;
}

function operationReason(value: unknown): string {
  return boundedString(value, "操作原因", 500, 8);
}

function requestKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!REQUEST_KEY_PATTERN.test(key)) throw new ValidateException("操作请求键无效");
  return key.toLowerCase();
}

function maskTarget(channel: OrderNotificationChannel, value: string): string {
  if (!value) return "";
  if (channel === "sms") {
    return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : "[REDACTED]";
  }
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function deliveryAdminProjection(row: typeof orderNotificationDelivery.$inferSelect) {
  return {
    id: row.id,
    outboxId: row.outboxId,
    eventKey: row.eventKey,
    orderId: row.orderId,
    withdrawalId: row.withdrawalId,
    userId: row.userId,
    noticeMark: row.noticeMark,
    channel: row.channel,
    maskedTarget: maskTarget(row.channel, row.target),
    templateCode: row.templateCode,
    status: row.status,
    dispatchCount: row.dispatchCount,
    attemptCount: row.attemptCount,
    replayCount: row.replayCount,
    availableTime: row.availableTime,
    leaseUntil: row.leaseUntil,
    providerReference: row.providerReference,
    providerRequestId: row.providerRequestId,
    responseCode: row.responseCode,
    lastError: row.lastError,
    sentTime: row.sentTime,
    addTime: row.addTime,
    updateTime: row.updateTime,
  };
}

async function selectDeliveryForUpdate(tx: DbClient, id: number) {
  const rows = await tx.select().from(orderNotificationDelivery)
    .where(eq(orderNotificationDelivery.id, id)).for("update").limit(1);
  if (!rows[0]) throw new NotFoundException("外部通知投递不存在");
  return rows[0];
}

export interface NotificationTemplateSaveInput {
  id?: unknown;
  title?: unknown;
  content?: unknown;
  type?: unknown;
  mark?: unknown;
  tempid?: unknown;
  example?: unknown;
  status?: unknown;
}

export interface OrderNotificationConfigSaveInput {
  name?: unknown;
  title?: unknown;
  systemTitle?: unknown;
  systemText?: unknown;
  smsId?: unknown;
  smsText?: unknown;
  url?: unknown;
  isSystem?: unknown;
  isSms?: unknown;
  isWechat?: unknown;
  isRoutine?: unknown;
}

export interface NotificationDeliveryListQuery {
  status?: string;
  channel?: string;
  eventKey?: string;
  afterId?: number;
  limit?: number;
}

interface NotificationDeliveryOperationInput {
  requestKey: unknown;
  reason: unknown;
  providerReference?: unknown;
}

export class OrderNotificationAdminService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async listTemplates() {
    const rows = await withTx(this.container, (tx) => tx.select().from(notificationTemplate)
      .orderBy(asc(notificationTemplate.mark), asc(notificationTemplate.legacyType), desc(notificationTemplate.id))
      .limit(200));
    return rows.map((row) => ({
      ...row,
      type: row.legacyType === 0 ? "routine" : row.legacyType === 1 ? "wechat" : row.type,
    }));
  }

  async saveTemplate(input: NotificationTemplateSaveInput) {
    const id = optionalPositiveInt(input.id, "模板ID");
    const type = providerType(input.type);
    const mark = templateMark(input.mark);
    const title = boundedString(input.title, "模板标题", 128, 1);
    const content = boundedString(input.content ?? "", "模板说明", 20_000);
    const tempid = boundedString(input.tempid, "提供商模板ID", 100, 1);
    const example = boundedString(input.example ?? "", "模板示例", 300);
    const status = bit(input.status ?? 1, "模板状态");
    const legacyType = type === "routine" ? 0 : 1;
    const orderPolicy = MARK_POLICY[mark as OrderNotificationMark];
    if (orderPolicy && type === "wechat" && !orderPolicy.official) {
      throw new ValidateException("该 PHP 通知事件不支持公众号模板");
    }
    if (orderPolicy && type === "routine" && !orderPolicy.routine) {
      throw new ValidateException("该 PHP 通知事件不支持小程序订阅模板");
    }
    const now = Math.floor(Date.now() / 1_000);

    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`notification-template:${mark}:${legacyType}`}))`);
      if (id) {
        const existing = await tx.select().from(notificationTemplate)
          .where(eq(notificationTemplate.id, id)).for("update").limit(1);
        if (!existing[0]) throw new NotFoundException("通知模板不存在");
      }
      if (status === 1) {
        const conditions: SQL[] = [
          eq(notificationTemplate.mark, mark),
          eq(notificationTemplate.legacyType, legacyType),
          eq(notificationTemplate.status, 1),
        ];
        if (id) conditions.push(ne(notificationTemplate.id, id));
        const duplicate = await tx.select({ id: notificationTemplate.id })
          .from(notificationTemplate).where(and(...conditions)).limit(1);
        if (duplicate[0]) throw new ValidateException("该事件和渠道已有启用模板，请先停用旧模板");
      }

      if (id) {
        const rows = await tx.update(notificationTemplate).set({
          title,
          content,
          type,
          legacyType,
          mark,
          tempid,
          example,
          status,
        }).where(eq(notificationTemplate.id, id)).returning();
        return rows[0];
      }
      const rows = await tx.insert(notificationTemplate).values({
        title,
        content,
        type,
        legacyType,
        mark,
        tempid,
        example,
        status,
        addTime: now,
      }).returning();
      return rows[0];
    });
  }

  async listOrderConfigs() {
    const [rows, templates] = await Promise.all([
      withTx(this.container, (tx) => tx.select().from(systemNotification)
        .where(inArray(systemNotification.mark, [...ORDER_NOTIFICATION_MARKS]))
        .orderBy(asc(systemNotification.mark), desc(systemNotification.id))),
      this.listTemplates(),
    ]);
    return ORDER_NOTIFICATION_MARKS.map((mark) => {
      const matches = rows.filter((row) => row.mark === mark);
      const row = matches[0];
      return {
        mark,
        label: MARK_POLICY[mark].label,
        exists: !!row,
        ambiguous: matches.length > 1,
        rowCount: matches.length,
        id: row?.id ?? 0,
        name: row?.name ?? MARK_POLICY[mark].label,
        title: row?.title ?? MARK_POLICY[mark].label,
        isSystem: row?.isSystem === 1,
        isSms: row?.isSms === 1,
        isWechat: row?.isWechat === 1,
        isRoutine: row?.isRoutine === 1,
        systemTitle: row?.systemTitle ?? "",
        systemText: row?.systemText ?? "",
        smsId: row?.smsId ?? "",
        smsText: row?.smsText ?? "",
        url: row?.url ?? "",
        officialAllowed: MARK_POLICY[mark].official,
        routineAllowed: MARK_POLICY[mark].routine,
        templateCount: templates.filter((template) => template.mark === mark).length,
        enabledTemplateCount: templates
          .filter((template) => template.mark === mark && template.status === 1).length,
      };
    });
  }

  async saveOrderConfig(markValue: unknown, input: OrderNotificationConfigSaveInput) {
    const mark = notificationMark(markValue);
    const policy = MARK_POLICY[mark];
    const isSystem = bit(input.isSystem ?? false, "站内信开关");
    const isSms = bit(input.isSms ?? false, "短信开关");
    const isWechat = bit(input.isWechat ?? false, "公众号开关");
    const isRoutine = bit(input.isRoutine ?? false, "小程序开关");
    if (isWechat && !policy.official) throw new ValidateException("该 PHP 通知事件不支持公众号通知");
    if (isRoutine && !policy.routine) throw new ValidateException("该 PHP 通知事件不支持小程序通知");
    const name = boundedString(input.name ?? policy.label, "通知名称", 50, 1);
    const title = boundedString(input.title ?? policy.label, "通知标题", 100, 1);
    const systemTitle = boundedString(input.systemTitle ?? "", "站内信标题", 256);
    const systemText = boundedString(input.systemText ?? "", "站内信内容", 512);
    const smsId = boundedString(input.smsId ?? "", "短信模板ID", 50);
    const smsText = boundedString(input.smsText ?? "", "短信说明", 255);
    const url = boundedString(input.url ?? "", "跳转地址", 512);
    if (isSystem && (!systemTitle || !systemText)) {
      throw new ValidateException("启用站内信时必须填写标题和内容");
    }
    if (isSms && !smsId) throw new ValidateException("启用短信时必须填写短信模板ID");
    const now = Math.floor(Date.now() / 1_000);

    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`system-notification:${mark}`}))`);
      const existing = await tx.select().from(systemNotification)
        .where(eq(systemNotification.mark, mark)).orderBy(desc(systemNotification.id)).for("update");
      if (existing.length > 1) throw new ValidateException("该通知标记存在重复配置，请先完成数据清理");
      const values = {
        mark,
        name,
        title,
        isSystem,
        isSms,
        isWechat: policy.official ? isWechat : 0,
        isRoutine: policy.routine ? isRoutine : 0,
        systemTitle,
        systemText,
        smsId,
        smsText,
        url,
      };
      if (existing[0]) {
        return (await tx.update(systemNotification).set(values)
          .where(eq(systemNotification.id, existing[0].id)).returning())[0];
      }
      return (await tx.insert(systemNotification).values({
        ...values,
        addTime: now,
      }).returning())[0];
    });
  }

  async saveShippingEnabled(value: unknown) {
    const enabled = bit(value, "微信发货上报开关");
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('system-config:order_shipping_open'))`);
      const rows = await tx.select().from(systemConfig).where(and(
        eq(systemConfig.menuName, "order_shipping_open"),
        eq(systemConfig.isStore, 0),
      )).orderBy(desc(systemConfig.sort), desc(systemConfig.id)).for("update");
      if (rows.length > 1) throw new ValidateException("微信发货开关存在重复配置，请先完成数据清理");
      if (rows[0]) {
        await tx.update(systemConfig).set({ value: String(enabled), status: 1 })
          .where(eq(systemConfig.id, rows[0].id));
      } else {
        await tx.insert(systemConfig).values({
          menuName: "order_shipping_open",
          info: "微信小程序发货信息上报",
          desc: "启用后仅对符合 PHP 条件的微信支付商品订单上报",
          value: String(enabled),
          isStore: 0,
          type: "radio",
          inputType: "radio",
          parameter: "1=>开启,0=>关闭",
          sort: 0,
          status: 1,
        });
      }
    });
    await new SystemConfigService(this.container, this.env).invalidate("order_shipping_open");
    return { enabled: enabled === 1 };
  }

  async readiness() {
    const keys = [
      "order_shipping_open",
      "wechat_appid",
      "wechat_appsecret",
      "routine_appId",
      "routine_appsecret",
      "pay_weixin_mchid",
      "site_url",
    ];
    const [values, duplicates, notifications, templates, identities, deliverySummary] = await Promise.all([
      new SystemConfigService(this.container, this.env).getMany(keys),
      withTx(this.container, (tx) => tx.select({
        menuName: systemConfig.menuName,
        rows: sql<number>`count(*)::int`,
      }).from(systemConfig).where(and(
        inArray(systemConfig.menuName, keys),
        eq(systemConfig.isStore, 0),
      )).groupBy(systemConfig.menuName)),
      withTx(this.container, (tx) => tx.select({ rows: sql<number>`count(*)::int` })
        .from(systemNotification).where(inArray(systemNotification.mark, [...ORDER_NOTIFICATION_MARKS]))),
      withTx(this.container, (tx) => tx.select({ rows: sql<number>`count(*)::int` })
        .from(notificationTemplate).where(inArray(notificationTemplate.mark, [...ORDER_NOTIFICATION_MARKS]))),
      withTx(this.container, (tx) => tx.select({ rows: sql<number>`count(*)::int` })
        .from(wechatUser)),
      this.deliverySummary(),
    ]);
    const rowCount = (key: string) => duplicates.find((entry) => entry.menuName === key)?.rows ?? 0;
    const configured = (key: string) => (values[key]?.trim() ?? "") !== "";
    return {
      sms: {
        accessKeyIdConfigured: !!this.env.ALIYUN_SMS_ACCESS_KEY_ID,
        accessKeySecretConfigured: !!this.env.ALIYUN_SMS_ACCESS_KEY_SECRET,
        signNameConfigured: !!this.env.ALIYUN_SMS_SIGN_NAME,
        regionConfigured: !!this.env.ALIYUN_SMS_REGION_ID,
        verificationTemplateConfigured: !!this.env.ALIYUN_SMS_VERIFICATION_TEMPLATE_CODE,
        verificationCacheConfigured: !!this.env.UPSTASH_REDIS_URL && !!this.env.UPSTASH_REDIS_TOKEN,
      },
      wechat: {
        officialAppIdConfigured: configured("wechat_appid"),
        officialSecretConfigured: configured("wechat_appsecret"),
        routineAppIdConfigured: configured("routine_appId"),
        routineSecretConfigured: configured("routine_appsecret"),
        merchantIdConfigured: configured("pay_weixin_mchid"),
        identityRows: identities[0]?.rows ?? 0,
      },
      shipping: {
        enabled: ["1", "true"].includes((values.order_shipping_open ?? "").trim().toLowerCase()),
        configRows: rowCount("order_shipping_open"),
      },
      site: {
        urlConfigured: configured("site_url"),
        urlRows: rowCount("site_url"),
      },
      catalog: {
        notificationRows: notifications[0]?.rows ?? 0,
        templateRows: templates[0]?.rows ?? 0,
      },
      deliveries: deliverySummary,
      secretPolicy: "Worker secrets are never returned or written through this API",
    };
  }

  async listDeliveries(query: NotificationDeliveryListQuery = {}) {
    const status = query.status?.trim().toUpperCase();
    if (status && !DELIVERY_STATUSES.has(status as OrderNotificationDeliveryStatus)) {
      throw new ValidateException("投递状态无效");
    }
    const channel = query.channel?.trim().toLowerCase();
    if (channel && !DELIVERY_CHANNELS.has(channel as OrderNotificationChannel)) {
      throw new ValidateException("投递渠道无效");
    }
    const eventKey = query.eventKey?.trim();
    if (eventKey && !/^(?:(?:order\.delivery\.notice|order\.refund\.refused\.notice|withdrawal\.(?:approved|refused)\.notice):[1-9]\d*|order\.second_card\.(?:advent|expired)\.notice:[1-9]\d*:[1-9]\d*)$/.test(eventKey)) {
      throw new ValidateException("事件键无效");
    }
    const afterId = query.afterId ?? 0;
    if (afterId) positiveInt(afterId, "游标");
    const limit = query.limit === undefined ? 20 : positiveInt(query.limit, "每页数量", 100);

    const rows = await withTx(this.container, async (tx) => {
      const conditions: SQL[] = [];
      if (status) conditions.push(eq(orderNotificationDelivery.status, status as OrderNotificationDeliveryStatus));
      if (channel) conditions.push(eq(orderNotificationDelivery.channel, channel as OrderNotificationChannel));
      if (eventKey) conditions.push(eq(orderNotificationDelivery.eventKey, eventKey));
      if (afterId) conditions.push(lt(orderNotificationDelivery.id, afterId));
      return tx.select().from(orderNotificationDelivery)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(orderNotificationDelivery.id)).limit(limit);
    });
    return {
      list: rows.map(deliveryAdminProjection),
      next_cursor: rows.length === limit ? rows.at(-1)?.id ?? null : null,
      summary: await this.deliverySummary(),
    };
  }

  async listDeliveryActions(idValue: unknown) {
    const id = positiveInt(idValue, "投递ID");
    return withTx(this.container, async (tx) => {
      const exists = await tx.select({ id: orderNotificationDelivery.id })
        .from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, id)).limit(1);
      if (!exists[0]) throw new NotFoundException("外部通知投递不存在");
      return tx.select({
        id: orderNotificationDeliveryAction.id,
        deliveryId: orderNotificationDeliveryAction.deliveryId,
        requestKey: orderNotificationDeliveryAction.requestKey,
        action: orderNotificationDeliveryAction.action,
        previousStatus: orderNotificationDeliveryAction.previousStatus,
        nextStatus: orderNotificationDeliveryAction.nextStatus,
        adminId: orderNotificationDeliveryAction.adminId,
        reason: orderNotificationDeliveryAction.reason,
        providerReference: orderNotificationDeliveryAction.providerReference,
        addTime: orderNotificationDeliveryAction.addTime,
      }).from(orderNotificationDeliveryAction)
        .where(eq(orderNotificationDeliveryAction.deliveryId, id))
        .orderBy(desc(orderNotificationDeliveryAction.id)).limit(100);
    });
  }

  async confirmSent(id: unknown, adminId: unknown, input: NotificationDeliveryOperationInput) {
    return this.operateDelivery(id, adminId, "CONFIRM_SENT", input);
  }

  async confirmRetry(id: unknown, adminId: unknown, input: NotificationDeliveryOperationInput) {
    return this.operateDelivery(id, adminId, "CONFIRM_RETRY", input);
  }

  async closeWithoutRetry(id: unknown, adminId: unknown, input: NotificationDeliveryOperationInput) {
    return this.operateDelivery(id, adminId, "CLOSE_NO_RETRY", input);
  }

  private async deliverySummary() {
    const rows = await withTx(this.container, (tx) => tx.select({
      pending: sql<number>`count(*) FILTER (WHERE ${orderNotificationDelivery.status} IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE'))::int`,
      sent: sql<number>`count(*) FILTER (WHERE ${orderNotificationDelivery.status} = 'SENT')::int`,
      unknown: sql<number>`count(*) FILTER (WHERE ${orderNotificationDelivery.status} = 'UNKNOWN')::int`,
      dead: sql<number>`count(*) FILTER (WHERE ${orderNotificationDelivery.status} = 'DEAD')::int`,
      skipped: sql<number>`count(*) FILTER (WHERE ${orderNotificationDelivery.status} = 'SKIPPED')::int`,
    }).from(orderNotificationDelivery));
    return rows[0] ?? { pending: 0, sent: 0, unknown: 0, dead: 0, skipped: 0 };
  }

  private async operateDelivery(
    idValue: unknown,
    adminIdValue: unknown,
    action: OrderNotificationDeliveryActionType,
    input: NotificationDeliveryOperationInput,
    now = Math.floor(Date.now() / 1_000),
  ) {
    const id = positiveInt(idValue, "投递ID");
    const adminId = positiveInt(adminIdValue, "管理员ID");
    const reason = operationReason(input.reason);
    const key = requestKey(input.requestKey);
    const providerReference = input.providerReference === undefined
      ? ""
      : boundedString(input.providerReference, "提供商引用", 255);

    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`notification-operation:${key}`}))`);
      const current = await tx.select().from(orderNotificationDelivery)
        .where(eq(orderNotificationDelivery.id, id)).limit(1);
      if (!current[0]) throw new NotFoundException("外部通知投递不存在");
      const effectiveProviderReference = providerReference || current[0].providerReference;
      const priorAction = await tx.select().from(orderNotificationDeliveryAction)
        .where(eq(orderNotificationDeliveryAction.requestKey, key)).limit(1);
      if (priorAction[0]) {
        if (
          priorAction[0].deliveryId !== id || priorAction[0].adminId !== adminId ||
          priorAction[0].action !== action || priorAction[0].reason !== reason ||
          priorAction[0].providerReference !== effectiveProviderReference
        ) {
          throw new ValidateException("操作请求键已被不同内容使用");
        }
        return { duplicate: true, delivery: deliveryAdminProjection(current[0]) };
      }

      const row = await selectDeliveryForUpdate(tx, id);
      let nextStatus: OrderNotificationDeliveryStatus;
      let values: Partial<typeof orderNotificationDelivery.$inferInsert>;
      if (action === "CONFIRM_SENT") {
        if (row.status !== "UNKNOWN") throw new ValidateException("只有结果未知的投递可人工确认为已发送");
        nextStatus = "SENT";
        values = {
          status: nextStatus,
          providerReference: effectiveProviderReference,
          responseCode: "ADMIN_CONFIRMED_SENT",
          lastError: "",
          availableTime: 0,
          leaseUntil: 0,
          leaseToken: "",
          sentTime: now,
          updateTime: now,
        };
      } else if (action === "CONFIRM_RETRY") {
        if (row.status !== "UNKNOWN" && row.status !== "DEAD") {
          throw new ValidateException("只有结果未知或已停止的投递可确认重发");
        }
        if (row.replayCount >= MAX_MANUAL_REPLAYS) throw new ValidateException("该投递已达到最大人工重发次数");
        nextStatus = "RETRYABLE";
        values = {
          status: nextStatus,
          replayCount: row.replayCount + 1,
          availableTime: now,
          leaseUntil: 0,
          leaseToken: "",
          lastError: "admin_confirmed_retry",
          responseCode: "ADMIN_CONFIRMED_RETRY",
          updateTime: now,
        };
      } else {
        if (row.status !== "UNKNOWN") throw new ValidateException("只有结果未知的投递可关闭而不重发");
        nextStatus = "DEAD";
        values = {
          status: nextStatus,
          availableTime: 0,
          leaseUntil: 0,
          leaseToken: "",
          lastError: "admin_closed_without_retry",
          responseCode: "ADMIN_CLOSED_NO_RETRY",
          updateTime: now,
        };
      }

      const updated = await tx.update(orderNotificationDelivery).set(values)
        .where(and(
          eq(orderNotificationDelivery.id, id),
          eq(orderNotificationDelivery.status, row.status),
        )).returning();
      if (!updated[0]) throw new Error("外部通知投递状态已变化");
      await tx.insert(orderNotificationDeliveryAction).values({
        deliveryId: id,
        requestKey: key,
        action,
        previousStatus: row.status,
        nextStatus,
        adminId,
        reason,
        providerReference: effectiveProviderReference,
        addTime: now,
      });
      return { duplicate: false, delivery: deliveryAdminProjection(updated[0]) };
    });
  }
}
