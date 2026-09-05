import { asc, eq, sql } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeOrderOutbox, storeService, systemMessage, systemNotification, user, userExtract,
  type WithdrawalApplicationOutboxPayload } from "@/models/schema";
import { centsToDecimal, decimalToCents } from "@/services/order/OrderBrokerageService";
import { eligibleKefuInboxAccount } from "@/services/kefu/KefuInboxService";
import { STAFF_REFRESH_EVENT } from "@/services/notification/StaffNotificationProtocol";

export const WITHDRAWAL_APPLICATION_EVENT = "withdrawal.applied.notice";
export const WITHDRAWAL_APPLICATION_MARK = "kefu_send_extract_application";

/** Application + debit + immutable event commit together, including automatic balance approval. */
export async function recordWithdrawalApplication(tx: DbClient, payload: WithdrawalApplicationOutboxPayload): Promise<void> {
  // A successful intent replay returns before this helper. A duplicate ID here is an invariant failure.
  await tx.insert(storeOrderOutbox).values({
    eventKey: `${WITHDRAWAL_APPLICATION_EVENT}:${payload.withdrawalId}`, aggregateType: "withdrawal",
    aggregateId: payload.withdrawalId, eventType: WITHDRAWAL_APPLICATION_EVENT, payload,
    status: "PENDING", availableTime: payload.occurredAt, addTime: payload.occurredAt, updateTime: payload.occurredAt,
  });
}

function assertPayload(value: unknown): asserts value is WithdrawalApplicationOutboxPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("提现申请提醒载荷无效");
  const p = value as Partial<WithdrawalApplicationOutboxPayload>;
  if (!Number.isSafeInteger(p.withdrawalId) || Number(p.withdrawalId) <= 0
    || !Number.isSafeInteger(p.userId) || Number(p.userId) <= 0
    || !Number.isSafeInteger(p.occurredAt) || Number(p.occurredAt) <= 0
    || typeof p.nickname !== "string" || [...p.nickname].length > 60
    || typeof p.grossAmount !== "string" || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(p.grossAmount)
    || decimalToCents(p.grossAmount) <= 0) throw new Error("提现申请提醒载荷无效");
}

/** Durable DB-only fan-out. The existing Queue scanner retries crashes and lost dispatches. */
export async function processWithdrawalApplication(tx: DbClient, event: {
  aggregateType: string; aggregateId: number; eventType: string; eventKey: string; payload: unknown;
}, now: number): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
  assertPayload(event.payload);
  const p = event.payload;
  if (event.aggregateType !== "withdrawal" || event.eventType !== WITHDRAWAL_APPLICATION_EVENT
    || event.aggregateId !== p.withdrawalId || event.eventKey !== `${WITHDRAWAL_APPLICATION_EVENT}:${p.withdrawalId}`) {
    throw new Error("提现申请提醒事件不匹配");
  }
  const [request] = await tx.select().from(userExtract).where(eq(userExtract.id, p.withdrawalId)).limit(1);
  // Review may finish before the asynchronous consumer. The historical application still happened.
  if (!request || request.uid !== p.userId || request.addTime !== p.occurredAt
    || ![0, 1, -1].includes(request.status)
    || centsToDecimal(decimalToCents(request.extractPrice) + decimalToCents(request.extractFee)) !== p.grossAmount) {
    throw new Error("提现申请提醒与原申请不匹配");
  }
  // Durable child dispatch survives a crash after inbox creation or after any partial live fan-out.
  await tx.insert(storeOrderOutbox).values({ eventKey: `${STAFF_REFRESH_EVENT}:${p.withdrawalId}`,
    eventType: STAFF_REFRESH_EVENT, aggregateType: "withdrawal", aggregateId: p.withdrawalId,
    payload: { withdrawalId: p.withdrawalId }, status: "PENDING", availableTime: now, addTime: now, updateTime: now });
  const configs = await tx.select().from(systemNotification).where(eq(systemNotification.mark, WITHDRAWAL_APPLICATION_MARK)).limit(2);
  if (configs.length > 1) throw new Error("客服提现通知存在重复配置来源");
  const config = configs[0];
  if (!config || config.isSystem !== 1) return;
  // PHP addresses the bound UID, not the staff-account ID. Choose its lowest active staff ID
  // deterministically; do not send a duplicate or choose an arbitrary recipient nickname.
  const recipients = await tx.selectDistinctOn([storeService.uid], { uid: storeService.uid, nickname: storeService.nickname })
    .from(storeService).innerJoin(user, eq(user.uid, storeService.uid)).where(eligibleKefuInboxAccount())
    .orderBy(asc(storeService.uid), asc(storeService.id)).limit(1001);
  if (recipients.length > 1000) throw new Error("客服通知收件人数超出单批上限，事件保留待处理");
  const messages = recipients.map((recipient) => {
    const values: Record<string, string> = { nickname: p.nickname, money: p.grossAmount, admin_name: recipient.nickname };
    // Single-pass substitution: user-controlled placeholder-like text is never expanded again.
    const render = (template: string) => template.replace(/\{(nickname|money|admin_name)\}/g, (_, key: string) => values[key]);
    const title = render(config.systemTitle), content = render(config.systemText);
    if ([...title].length > 256 || content.length > 65536) throw new Error("客服提现通知渲染长度超限");
    return { eventKey: `${event.eventKey}:kefu:${recipient.uid}`, userId: recipient.uid,
      mark: WITHDRAWAL_APPLICATION_MARK, type: 2, title, content, look: 0, status: 1, isDel: 0, addTime: now };
  });
  // No partial recipient set commits if a row fails. The outbox completion shares this transaction.
  for (let index = 0; index < messages.length; index += 100) {
    await tx.insert(systemMessage).values(messages.slice(index, index + 100));
  }
}
