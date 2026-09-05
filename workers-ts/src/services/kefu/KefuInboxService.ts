import { and, desc, eq, exists, isNull, lt, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { storeService, systemMessage, user } from "@/models/schema";
import { AuthException, NotFoundException, ValidateException } from "@/utils/errors";

export interface KefuInboxPrincipal { id: number; uid: number }

export function inboxInteger(value: unknown, fallback: number, maximum = 2_147_483_647): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" && typeof value !== "number") throw new ValidateException("消息分页参数无效");
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new ValidateException("消息分页参数无效");
  }
  return Number(value);
}

/** Recipient flags are authority, not a preference cached in a login token. */
export function eligibleKefuInboxAccount(principal?: KefuInboxPrincipal) {
  return and(
    eq(storeService.accountStatus, 1), eq(storeService.status, 1), eq(storeService.notify, 1),
    eq(storeService.isDel, 0), eq(storeService.merId, 0), sql`${storeService.uid} > 0`,
    principal ? and(eq(storeService.id, principal.id), eq(storeService.uid, principal.uid)) : undefined,
    eq(user.uid, storeService.uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime),
  );
}

const projection = {
  id: systemMessage.id, title: systemMessage.title, content: systemMessage.content,
  mark: systemMessage.mark, look: systemMessage.look, add_time: systemMessage.addTime,
};

/** No global messages or ordinary-user messages enter the staff security domain. */
export class KefuInboxService {
  constructor(private readonly container: Container) {}

  private async authorized(tx: DbClient, principal: KefuInboxPrincipal): Promise<void> {
    if (!Number.isSafeInteger(principal.id) || principal.id <= 0 || !Number.isSafeInteger(principal.uid) || principal.uid <= 0) {
      throw new AuthException("客服身份无效");
    }
    const [active] = await tx.select({ id: storeService.id }).from(storeService)
      .innerJoin(user, eq(user.uid, storeService.uid)).where(eligibleKefuInboxAccount(principal)).limit(1);
    if (!active) throw new AuthException("客服通知权限已关闭");
  }

  private visible(tx: DbClient, principal: KefuInboxPrincipal) {
    return and(eq(systemMessage.userId, principal.uid), eq(systemMessage.type, 2),
      eq(systemMessage.status, 1), eq(systemMessage.isDel, 0),
      // Keep authority in the actual read/write statement as well as the error check.
      exists(tx.select({ id: storeService.id }).from(storeService).innerJoin(user, eq(user.uid, storeService.uid))
        .where(eligibleKefuInboxAccount(principal))));
  }

  async list(principal: KefuInboxPrincipal, params: { cursor?: unknown; limit?: unknown; unread?: unknown } = {}) {
    const cursor = inboxInteger(params.cursor, 0), limit = inboxInteger(params.limit, 20, 50);
    if (params.unread !== undefined && !["0", "1", 0, 1].includes(params.unread as string | number)) throw new ValidateException("未读筛选无效");
    const unreadOnly = String(params.unread ?? "0") === "1";
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await this.authorized(tx, principal);
      const visible = this.visible(tx, principal);
      const rows = await tx.select(projection).from(systemMessage)
        .where(and(visible, cursor ? lt(systemMessage.id, cursor) : undefined, unreadOnly ? eq(systemMessage.look, 0) : undefined))
        .orderBy(desc(systemMessage.id)).limit(limit + 1);
      const [count] = await tx.select({ count: sql<string>`count(*)::text` }).from(systemMessage)
        .where(and(visible, eq(systemMessage.look, 0)));
      const unread = Number(count?.count);
      if (!Number.isSafeInteger(unread) || unread < 0) throw new Error("客服未读数量无效");
      const list = rows.slice(0, limit);
      return { list, unread_count: unread, next_cursor: rows.length > limit ? list.at(-1)!.id : null };
    });
  }

  async detail(principal: KefuInboxPrincipal, id: number) {
    inboxInteger(id, 0);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await this.authorized(tx, principal);
      const [row] = await tx.select(projection).from(systemMessage)
        .where(and(eq(systemMessage.id, id), this.visible(tx, principal))).limit(1);
      if (!row) throw new NotFoundException("消息不存在");
      return row;
    });
  }

  async markRead(principal: KefuInboxPrincipal, id: number) {
    inboxInteger(id, 0);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
      await this.authorized(tx, principal);
      const [row] = await tx.update(systemMessage).set({ look: 1 })
        .where(and(eq(systemMessage.id, id), this.visible(tx, principal))).returning({ id: systemMessage.id });
      if (!row) throw new NotFoundException("消息不存在");
      return { id: row.id, look: 1 };
    });
  }
}
