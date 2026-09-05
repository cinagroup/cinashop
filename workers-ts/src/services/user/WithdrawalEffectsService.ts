import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  capitalFlow, notificationTemplate, storeOrderOutbox, systemMessage, systemNotification,
  user, userExtract, wechatUser, type OrderNotificationChannel,
  type OrderNotificationDeliveryPayload, type WithdrawalNoticeOutboxPayload,
} from "@/models/schema";
import { centsToDecimal, decimalToCents } from "@/services/order/OrderBrokerageService";
import { createImmutableDelivery, type OrderNotificationOutboxEvent } from "@/services/order/OrderNotificationOutboxService";

export const WITHDRAWAL_APPROVED_EVENT = "withdrawal.approved.notice";
export const WITHDRAWAL_REFUSED_EVENT = "withdrawal.refused.notice";
export function isWithdrawalNoticeEvent(type: string): boolean {
  return type === WITHDRAWAL_APPROVED_EVENT || type === WITHDRAWAL_REFUSED_EVENT;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** Only the business transaction calls this: no Queue or provider I/O under the user lock. */
export async function recordWithdrawalEffects(
  tx: DbClient,
  request: { id: number; uid: number; extractType: string; extractPrice: string; extractFee: string },
  account: { nickname: string; phone: string },
  rejected: boolean,
  reason: string,
  now: number,
): Promise<void> {
  const eventType = rejected ? WITHDRAWAL_REFUSED_EVENT : WITHDRAWAL_APPROVED_EVENT;
  const eventKey = `${eventType}:${request.id}`;
  const payload: WithdrawalNoticeOutboxPayload = {
    withdrawalId: request.id, userId: request.uid, netAmount: request.extractPrice,
    grossAmount: centsToDecimal(decimalToCents(request.extractPrice) + decimalToCents(request.extractFee)),
    nickname: account.nickname, reason: rejected ? reason : "", occurredAt: now,
  };
  const [inserted] = await tx.insert(storeOrderOutbox).values({
    eventKey, aggregateType: "withdrawal", aggregateId: request.id, eventType, payload,
    status: "PENDING", availableTime: now, addTime: now, updateTime: now,
  }).onConflictDoNothing({ target: storeOrderOutbox.eventKey }).returning({ id: storeOrderOutbox.id });
  if (!inserted) {
    const [existing] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, eventKey)).limit(1);
    if (!existing || existing.aggregateType !== "withdrawal" || existing.aggregateId !== request.id
      || existing.eventType !== eventType || canonical(existing.payload) !== canonical(payload)) {
      throw new Error("提现通知不可变事件冲突");
    }
  }
  if (rejected) return;
  // A stable withdrawal reference replaces PHP's bank-account-as-order-id; never imply a store order.
  const flow = {
    eventKey, flowId: `withdrawal-${request.id}`, orderId: `withdrawal:${request.id}`,
    uid: request.uid, storeId: 0, nickname: account.nickname, phone: account.phone,
    price: `-${centsToDecimal(decimalToCents(request.extractPrice))}`, tradingType: 6,
    payType: request.extractType, addTime: now,
  };
  const [created] = await tx.insert(capitalFlow).values(flow)
    .onConflictDoNothing({ target: capitalFlow.eventKey }).returning({ id: capitalFlow.id });
  if (!created) {
    const [existing] = await tx.select().from(capitalFlow).where(eq(capitalFlow.eventKey, eventKey)).limit(1);
    if (!existing || Object.entries(flow).some(([key, value]) => existing[key as keyof typeof existing] !== value)) {
      throw new Error("提现成功资金流水不可变事件冲突");
    }
  }
}

function assertPayload(value: unknown, event: OrderNotificationOutboxEvent): asserts value is WithdrawalNoticeOutboxPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("提现通知载荷无效");
  const p = value as Partial<WithdrawalNoticeOutboxPayload>;
  const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
  if (!isWithdrawalNoticeEvent(event.eventType) || !positive(p.withdrawalId) || !positive(p.userId)
    || event.aggregateId !== p.withdrawalId || event.eventKey !== `${event.eventType}:${p.withdrawalId}`
    || !positive(p.occurredAt) || typeof p.nickname !== "string" || [...p.nickname].length > 255
    || typeof p.reason !== "string" || [...p.reason].length > 255
    || typeof p.netAmount !== "string" || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(p.netAmount)
    || typeof p.grossAmount !== "string" || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(p.grossAmount)
    || decimalToCents(p.netAmount) <= 0 || decimalToCents(p.grossAmount) < decimalToCents(p.netAmount)
    || (event.eventType === WITHDRAWAL_APPROVED_EVENT && p.reason !== "")) {
    throw new Error("提现通知载荷与事件不匹配");
  }
}

async function templateCode(tx: DbClient, mark: string, legacy: string, legacyType: 0 | 1): Promise<string> {
  // Admin writes semantic marks; PHP's catalogue used 51729/1470. Never silently choose duplicates.
  const rows = await tx.select({ code: notificationTemplate.tempid }).from(notificationTemplate)
    .where(and(inArray(notificationTemplate.mark, [mark, legacy]), eq(notificationTemplate.legacyType, legacyType), eq(notificationTemplate.status, 1)))
    .limit(2);
  if (rows.length > 1) throw new Error("提现渠道模板存在重复启用来源");
  return rows[0]?.code.trim() ?? "";
}

/** Called by the durable outbox consumer after the withdrawal transaction commits. DB work only. */
export async function processWithdrawalNoticeEvent(
  tx: DbClient, event: OrderNotificationOutboxEvent & { aggregateType: string }, now: number,
): Promise<void> {
  if (event.aggregateType !== "withdrawal") throw new Error("提现通知聚合类型无效");
  assertPayload(event.payload, event);
  const payload = event.payload;
  const rejected = event.eventType === WITHDRAWAL_REFUSED_EVENT;
  const [request] = await tx.select().from(userExtract).where(eq(userExtract.id, payload.withdrawalId)).limit(1);
  if (!request || request.uid !== payload.userId || request.status !== (rejected ? -1 : 1)
    || request.extractPrice !== payload.netAmount
    || decimalToCents(request.extractPrice) + decimalToCents(request.extractFee) !== decimalToCents(payload.grossAmount)
    || (rejected && request.failMsg !== payload.reason)) throw new Error("提现通知与申请终态不匹配");
  const mark = rejected ? "user_balance_change" : "user_extract";
  const configs = await tx.select().from(systemNotification).where(eq(systemNotification.mark, mark)).limit(2);
  if (configs.length > 1) throw new Error("提现通知存在重复配置来源");
  const config = configs[0];
  if (!config) return;
  const [account] = await tx.select({ phone: user.phone }).from(user).where(eq(user.uid, payload.userId)).limit(1);
  if (!account) throw new Error("提现通知用户不存在");
  const date = new Date((payload.occurredAt + 8 * 3600) * 1000).toISOString().slice(0, 19).replace("T", " ");
  const amount = rejected ? payload.grossAmount : payload.netAmount;
  const values: Record<string, string> = { extract_number: amount, nickname: payload.nickname, date, message: payload.reason };
  const render = (text: string) => text.replace(/\{(extract_number|nickname|date|message)\}/g, (_, key: string) => values[key]);
  if (config.isSystem === 1) {
    const title = render(config.systemTitle), content = render(config.systemText);
    if ([...title].length > 256 || content.length > 65536) throw new Error("提现站内通知渲染长度超限");
    const message = { eventKey: event.eventKey, mark, title, content, userId: payload.userId, look: 0, type: 1, status: 1, addTime: now, isDel: 0 };
    const [inserted] = await tx.insert(systemMessage).values(message).onConflictDoNothing({ target: systemMessage.eventKey }).returning({ id: systemMessage.id });
    if (!inserted) {
      const [existing] = await tx.select().from(systemMessage).where(eq(systemMessage.eventKey, event.eventKey)).limit(1);
      if (!existing || existing.userId !== payload.userId || existing.mark !== mark || existing.title !== title || existing.content !== content) {
        throw new Error("提现站内通知不可变事件冲突");
      }
    }
  }
  const stage = async (channel: OrderNotificationChannel, target: string, code: string, data: OrderNotificationDeliveryPayload) => {
    await createImmutableDelivery(tx, {
      event, payload: { withdrawalId: payload.withdrawalId, userId: payload.userId }, mark, channel, target,
      templateCode: code, deliveryPayload: data, now,
      skipReason: !target ? "target_not_configured" : !code ? "template_not_configured" : undefined,
    });
  };
  if (config.isSms === 1) await stage("sms", account.phone.trim(), config.smsId.trim(), { kind: "sms", params: { extract_number: amount } });
  const openid = async (type: string) => {
    const rows = await tx.select({ openid: wechatUser.openid }).from(wechatUser)
      .where(and(eq(wechatUser.uid, payload.userId), eq(wechatUser.userType, type))).orderBy(desc(wechatUser.id)).limit(2);
    if (rows.length > 1) throw new Error("提现通知微信身份存在重复来源");
    return rows[0]?.openid.trim() ?? "";
  };
  // PHP intentionally disabled official-account rejection notices.
  if (!rejected && config.isWechat === 1) {
    await stage("wechat_official", await openid("wechat"), await templateCode(tx, mark, "51729", 1), {
      kind: "wechat_official", data: { amount3: amount, time4: date }, url: "",
    });
  }
  if (config.isRoutine === 1) {
    await stage("wechat_routine", await openid("routine"), await templateCode(tx, mark, "1470", 0), {
      kind: "wechat_routine", url: "pages/user/finance",
      data: {
        thing1: [...(rejected ? `提现失败：${payload.reason}` : "提现成功")].slice(0, 20).join(""),
        amount2: `${amount}元`, thing3: [...payload.nickname].slice(0, 20).join(""), date4: date,
      },
    });
  }
}
