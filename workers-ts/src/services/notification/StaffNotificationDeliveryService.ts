import { and, eq, sql } from "drizzle-orm";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import { storeOrderOutbox, systemAdmin, systemMessage, userExtract, type StoreOrderOutbox } from "@/models/schema";
import { AdminPermissionService } from "@/services/admin/AdminPermissionService";
import { parseStaffEventKey, STAFF_REFRESH_EVENT, staffPrincipalName, type StaffPrincipal } from "./StaffNotificationProtocol";

export interface StaffPublisher {
  // Narrow application port: the generated Cloudflare RPC stub structurally satisfies it.
  getByName(name: string): { publish(principal: StaffPrincipal, key: string): Promise<{ revision: number; connected: number }> };
}
/** PostgreSQL keeps the retry fact; no network I/O runs under a transaction/row lock. */
export async function deliverStaffRefresh(container: Container, publisher: StaffPublisher, event: StoreOrderOutbox): Promise<void> {
  parseStaffEventKey(event.eventKey);
  if (event.eventType !== STAFF_REFRESH_EVENT || event.aggregateType !== "withdrawal"
    || event.eventKey !== `${STAFF_REFRESH_EVENT}:${event.aggregateId}`
    || !("withdrawalId" in event.payload) || event.payload.withdrawalId !== event.aggregateId) throw new Error("通知刷新事件无效");
  const targets = await withTx(container, async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const parentKey = `withdrawal.applied.notice:${event.aggregateId}`;
    const [parent] = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.eventKey, parentKey), eq(storeOrderOutbox.status, "COMPLETED"))).limit(1);
    const [request] = await tx.select({ id: userExtract.id }).from(userExtract).where(eq(userExtract.id, event.aggregateId)).limit(1);
    if (!parent || !request || parent.aggregateId !== request.id || parent.aggregateType !== "withdrawal"
      || parent.eventType !== "withdrawal.applied.notice" || !("withdrawalId" in parent.payload)
      || parent.payload.withdrawalId !== event.aggregateId) throw new Error("通知刷新缺少已完成申请事件");
    const admins = await tx.select().from(systemAdmin).where(and(eq(systemAdmin.adminType, 1), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1001);
    const kefu = await tx.selectDistinct({ id: systemMessage.userId }).from(systemMessage).where(and(
      sql`${systemMessage.eventKey} LIKE ${`${parentKey}:kefu:%`}`, eq(systemMessage.type, 2),
      eq(systemMessage.status, 1), eq(systemMessage.isDel, 0), sql`${systemMessage.userId} > 0`)).limit(1001);
    if (admins.length > 1000 || kefu.length > 1000) throw new Error("实时通知收件人数超出单批上限");
    const permissions = await new AdminPermissionService(createContainerFromDb(tx)).resolveManyAdminPermissionKeys(admins);
    const result: StaffPrincipal[] = admins.filter((_, index) => permissions[index].has("extract.view")).map((admin) => ({ audience: "admin", id: admin.id }));
    result.push(...kefu.map(({ id }) => ({ audience: "kefu" as const, id })));
    return result;
  });
  // Bound concurrency. A partial RPC failure leaves the root retryable; DO revisions deduplicate.
  for (let start = 0; start < targets.length; start += 5) {
    const results = await Promise.allSettled(targets.slice(start, start + 5).map((target) => publisher.getByName(staffPrincipalName(target)).publish(target, event.eventKey)));
    if (results.some((result) => result.status === "rejected")) throw new Error("实时通知分发未确认，等待重试");
  }
}
