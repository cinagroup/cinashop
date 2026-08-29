import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  kefuVisitorSession,
  storeService,
  storeServiceLog,
  storeServiceRecord,
  systemAttachment,
  user as userTable,
} from "@/models/schema";
import type { ChatRole } from "@/services/kefu/KefuSocketGateway";
import {
  canonicalAttachmentPath,
  parseCanonicalAttachmentId,
  R2_IMAGE_TYPE,
  signAttachmentReferences,
} from "@/services/system/AttachmentService";
import { getTokenBucket } from "@/utils/cache";
import { AuthException, NotFoundException, ValidateException } from "@/utils/errors";
import { md5 } from "@/utils/jwt";

const CHAT_LOCK_NAMESPACE = 91310002;
const MAX_CHAT_MESSAGE_LENGTH = 2_000;
const MAX_CHAT_HISTORY_LIMIT = 100;

type RealtimeEnv = Pick<Env, "UPSTASH_REDIS_URL" | "UPSTASH_REDIS_TOKEN" | "APP_KEY">;

export interface ChatSocketSession {
  principalUid: number;
  role: ChatRole;
  isTourist: 0 | 1;
  toUid: number;
  authId: number;
  tokenKey: string;
  expiresAt: number;
  authVersion: string;
  connectedAt: number;
}

export interface PersistedRealtimeMessage {
  id: number;
  uid: number;
  to_uid: number;
  msn: string;
  msn_type: number;
  add_time: number;
  is_tourist: 0 | 1;
  type: number;
  nickname: string;
  avatar: string;
  /** Internal delivery metadata; unlike recored.type this is not a PHP form-type field. */
  sender_role: ChatRole;
  recored: {
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
  };
}

export function parseChatRole(value: unknown): ChatRole {
  const parsed = Number(value);
  if (parsed !== 1 && parsed !== 2 && parsed !== 3) throw new ValidateException("聊天角色无效");
  return parsed;
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if ((value === undefined || value === null || value === "") && options.fallback !== undefined) {
    return options.fallback;
  }
  const parsed = Number(value);
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

export function sanitizeRealtimeMessage(value: unknown): string {
  if (typeof value !== "string") throw new ValidateException("消息内容无效");
  const normalized = value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!normalized || normalized.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new ValidateException("消息内容无效");
  }
  return normalized;
}

export function parseChatMessageType(value: unknown): number {
  return integer(value, "消息类型", { min: 1, max: 7 });
}

function mapMessage(row: typeof storeServiceLog.$inferSelect) {
  return {
    id: row.id,
    mer_id: row.merId,
    uid: row.uid,
    to_uid: row.toUid,
    msn: row.msn,
    is_tourist: row.isTourist,
    time_node: row.timeNode,
    add_time: row.addTime,
    type: row.type,
    remind: row.remind,
    msn_type: row.msnType,
  };
}

function mapRecord(row: typeof storeServiceRecord.$inferSelect) {
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

function assertSessionShape(session: ChatSocketSession): void {
  integer(session.principalUid, "聊天身份", { min: 1 });
  parseChatRole(session.role);
  integer(session.isTourist, "游客状态", { min: 0, max: 1 });
  if ((session.role === 1 && session.isTourist !== 0) || (session.role === 3 && session.isTourist !== 1)) {
    throw new AuthException("聊天身份与游客状态不匹配");
  }
  integer(session.toUid, "会话用户", { min: 0 });
  integer(session.authId, "认证身份", { min: 1 });
  integer(session.expiresAt, "登录有效期", { min: 1 });
  if (!/^[a-f0-9]{32}$/.test(session.tokenKey) || !session.authVersion) {
    throw new AuthException("聊天登录状态无效");
  }
}

async function assertDatabaseIdentity(db: DbClient, session: ChatSocketSession): Promise<void> {
  if (session.role === 2) {
    const rows = await db
      .select({
        id: storeService.id,
        uid: storeService.uid,
        password: storeService.password,
      })
      .from(storeService)
      .where(and(
        eq(storeService.id, session.authId),
        eq(storeService.uid, session.principalUid),
        eq(storeService.isDel, 0),
        eq(storeService.status, 1),
        eq(storeService.accountStatus, 1),
      ))
      .limit(2);
    if (rows.length !== 1 || md5(rows[0].password) !== session.authVersion) {
      throw new AuthException("客服登录状态已失效");
    }
    return;
  }

  if (session.role === 3) {
    const now = Math.floor(Date.now() / 1_000);
    const visitor = (
      await db
        .select({
          visitorUid: kefuVisitorSession.visitorUid,
          tokenHash: kefuVisitorSession.tokenHash,
        })
        .from(kefuVisitorSession)
        .where(and(
          eq(kefuVisitorSession.visitorUid, session.authId),
          eq(kefuVisitorSession.visitorUid, session.principalUid),
          eq(kefuVisitorSession.tokenHash, session.authVersion),
          eq(kefuVisitorSession.revokedAt, 0),
          sql`${kefuVisitorSession.expiresAt} > ${now}`,
        ))
        .limit(1)
    )[0];
    if (!visitor) throw new AuthException("游客会话已失效");
    return;
  }

  const user = (
    await db
      .select({ uid: userTable.uid, pwd: userTable.pwd })
      .from(userTable)
      .where(and(
        eq(userTable.uid, session.authId),
        eq(userTable.uid, session.principalUid),
        eq(userTable.status, 1),
        eq(userTable.isDel, 0),
      ))
      .limit(1)
  )[0];
  if (!user || (user.pwd !== md5("123456") && user.pwd !== session.authVersion)) {
    throw new AuthException("用户登录状态已失效");
  }
}

async function assertTarget(
  db: DbClient,
  session: ChatSocketSession,
  toUid: number,
): Promise<{ nickname: string; avatar: string }> {
  if (session.role === 1 || session.role === 3) {
    const services = await db
      .select({ nickname: storeService.nickname, avatar: storeService.avatar })
      .from(storeService)
      .where(and(
        eq(storeService.uid, toUid),
        eq(storeService.isDel, 0),
        eq(storeService.status, 1),
        eq(storeService.accountStatus, 1),
      ))
      .limit(2);
    if (services.length !== 1) throw new NotFoundException("客服不存在、已禁用或身份不唯一");
    return services[0];
  }

  if (session.isTourist === 1) {
    const visitor = (
      await db
        .select({ nickname: kefuVisitorSession.nickname, avatar: kefuVisitorSession.avatar })
        .from(kefuVisitorSession)
        .where(and(
          eq(kefuVisitorSession.visitorUid, toUid),
          eq(kefuVisitorSession.kefuUid, session.principalUid),
          eq(kefuVisitorSession.revokedAt, 0),
          sql`${kefuVisitorSession.expiresAt} > ${Math.floor(Date.now() / 1_000)}`,
        ))
        .limit(1)
    )[0];
    if (!visitor) throw new NotFoundException("游客会话不存在、已过期或已转接");
    return visitor;
  }

  const user = (
    await db
      .select({ nickname: userTable.nickname, avatar: userTable.avatar })
      .from(userTable)
      .where(and(eq(userTable.uid, toUid), eq(userTable.isDel, 0)))
      .limit(1)
  )[0];
  if (!user) throw new NotFoundException("用户不存在");
  return user;
}

async function assertConversationAssignment(
  db: DbClient,
  session: ChatSocketSession,
  toUid: number,
): Promise<void> {
  if (session.role === 2) {
    if (session.isTourist === 1) {
      const ownedVisitor = await db
        .select({ visitorUid: kefuVisitorSession.visitorUid })
        .from(kefuVisitorSession)
        .where(and(
          eq(kefuVisitorSession.visitorUid, toUid),
          eq(kefuVisitorSession.kefuUid, session.principalUid),
          eq(kefuVisitorSession.revokedAt, 0),
          sql`${kefuVisitorSession.expiresAt} > ${Math.floor(Date.now() / 1_000)}`,
        ))
        .limit(1);
      if (!ownedVisitor[0]) throw new NotFoundException("当前客服与该游客没有会话");
      return;
    }
    const owned = await db
      .select({ id: storeServiceRecord.id })
      .from(storeServiceRecord)
      .where(and(
        eq(storeServiceRecord.userId, session.principalUid),
        eq(storeServiceRecord.toUid, toUid),
        eq(storeServiceRecord.isTourist, session.isTourist),
      ))
      .limit(1);
    if (!owned[0]) throw new NotFoundException("当前客服与该用户没有会话");
    return;
  }

  if (session.role === 3) {
    const assigned = (
      await db
        .select({ kefuUid: kefuVisitorSession.kefuUid })
        .from(kefuVisitorSession)
        .where(and(
          eq(kefuVisitorSession.visitorUid, session.principalUid),
          eq(kefuVisitorSession.revokedAt, 0),
          sql`${kefuVisitorSession.expiresAt} > ${Math.floor(Date.now() / 1_000)}`,
        ))
        .limit(1)
    )[0];
    if (!assigned || assigned.kefuUid !== toUid) {
      throw new ValidateException("客服会话已转接，请刷新后重试");
    }
    return;
  }

  const assigned = (
    await db
      .select({ kefuUid: storeServiceRecord.userId })
      .from(storeServiceRecord)
      .where(and(
        eq(storeServiceRecord.toUid, session.principalUid),
        eq(storeServiceRecord.isTourist, session.isTourist),
      ))
      .orderBy(desc(storeServiceRecord.updateTime), desc(storeServiceRecord.id))
      .limit(1)
  )[0];
  if (assigned && assigned.kefuUid !== toUid) {
    throw new ValidateException("客服会话已转接，请刷新后重试");
  }
}

async function assertOwnedImageAttachment(
  db: DbClient,
  session: ChatSocketSession,
  value: string,
): Promise<string> {
  const attachmentId = parseCanonicalAttachmentId(value);
  if (!attachmentId) throw new ValidateException("图片消息引用无效");
  const expectedType = session.role === 2 ? 1 : 3;
  const expectedRelationId = session.role === 2 ? session.authId : session.principalUid;
  const expectedModuleType = session.role === 2 ? 2 : session.role === 3 ? 4 : 3;
  const row = (
    await db
      .select({ id: systemAttachment.attId })
      .from(systemAttachment)
      .where(and(
        eq(systemAttachment.attId, attachmentId),
        eq(systemAttachment.type, expectedType),
        eq(systemAttachment.relationId, expectedRelationId),
        eq(systemAttachment.moduleType, expectedModuleType),
        eq(systemAttachment.fileType, 1),
        eq(systemAttachment.imageType, R2_IMAGE_TYPE),
      ))
      .limit(1)
  )[0];
  if (!row) throw new NotFoundException("图片不存在或无权访问");
  return canonicalAttachmentPath(row.id);
}

async function signImageMessage<T extends { msn: string; msn_type: number }>(
  message: T,
  appKey: string,
): Promise<T> {
  if (message.msn_type !== 3 || !parseCanonicalAttachmentId(message.msn)) return message;
  const [signed] = await signAttachmentReferences(appKey, [message.msn], 60 * 60);
  return { ...message, msn: signed };
}

async function senderProfile(
  db: DbClient,
  session: ChatSocketSession,
): Promise<{ nickname: string; avatar: string }> {
  if (session.role === 2) {
    const row = (
      await db
        .select({ nickname: storeService.nickname, avatar: storeService.avatar })
        .from(storeService)
        .where(and(eq(storeService.id, session.authId), eq(storeService.uid, session.principalUid)))
        .limit(1)
    )[0];
    if (!row) throw new AuthException("客服登录状态已失效");
    return row;
  }
  if (session.role === 3) {
    const row = (
      await db
        .select({ nickname: kefuVisitorSession.nickname, avatar: kefuVisitorSession.avatar })
        .from(kefuVisitorSession)
        .where(and(
          eq(kefuVisitorSession.visitorUid, session.principalUid),
          eq(kefuVisitorSession.tokenHash, session.authVersion),
          eq(kefuVisitorSession.revokedAt, 0),
        ))
        .limit(1)
    )[0];
    if (!row) throw new AuthException("游客会话已失效");
    return row;
  }
  const row = (
    await db
      .select({ nickname: userTable.nickname, avatar: userTable.avatar })
      .from(userTable)
      .where(eq(userTable.uid, session.principalUid))
      .limit(1)
  )[0];
  if (!row) throw new AuthException("用户登录状态已失效");
  return row;
}

async function lockConversation(
  db: DbClient,
  role: ChatRole,
  senderUid: number,
  toUid: number,
  isTourist: 0 | 1,
) {
  const userUid = role === 1 || role === 3 ? senderUid : toUid;
  const kefuUid = role === 2 ? senderUid : toUid;
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${CHAT_LOCK_NAMESPACE},
      hashtext(${`kefu:${kefuUid}:customer:${isTourist}:${userUid}`})
    )
  `);
}

async function unreadCount(
  db: DbClient,
  senderUid: number,
  recipientUid: number,
  isTourist: 0 | 1,
): Promise<number> {
  return (
    await db
      .select({ count: sql<number>`count(*)::int` })
      .from(storeServiceLog)
      .where(and(
        eq(storeServiceLog.uid, senderUid),
        eq(storeServiceLog.toUid, recipientUid),
        eq(storeServiceLog.isTourist, isTourist),
        eq(storeServiceLog.type, 0),
      ))
  )[0]?.count ?? 0;
}

async function saveRecipientRecord(
  db: DbClient,
  input: {
    senderUid: number;
    recipientUid: number;
    message: string;
    messageType: number;
    senderRole: ChatRole;
    nickname: string;
    avatar: string;
    unread: number;
    now: number;
    isTourist: 0 | 1;
  },
) {
  const existing = (
    await db
      .select()
      .from(storeServiceRecord)
      .where(and(
        eq(storeServiceRecord.userId, input.recipientUid),
        eq(storeServiceRecord.toUid, input.senderUid),
        eq(storeServiceRecord.isTourist, input.isTourist),
      ))
      .orderBy(desc(storeServiceRecord.id))
      .limit(1)
  )[0];

  let record: typeof storeServiceRecord.$inferSelect;
  if (existing) {
    record = (
      await db
        .update(storeServiceRecord)
        .set({
          nickname: input.nickname,
          avatar: input.avatar,
          online: 1,
          type: input.senderRole,
          updateTime: input.now,
          messageNum: input.unread,
          message: input.message,
          messageType: input.messageType,
        })
        .where(eq(storeServiceRecord.id, existing.id))
        .returning()
    )[0];
  } else {
    record = (
      await db
        .insert(storeServiceRecord)
        .values({
          userId: input.recipientUid,
          toUid: input.senderUid,
          nickname: input.nickname,
          avatar: input.avatar,
          isTourist: input.isTourist,
          online: 1,
          type: input.senderRole,
          addTime: input.now,
          updateTime: input.now,
          messageNum: input.unread,
          message: input.message,
          messageType: input.messageType,
        })
        .returning()
    )[0];
  }

  await db
    .update(storeServiceRecord)
    .set({ message: input.message, messageType: input.messageType })
    .where(and(
      eq(storeServiceRecord.userId, input.senderUid),
      eq(storeServiceRecord.toUid, input.recipientUid),
      eq(storeServiceRecord.isTourist, input.isTourist),
    ));
  return record;
}

async function listServices(db: DbClient, onlineOnly: boolean) {
  const conditions: SQL[] = [
    eq(storeService.isDel, 0),
    eq(storeService.status, 1),
    eq(storeService.accountStatus, 1),
  ];
  if (onlineOnly) conditions.push(eq(storeService.online, 1));
  return db
    .select({
      id: storeService.id,
      uid: storeService.uid,
      nickname: storeService.nickname,
      avatar: storeService.avatar,
      online: storeService.online,
    })
    .from(storeService)
    .where(and(...conditions))
    .orderBy(desc(storeService.online), asc(storeService.id))
    .limit(100);
}

export class KefuRealtimeService {
  constructor(
    private readonly container: Container,
    private readonly env: RealtimeEnv,
  ) {}

  private async assertSessionCredentials(session: ChatSocketSession): Promise<void> {
    assertSessionShape(session);
    if (session.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new AuthException("聊天登录已过期");
    }
    const hasRedis = Boolean(this.env.UPSTASH_REDIS_URL && this.env.UPSTASH_REDIS_TOKEN);
    if (hasRedis && session.role !== 3) {
      const bucket = await getTokenBucket(session.tokenKey, this.env);
      const expectedType = session.role === 2 ? "kefu" : "api";
      if (!bucket || bucket.type !== expectedType || Number(bucket.uid) !== session.authId) {
        throw new AuthException("聊天登录状态已失效");
      }
    }
  }

  async assertSession(session: ChatSocketSession): Promise<void> {
    await this.assertSessionCredentials(session);
    await withTx(this.container, async (tx) => assertDatabaseIdentity(tx, session));
  }

  async setOnline(session: ChatSocketSession, online: boolean): Promise<void> {
    await this.assertSessionCredentials(session);
    await withTx(this.container, async (tx) => {
      await assertDatabaseIdentity(tx, session);
      if (session.role === 2) {
        await tx
          .update(storeService)
          .set({ online: online ? 1 : 0 })
          .where(and(eq(storeService.id, session.authId), eq(storeService.uid, session.principalUid)));
      }
      await tx
        .update(storeServiceRecord)
        .set({ online: online ? 1 : 0 })
        .where(and(
          eq(storeServiceRecord.toUid, session.principalUid),
          eq(storeServiceRecord.isTourist, session.isTourist),
        ));
    });
  }

  /** Close events must clear presence even after logout revoked the Redis bucket. */
  async setDisconnected(session: ChatSocketSession): Promise<void> {
    assertSessionShape(session);
    await withTx(this.container, async (tx) => {
      if (session.role === 2) {
        await tx
          .update(storeService)
          .set({ online: 0 })
          .where(and(eq(storeService.id, session.authId), eq(storeService.uid, session.principalUid)));
      }
      await tx
        .update(storeServiceRecord)
        .set({ online: 0 })
        .where(and(
          eq(storeServiceRecord.toUid, session.principalUid),
          eq(storeServiceRecord.isTourist, session.isTourist),
        ));
    });
  }

  async persistMessage(
    session: ChatSocketSession,
    input: { toUid: unknown; message: unknown; messageType: unknown },
  ): Promise<PersistedRealtimeMessage> {
    await this.assertSessionCredentials(session);
    const toUid = integer(input.toUid, "接收用户", { min: 1 });
    if (toUid !== session.toUid) throw new ValidateException("请先切换到目标会话");
    if (toUid === session.principalUid) throw new ValidateException("不能和自己聊天");
    const messageType = parseChatMessageType(input.messageType);
    const suppliedMessage = sanitizeRealtimeMessage(input.message);

    const persisted = await withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      await lockConversation(tx, session.role, session.principalUid, toUid, session.isTourist);
      await assertDatabaseIdentity(tx, session);
      await assertTarget(tx, session, toUid);
      await assertConversationAssignment(tx, session, toUid);
      const message = messageType === 3
        ? await assertOwnedImageAttachment(tx, session, suppliedMessage)
        : suppliedMessage;
      const profile = await senderProfile(tx, session);
      const now = Math.floor(Date.now() / 1000);
      const row = (
        await tx
          .insert(storeServiceLog)
          .values({
            merId: 0,
            uid: session.principalUid,
            toUid,
            msn: message,
            isTourist: session.isTourist,
            timeNode: 0,
            addTime: now,
            type: 0,
            remind: 0,
            msnType: messageType,
          })
          .returning()
      )[0];
      const unread = await unreadCount(tx, session.principalUid, toUid, session.isTourist);
      const record = await saveRecipientRecord(tx, {
        senderUid: session.principalUid,
        recipientUid: toUid,
        message,
        messageType,
        senderRole: session.role,
        nickname: profile.nickname,
        avatar: profile.avatar,
        unread,
        now,
        isTourist: session.isTourist,
      });
      return {
        id: row.id,
        uid: row.uid,
        to_uid: row.toUid,
        msn: row.msn,
        msn_type: row.msnType,
        add_time: row.addTime,
        is_tourist: session.isTourist,
        type: row.type,
        nickname: profile.nickname,
        avatar: profile.avatar,
        sender_role: session.role,
        recored: mapRecord(record),
      };
    });
    const projected = await signImageMessage(persisted, this.env.APP_KEY);
    if (projected === persisted) return persisted;
    return {
      ...projected,
      recored: { ...projected.recored, message: projected.msn },
    };
  }

  async markMessageRead(message: PersistedRealtimeMessage): Promise<void> {
    await withTx(this.container, async (tx) => {
      await lockConversation(
        tx,
        message.sender_role,
        message.uid,
        message.to_uid,
        message.is_tourist,
      );
      await tx
        .update(storeServiceLog)
        .set({ type: 1 })
        .where(and(
          eq(storeServiceLog.id, message.id),
          eq(storeServiceLog.uid, message.uid),
          eq(storeServiceLog.toUid, message.to_uid),
          eq(storeServiceLog.isTourist, message.is_tourist),
        ));
      const unread = await unreadCount(tx, message.uid, message.to_uid, message.is_tourist);
      await tx
        .update(storeServiceRecord)
        .set({ messageNum: unread })
        .where(and(
          eq(storeServiceRecord.userId, message.to_uid),
          eq(storeServiceRecord.toUid, message.uid),
          eq(storeServiceRecord.isTourist, message.is_tourist),
        ));
    });
  }

  async switchConversation(session: ChatSocketSession, toUidValue: unknown): Promise<number> {
    await this.assertSessionCredentials(session);
    const toUid = integer(toUidValue, "会话用户", { min: 1 });
    if (toUid === session.principalUid) throw new ValidateException("不能和自己聊天");
    await withTx(this.container, async (tx) => {
      await lockConversation(tx, session.role, session.principalUid, toUid, session.isTourist);
      await assertDatabaseIdentity(tx, session);
      await assertTarget(tx, session, toUid);
      await assertConversationAssignment(tx, session, toUid);
      await tx
        .update(storeServiceLog)
        .set({ type: 1 })
        .where(and(
          eq(storeServiceLog.uid, toUid),
          eq(storeServiceLog.toUid, session.principalUid),
          eq(storeServiceLog.isTourist, session.isTourist),
          eq(storeServiceLog.type, 0),
        ));
      await tx
        .update(storeServiceRecord)
        .set({ messageNum: 0 })
        .where(and(
          eq(storeServiceRecord.userId, session.principalUid),
          eq(storeServiceRecord.toUid, toUid),
          eq(storeServiceRecord.isTourist, session.isTourist),
        ));
    });
    return toUid;
  }

  async serviceList(onlineOnly = false) {
    return withTx(this.container, async (tx) => listServices(tx, onlineOnly));
  }

  /** PHP /api/user/record — the authenticated user's conversation summaries. */
  async userConversationList(
    userUid: number,
    query: Record<string, string>,
  ) {
    integer(userUid, "用户身份", { min: 1 });
    const page = integer(query.page, "页码", { min: 1, max: 100_000, fallback: 1 });
    const limit = integer(query.limit, "每页数量", { min: 1, max: MAX_CHAT_HISTORY_LIMIT, fallback: 10 });
    const nickname = String(query.nickname ?? "").trim();
    if (nickname.length > 50) throw new ValidateException("客服昵称过长");
    const conditions: SQL[] = [
      eq(storeServiceRecord.userId, userUid),
      eq(storeServiceRecord.isTourist, 0),
    ];
    if (nickname) {
      const pattern = `%${nickname}%`;
      conditions.push(sql`(
        ${storeServiceRecord.nickname} ILIKE ${pattern}
        OR ${storeServiceRecord.toUid}::text LIKE ${pattern}
      )`);
    }
    const rows = await this.container.db
      .select()
      .from(storeServiceRecord)
      .where(and(...conditions))
      .orderBy(desc(storeServiceRecord.updateTime), desc(storeServiceRecord.id))
      .limit(limit)
      .offset((page - 1) * limit);
    if (!rows.length) return [];

    const serviceUids = [...new Set(rows.map((row) => row.toUid))];
    const services = await this.container.db
      .select({
        id: storeService.id,
        uid: storeService.uid,
        nickname: storeService.nickname,
        avatar: storeService.avatar,
      })
      .from(storeService)
      .where(inArray(storeService.uid, serviceUids))
      .orderBy(desc(storeService.id));
    const serviceByUid = new Map<number, (typeof services)[number]>();
    for (const service of services) {
      if (!serviceByUid.has(service.uid)) serviceByUid.set(service.uid, service);
    }

    const imageIndexes = rows.flatMap((row, index) =>
      row.messageType === 3 && parseCanonicalAttachmentId(row.message) ? [index] : []
    );
    const signed = imageIndexes.length
      ? await signAttachmentReferences(
          this.env.APP_KEY,
          imageIndexes.map((index) => rows[index].message),
          60 * 60,
        )
      : [];
    const signedByIndex = new Map(imageIndexes.map((index, offset) => [index, signed[offset]]));
    return rows.map((row, index) => {
      const service = serviceByUid.get(row.toUid);
      const message = signedByIndex.get(index)
        ?? (row.messageType === 1 ? Array.from(row.message).slice(0, 10).join("") : row.message);
      return {
        ...mapRecord(row),
        nickname: service?.nickname || row.nickname,
        avatar: service?.avatar || row.avatar,
        message,
        _update_time: new Date((row.updateTime + 8 * 60 * 60) * 1_000)
          .toISOString().slice(0, 16).replace("T", " "),
      };
    });
  }

  async userRecord(
    userUid: number,
    query: Record<string, string>,
  ) {
    integer(userUid, "用户身份", { min: 1 });
    const requestedToUid = integer(query.toUid ?? query.to_uid, "客服ID", { min: 0, fallback: 0 });
    const upperId = integer(query.uidTo ?? query.upper_id, "消息游标", { min: 0, fallback: 0 });
    const limit = integer(query.limit, "每页数量", { min: 1, max: MAX_CHAT_HISTORY_LIMIT, fallback: 10 });
    const result = await withTx(this.container, async (tx) => {
      const active = await listServices(tx, requestedToUid === 0);
      let selected = requestedToUid
        ? active.find((item) => item.uid === requestedToUid)
        : undefined;
      if (requestedToUid && !selected) {
        selected = (await listServices(tx, false)).find((item) => item.uid === requestedToUid);
      }
      if (!selected && active.length) {
        const latest = (
          await tx
            .select({ kefuUid: storeServiceRecord.userId })
            .from(storeServiceRecord)
            .where(and(
              eq(storeServiceRecord.toUid, userUid),
              eq(storeServiceRecord.isTourist, 0),
            ))
            .orderBy(desc(storeServiceRecord.updateTime), desc(storeServiceRecord.id))
            .limit(1)
        )[0]?.kefuUid;
        selected = active.find((item) => item.uid === latest)
          ?? active[userUid % active.length];
      }
      if (!selected) throw new NotFoundException("暂无客服人员在线，请稍后联系");

      const conditions: SQL[] = [
        or(
          and(eq(storeServiceLog.uid, userUid), eq(storeServiceLog.toUid, selected.uid)),
          and(eq(storeServiceLog.uid, selected.uid), eq(storeServiceLog.toUid, userUid)),
        )!,
        eq(storeServiceLog.isTourist, 0),
      ];
      if (upperId) conditions.push(lt(storeServiceLog.id, upperId));
      const rows = await tx
        .select()
        .from(storeServiceLog)
        .where(and(...conditions))
        .orderBy(desc(storeServiceLog.id))
        .limit(limit);
      return {
        serviceList: rows.reverse().map(mapMessage),
        uid: selected.uid,
        nickname: selected.nickname,
        avatar: selected.avatar,
        online: selected.online,
      };
    });
    const imageIndexes = result.serviceList.flatMap((message, index) =>
      message.msn_type === 3 && parseCanonicalAttachmentId(message.msn) ? [index] : []
    );
    if (!imageIndexes.length) return result;
    const signed = await signAttachmentReferences(
      this.env.APP_KEY,
      imageIndexes.map((index) => result.serviceList[index].msn),
      60 * 60,
    );
    const signedByIndex = new Map(imageIndexes.map((index, offset) => [index, signed[offset]]));
    return {
      ...result,
      serviceList: result.serviceList.map((message, index) => ({
        ...message,
        msn: signedByIndex.get(index) ?? message.msn,
      })),
    };
  }
}

export function realtimeServiceForDb(db: DbClient, env: RealtimeEnv): KefuRealtimeService {
  return new KefuRealtimeService(createContainerFromDb(db), env);
}
