import { and, desc, eq, or, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  kefuVisitorSession,
  storeService,
  storeServiceRecord,
  storeServiceTransfer,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CHAT_LOCK_NAMESPACE = 91310002;
const TRANSFER_LOCK_NAMESPACE = 91310003;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidateException(`${label}无效`);
  return parsed;
}

function touristFlag(value: unknown): 0 | 1 {
  const parsed = Number(value ?? 0);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException("游客状态无效");
  return parsed;
}

export function parseTransferRequestKey(value: unknown): string {
  if (value === undefined || value === null || value === "") return crypto.randomUUID();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidateException("转接请求键无效");
  }
  return value.toLowerCase();
}

export interface KefuTransferRecord {
  id: number;
  user_id: number;
  to_uid: number;
  nickname: string;
  avatar: string;
  is_tourist: number;
  online: number;
  type: number;
  add_time: number;
  update_time: number;
  mssage_num: number;
  message: string;
  message_type: number;
}

export interface KefuTransferResult {
  request_key: string;
  idempotent: boolean;
  uid: number;
  from_uid: number;
  to_uid: number;
  copied_message_count: number;
  is_tourist: 0 | 1;
  recored: KefuTransferRecord | null;
  kefuInfo: { uid: number; nickname: string; avatar: string };
  targetInfo: { uid: number; nickname: string; avatar: string; online: number };
}

function mapRecord(row: typeof storeServiceRecord.$inferSelect): KefuTransferRecord {
  return {
    id: row.id,
    user_id: row.userId,
    to_uid: row.toUid,
    nickname: row.nickname,
    avatar: row.avatar,
    is_tourist: row.isTourist,
    online: row.online,
    type: row.type,
    add_time: row.addTime,
    update_time: row.updateTime,
    mssage_num: row.messageNum,
    message: row.message,
    message_type: row.messageType,
  };
}

async function lockConversation(
  db: DbClient,
  kefuUid: number,
  customerUid: number,
  isTourist: 0 | 1,
): Promise<void> {
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${CHAT_LOCK_NAMESPACE},
      hashtext(${`kefu:${kefuUid}:customer:${isTourist}:${customerUid}`})
    )
  `);
}

async function targetProfile(db: DbClient, targetUid: number) {
  const rows = await db
    .select({
      id: storeService.id,
      uid: storeService.uid,
      nickname: storeService.nickname,
      avatar: storeService.avatar,
      online: storeService.online,
    })
    .from(storeService)
    .where(and(
      eq(storeService.uid, targetUid),
      eq(storeService.isDel, 0),
      eq(storeService.status, 1),
      eq(storeService.accountStatus, 1),
      eq(storeService.online, 1),
    ))
    .limit(2)
    .for("update");
  if (rows.length !== 1) throw new NotFoundException("目标客服不存在、未在线或身份不唯一");
  return rows[0];
}

export class KefuTransferService {
  constructor(private readonly container: Container) {}

  async transfer(
    fromServiceIdValue: unknown,
    fromKefuUidValue: unknown,
    input: Record<string, unknown>,
  ): Promise<KefuTransferResult> {
    const fromServiceId = positiveInteger(fromServiceIdValue, "客服身份");
    const fromKefuUid = positiveInteger(fromKefuUidValue, "客服聊天身份");
    const customerUid = positiveInteger(input.uid, "转接用户");
    const isTourist = touristFlag(input.is_tourist ?? input.isTourist);
    const toKefuUid = positiveInteger(input.kefuToUid ?? input.kefu_to_uid, "目标客服");
    if (customerUid === toKefuUid || fromKefuUid === toKefuUid) {
      throw new ValidateException("自己不能转接给自己");
    }
    const requestKey = parseTransferRequestKey(input.request_key ?? input.requestKey);

    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '10s'"));
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${TRANSFER_LOCK_NAMESPACE},
          hashtext(${`kefu-transfer:key:${requestKey}`})
        )
      `);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${TRANSFER_LOCK_NAMESPACE},
          hashtext(${`kefu-transfer:customer:${isTourist}:${customerUid}`})
        )
      `);
      for (const kefuUid of [fromKefuUid, toKefuUid].sort((a, b) => a - b)) {
        await lockConversation(tx, kefuUid, customerUid, isTourist);
      }

      const existingAudit = (
        await tx
          .select()
          .from(storeServiceTransfer)
          .where(eq(storeServiceTransfer.requestKey, requestKey))
          .limit(1)
      )[0];
      if (existingAudit) {
        if (
          existingAudit.customerUid !== customerUid ||
          existingAudit.fromKefuUid !== fromKefuUid ||
          existingAudit.toKefuUid !== toKefuUid ||
          existingAudit.fromServiceId !== fromServiceId
          || existingAudit.isTourist !== isTourist
        ) throw new ValidateException("转接请求键已用于其他操作");
        const [sourceInfo, targetInfo] = await Promise.all([
          tx.select({ uid: storeService.uid, nickname: storeService.nickname, avatar: storeService.avatar })
            .from(storeService).where(eq(storeService.id, existingAudit.fromServiceId)).limit(1),
          tx.select({ uid: storeService.uid, nickname: storeService.nickname, avatar: storeService.avatar, online: storeService.online })
            .from(storeService).where(eq(storeService.id, existingAudit.toServiceId)).limit(1),
        ]);
        if (!sourceInfo[0] || !targetInfo[0]) throw new NotFoundException("转接审计关联的客服不存在");
        return {
          request_key: requestKey,
          idempotent: true,
          uid: customerUid,
          from_uid: fromKefuUid,
          to_uid: toKefuUid,
          copied_message_count: existingAudit.copiedMessageCount,
          is_tourist: isTourist,
          recored: null,
          kefuInfo: sourceInfo[0],
          targetInfo: targetInfo[0],
        };
      }

      const sourceServices = await tx
        .select({ id: storeService.id, uid: storeService.uid, nickname: storeService.nickname, avatar: storeService.avatar })
        .from(storeService)
        .where(and(
          eq(storeService.id, fromServiceId),
          eq(storeService.uid, fromKefuUid),
          eq(storeService.isDel, 0),
          eq(storeService.status, 1),
          eq(storeService.accountStatus, 1),
        ))
        .limit(2)
        .for("update");
      if (sourceServices.length !== 1) throw new NotFoundException("当前客服身份已失效");
      const sourceInfo = sourceServices[0];
      const targetInfo = await targetProfile(tx, toKefuUid);

      if (isTourist === 1) {
        const visitor = await tx
          .select({ visitorUid: kefuVisitorSession.visitorUid })
          .from(kefuVisitorSession)
          .where(and(
            eq(kefuVisitorSession.visitorUid, customerUid),
            eq(kefuVisitorSession.serviceId, fromServiceId),
            eq(kefuVisitorSession.kefuUid, fromKefuUid),
            eq(kefuVisitorSession.revokedAt, 0),
            sql`${kefuVisitorSession.expiresAt} > ${Math.floor(Date.now() / 1_000)}`,
          ))
          .limit(1)
          .for("update");
        if (visitor.length !== 1) throw new NotFoundException("游客会话不存在、已过期或已转接");
      }

      const sourceRecords = await tx
        .select()
        .from(storeServiceRecord)
        .where(and(
          eq(storeServiceRecord.userId, fromKefuUid),
          eq(storeServiceRecord.toUid, customerUid),
          eq(storeServiceRecord.isTourist, isTourist),
        ))
        .orderBy(desc(storeServiceRecord.id))
        .limit(2)
        .for("update");
      if (!sourceRecords.length) throw new NotFoundException("当前客服与该用户没有可转接会话");
      if (sourceRecords.length > 1) throw new ValidateException("当前会话存在重复归属，请先修复数据");
      const sourceRecord = sourceRecords[0];

      const targetRecords = await tx
        .select()
        .from(storeServiceRecord)
        .where(and(
          eq(storeServiceRecord.userId, toKefuUid),
          eq(storeServiceRecord.toUid, customerUid),
          eq(storeServiceRecord.isTourist, isTourist),
        ))
        .orderBy(desc(storeServiceRecord.id))
        .limit(2)
        .for("update");
      if (targetRecords.length > 1) throw new ValidateException("目标客服会话存在重复归属，请先修复数据");

      const now = Math.floor(Date.now() / 1000);
      const copied = await tx.execute(sql`
        WITH copied AS (
          INSERT INTO "store_service_log" (
            "mer_id", "msn", "uid", "to_uid", "is_tourist",
            "time_node", "add_time", "type", "remind", "msn_type"
          )
          SELECT
            "mer_id", "msn",
            CASE WHEN "uid" = ${fromKefuUid} THEN ${toKefuUid} ELSE "uid" END,
            CASE WHEN "to_uid" = ${fromKefuUid} THEN ${toKefuUid} ELSE "to_uid" END,
            "is_tourist", "time_node", ${now}, "type", "remind", "msn_type"
          FROM "store_service_log"
          WHERE (
            ("uid" = ${fromKefuUid} AND "to_uid" = ${customerUid}) OR
            ("uid" = ${customerUid} AND "to_uid" = ${fromKefuUid})
          ) AND "is_tourist" = ${isTourist}
          ORDER BY "id" ASC
          RETURNING "id"
        )
        SELECT count(*)::int AS count FROM copied
      `) as unknown as Array<{ count: number }>;
      const copiedMessageCount = Number(copied[0]?.count ?? 0);

      let targetRecord: typeof storeServiceRecord.$inferSelect;
      if (targetRecords[0]) {
        targetRecord = (
          await tx.update(storeServiceRecord).set({
            nickname: sourceRecord.nickname,
            avatar: sourceRecord.avatar,
            online: sourceRecord.online,
            type: sourceRecord.type,
            updateTime: now,
            messageNum: sourceRecord.messageNum,
            message: sourceRecord.message,
            messageType: sourceRecord.messageType,
          }).where(eq(storeServiceRecord.id, targetRecords[0].id)).returning()
        )[0];
      } else {
        targetRecord = (
          await tx.insert(storeServiceRecord).values({
            userId: toKefuUid,
            toUid: customerUid,
            nickname: sourceRecord.nickname,
            avatar: sourceRecord.avatar,
            isTourist,
            online: sourceRecord.online,
            type: sourceRecord.type,
            addTime: now,
            updateTime: now,
            messageNum: sourceRecord.messageNum,
            message: sourceRecord.message,
            messageType: sourceRecord.messageType,
          }).returning()
        )[0];
      }

      const userSideRecords = await tx
        .select()
        .from(storeServiceRecord)
        .where(and(
          eq(storeServiceRecord.userId, customerUid),
          or(eq(storeServiceRecord.toUid, fromKefuUid), eq(storeServiceRecord.toUid, toKefuUid)),
          eq(storeServiceRecord.isTourist, isTourist),
        ))
        .orderBy(desc(storeServiceRecord.updateTime), desc(storeServiceRecord.id))
        .for("update");
      const targetUserSide = userSideRecords.find((row) => row.toUid === toKefuUid);
      const sourceUserSide = userSideRecords.find((row) => row.toUid === fromKefuUid);
      const userSummary = sourceUserSide ?? targetUserSide;
      if (targetUserSide) {
        await tx.update(storeServiceRecord).set({
          nickname: targetInfo.nickname,
          avatar: targetInfo.avatar,
          online: targetInfo.online,
          type: 2,
          updateTime: now,
          message: userSummary?.message ?? sourceRecord.message,
          messageType: userSummary?.messageType ?? sourceRecord.messageType,
        }).where(eq(storeServiceRecord.id, targetUserSide.id));
      } else if (userSummary) {
        await tx.insert(storeServiceRecord).values({
          userId: customerUid,
          toUid: toKefuUid,
          nickname: targetInfo.nickname,
          avatar: targetInfo.avatar,
          isTourist,
          online: targetInfo.online,
          type: 2,
          addTime: now,
          updateTime: now,
          messageNum: userSummary.messageNum,
          message: userSummary.message,
          messageType: userSummary.messageType,
        });
      }

      await tx.delete(storeServiceRecord).where(and(
        eq(storeServiceRecord.userId, fromKefuUid),
        eq(storeServiceRecord.toUid, customerUid),
        eq(storeServiceRecord.isTourist, isTourist),
      ));
      await tx.delete(storeServiceRecord).where(and(
        eq(storeServiceRecord.userId, customerUid),
        eq(storeServiceRecord.toUid, fromKefuUid),
        eq(storeServiceRecord.isTourist, isTourist),
      ));

      if (isTourist === 1) {
        const updated = await tx.update(kefuVisitorSession).set({
          serviceId: targetInfo.id,
          kefuUid: toKefuUid,
          lastSeenAt: now,
        }).where(and(
          eq(kefuVisitorSession.visitorUid, customerUid),
          eq(kefuVisitorSession.serviceId, fromServiceId),
          eq(kefuVisitorSession.kefuUid, fromKefuUid),
          eq(kefuVisitorSession.revokedAt, 0),
        )).returning({ visitorUid: kefuVisitorSession.visitorUid });
        if (updated.length !== 1) throw new ValidateException("游客会话转接发生并发冲突");
      }

      await tx.insert(storeServiceTransfer).values({
        requestKey,
        customerUid,
        fromKefuUid,
        toKefuUid,
        fromServiceId,
        toServiceId: targetInfo.id,
        sourceRecordId: sourceRecord.id,
        targetRecordId: targetRecord.id,
        copiedMessageCount,
        isTourist,
        createdAt: now,
      });

      return {
        request_key: requestKey,
        idempotent: false,
        uid: customerUid,
        from_uid: fromKefuUid,
        to_uid: toKefuUid,
        copied_message_count: copiedMessageCount,
        is_tourist: isTourist,
        recored: mapRecord(targetRecord),
        kefuInfo: { uid: sourceInfo.uid, nickname: sourceInfo.nickname, avatar: sourceInfo.avatar },
        targetInfo: { uid: targetInfo.uid, nickname: targetInfo.nickname, avatar: targetInfo.avatar, online: targetInfo.online },
      };
    });
  }
}
