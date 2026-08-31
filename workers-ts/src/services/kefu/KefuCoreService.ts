import {
  and,
  asc,
  desc,
  eq,
  ilike,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env, AppVariables } from "@/env";
import type { Container } from "@/lib/di";
import {
  storeService,
  storeServiceLog,
  storeServiceRecord,
  systemUserLevel,
  user as userTable,
  userGroup,
} from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { ErpCapabilityService } from "@/services/system/ErpCapabilityService";
import {
  parseCanonicalAttachmentId,
  signAttachmentReferences,
} from "@/services/system/AttachmentService";
import { UserSegmentationService } from "@/services/user/UserSegmentationService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_PAGE_SIZE = 100;

function integer(
  value: unknown,
  label: string,
  options: { fallback?: number; min?: number; max?: number } = {},
): number {
  const fallback = options.fallback ?? 0;
  const min = options.min ?? 0;
  const max = options.max ?? 2_147_483_647;
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new ValidateException(`${label}错误`);
  }
  return result;
}

export function parseKefuPageLimit(value: unknown): number {
  return integer(value, "每页数量", { fallback: 20, min: 1, max: MAX_PAGE_SIZE });
}

export interface KefuSessionCursor {
  updateTime: number;
  id: number;
}

export function parseKefuSessionCursor(value: unknown): KefuSessionCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ValidateException("会话游标错误");
  const match = /^(\d{1,10}):(\d{1,10})$/.exec(value);
  if (!match) throw new ValidateException("会话游标错误");
  const updateTime = integer(match[1], "会话游标", { min: 0 });
  const id = integer(match[2], "会话游标", { min: 1 });
  return { updateTime, id };
}

function booleanFlag(value: unknown, label: string): number {
  const result = integer(value, label, { fallback: 0, min: 0, max: 1 });
  return result;
}

function formatMessage(row: typeof storeServiceLog.$inferSelect) {
  return {
    id: row.id,
    mer_id: row.merId,
    msn: row.msn,
    uid: row.uid,
    to_uid: row.toUid,
    is_tourist: row.isTourist,
    time_node: row.timeNode,
    add_time: row.addTime,
    type: row.type,
    remind: row.remind,
    msn_type: row.msnType,
  };
}

async function signImageMessages<T extends { msn: string; msn_type: number }>(
  messages: T[],
  appKey: string | undefined,
): Promise<T[]> {
  const indexes = messages.flatMap((message, index) =>
    message.msn_type === 3 && parseCanonicalAttachmentId(message.msn) ? [index] : []
  );
  if (!indexes.length) return messages;
  const signed = await signAttachmentReferences(
    appKey,
    indexes.map((index) => messages[index].msn),
    60 * 60,
  );
  return messages.map((message, index) => {
    const signedIndex = indexes.indexOf(index);
    return signedIndex < 0 ? message : { ...message, msn: signed[signedIndex] };
  });
}

export async function assertKefuConversation(
  container: Container,
  kefuUid: number,
  peerUid: number,
  isTourist: number,
): Promise<void> {
  const record = await container.db
    .select({ id: storeServiceRecord.id })
    .from(storeServiceRecord)
    .where(and(
      eq(storeServiceRecord.userId, kefuUid),
      eq(storeServiceRecord.toUid, peerUid),
      eq(storeServiceRecord.isTourist, isTourist),
    ))
    .limit(1);
  // Historical messages are not an ownership grant. A completed transfer
  // deletes the source record, immediately closing every old HTTP path.
  if (!record[0]) throw new NotFoundException("当前客服与该用户没有会话");
}

export class KefuCoreService {
  constructor(
    private readonly container: Container,
    private readonly env?: Pick<Env, "CONFIG_KV" | "APP_KEY">,
  ) {}

  private configService() {
    if (!this.env) throw new Error("Customer-service configuration binding is required");
    return new SystemConfigService(this.container, this.env);
  }

  async clientConfig() {
    const values = await this.configService().getMany([
      "wechat_open_app_id",
      "site_name",
    ]);
    return {
      appid: values.wechat_open_app_id ?? "",
      site_name: values.site_name ?? "",
      version: "CRMEB-PRO-TS v0.1.0",
    };
  }

  async currentInfo(info: NonNullable<AppVariables["kefuInfo"]>) {
    const values = await this.configService().getMany([
      "site_name",
      "config_export_open",
    ]);
    return {
      ...info,
      site_name: values.site_name ?? "",
      config_export_open: values.config_export_open ?? "0",
    };
  }

  async erpConfig() {
    if (!this.env) throw new Error("Customer-service configuration binding is required");
    return new ErpCapabilityService(this.container, this.env).getCapability();
  }

  async availableServices(kefuUid: number, query: Record<string, string>) {
    const limit = parseKefuPageLimit(query.limit);
    const conditions: SQL[] = [
      eq(storeService.status, 1),
      eq(storeService.accountStatus, 1),
      eq(storeService.isDel, 0),
      eq(storeService.online, 1),
      sql`${storeService.uid} <> ${kefuUid}`,
      sql`${storeService.uid} > 0`,
    ];
    const nickname = query.nickname?.trim();
    if (nickname) conditions.push(ilike(storeService.nickname, `%${nickname.slice(0, 50)}%`));
    const rows = await this.container.db
      .select({
        id: storeService.id,
        uid: storeService.uid,
        avatar: storeService.avatar,
        nickname: storeService.nickname,
        online: storeService.online,
      })
      .from(storeService)
      .where(and(...conditions))
      .orderBy(desc(storeService.online), asc(storeService.id))
      .limit(limit);
    return { list: rows, count: rows.length };
  }

  async sessionList(kefuUid: number, query: Record<string, string>) {
    const limit = parseKefuPageLimit(query.limit);
    const isTourist = booleanFlag(query.is_tourist, "游客状态");
    const cursor = parseKefuSessionCursor(query.cursor);
    const conditions: SQL[] = [
      // PHP StoreServiceRecordServices::getServiceList($kefuUid) scopes by
      // user_id (the record owner); to_uid is the customer/peer.
      eq(storeServiceRecord.userId, kefuUid),
      eq(storeServiceRecord.isTourist, isTourist),
    ];
    if (cursor) {
      conditions.push(sql`(${storeServiceRecord.updateTime}, ${storeServiceRecord.id}) < (${cursor.updateTime}, ${cursor.id})`);
    }
    const nickname = query.nickname?.trim();
    if (nickname) {
      const pattern = `%${nickname.slice(0, 60)}%`;
      conditions.push(or(
        ilike(storeServiceRecord.nickname, pattern),
        ilike(userTable.nickname, pattern),
        ilike(userTable.phone, pattern),
      )!);
    }
    const rows = await this.container.db
      .select({
        id: storeServiceRecord.id,
        userId: storeServiceRecord.userId,
        toUid: storeServiceRecord.toUid,
        nickname: storeServiceRecord.nickname,
        avatar: storeServiceRecord.avatar,
        isTourist: storeServiceRecord.isTourist,
        online: storeServiceRecord.online,
        type: storeServiceRecord.type,
        addTime: storeServiceRecord.addTime,
        updateTime: storeServiceRecord.updateTime,
        messageNum: storeServiceRecord.messageNum,
        message: storeServiceRecord.message,
        messageType: storeServiceRecord.messageType,
        userNickname: userTable.nickname,
        userAvatar: userTable.avatar,
        userPhone: userTable.phone,
      })
      .from(storeServiceRecord)
      .leftJoin(
        userTable,
        and(eq(userTable.uid, storeServiceRecord.toUid), eq(userTable.isDel, 0)),
      )
      .where(and(...conditions))
      .orderBy(desc(storeServiceRecord.updateTime), desc(storeServiceRecord.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      list: page.map((row) => ({
        id: row.id,
        user_id: row.userId,
        to_uid: row.toUid,
        nickname: row.userNickname || row.nickname || `用户${row.toUid}`,
        avatar: row.userAvatar || row.avatar,
        phone: isTourist ? "" : row.userPhone ?? "",
        is_tourist: row.isTourist,
        online: row.online,
        type: row.type,
        add_time: row.addTime,
        update_time: row.updateTime,
        mssage_num: row.messageNum,
        message: row.message,
        message_type: row.messageType,
      })),
      next_cursor: hasMore && last ? `${last.updateTime}:${last.id}` : null,
    };
  }

  async chatHistory(
    kefuUid: number,
    peerUidValue: unknown,
    upperIdValue: unknown,
    isTouristValue: unknown,
    limitValue: unknown,
  ) {
    const peerUid = integer(peerUidValue, "用户ID", { min: 1 });
    const upperId = integer(upperIdValue, "消息游标", { fallback: 0, min: 0 });
    const isTourist = booleanFlag(isTouristValue, "游客状态");
    const limit = parseKefuPageLimit(limitValue);
    await this.assertConversation(kefuUid, peerUid, isTourist);
    const conversation = or(
      and(eq(storeServiceLog.uid, kefuUid), eq(storeServiceLog.toUid, peerUid)),
      and(eq(storeServiceLog.uid, peerUid), eq(storeServiceLog.toUid, kefuUid)),
    );
    const rows = await this.container.db
      .select()
      .from(storeServiceLog)
      .where(and(
        conversation,
        eq(storeServiceLog.isTourist, isTourist),
        upperId > 0 ? lt(storeServiceLog.id, upperId) : undefined,
      ))
      .orderBy(desc(storeServiceLog.id))
      .limit(limit);
    return signImageMessages(rows.reverse().map(formatMessage), this.env?.APP_KEY);
  }

  async userInfo(kefuUid: number, uidValue: unknown) {
    const uid = integer(uidValue, "用户ID", { min: 1 });
    await this.assertConversation(kefuUid, uid, 0);
    const user = (
      await this.container.db
        .select({
          uid: userTable.uid,
          nickname: userTable.nickname,
          avatar: userTable.avatar,
          spreadUid: userTable.spreadUid,
          isPromoter: userTable.isPromoter,
          birthday: userTable.birthday,
          nowMoney: userTable.nowMoney,
          userType: userTable.userType,
          level: userTable.level,
          groupId: userTable.groupId,
          phone: userTable.phone,
          isMoneyLevel: userTable.isMoneyLevel,
        })
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .limit(1)
    )[0];
    if (!user) throw new NotFoundException("用户不存在");
    const [labels, group, level, spread] = await Promise.all([
      new UserSegmentationService(this.container).userLabels(uid),
      user.groupId > 0
        ? this.container.db
            .select({ name: userGroup.groupName })
            .from(userGroup)
            .where(eq(userGroup.id, user.groupId))
            .limit(1)
        : Promise.resolve([]),
      user.level > 0
        ? this.container.db
            .select({ name: systemUserLevel.name })
            .from(systemUserLevel)
            .where(eq(systemUserLevel.id, user.level))
            .limit(1)
        : Promise.resolve([]),
      user.spreadUid > 0
        ? this.container.db
            .select({ nickname: userTable.nickname })
            .from(userTable)
            .where(eq(userTable.uid, user.spreadUid))
            .limit(1)
        : Promise.resolve([]),
    ]);
    return {
      uid: user.uid,
      nickname: user.nickname,
      avatar: user.avatar,
      spread_uid: user.spreadUid,
      spread_name: spread[0]?.nickname ?? "",
      is_promoter: user.isPromoter,
      birthday: user.birthday,
      now_money: user.nowMoney,
      user_type: user.userType,
      level: user.level,
      level_name: level[0]?.name ?? "",
      group_id: user.groupId,
      group_name: group[0]?.name ?? "",
      phone: user.phone,
      is_money_level: user.isMoneyLevel,
      labelNames: labels.map((item) => item.label_name),
      labels,
    };
  }

  async userLabels(kefuUid: number, uidValue: unknown) {
    const uid = integer(uidValue, "用户ID", { min: 1 });
    await this.assertConversation(kefuUid, uid, 0);
    return new UserSegmentationService(this.container).userLabelOptions(uid);
  }

  async userGroups() {
    const result = await new UserSegmentationService(this.container).groupList({
      page: "1",
      limit: String(MAX_PAGE_SIZE),
    });
    return result.list;
  }

  async setUserGroup(kefuUid: number, uidValue: unknown, groupIdValue: unknown) {
    const uid = integer(uidValue, "用户ID", { min: 1 });
    const groupId = integer(groupIdValue, "分组ID", { min: 1 });
    await this.assertConversation(kefuUid, uid, 0);
    await new UserSegmentationService(this.container).assignGroup([uid], groupId);
  }

  async setUserLabels(kefuUid: number, uidValue: unknown, input: unknown) {
    const uid = integer(uidValue, "用户ID", { min: 1 });
    await this.assertConversation(kefuUid, uid, 0);
    await new UserSegmentationService(this.container).setUserLabels(uid, input);
  }

  private async assertConversation(kefuUid: number, peerUid: number, isTourist: number) {
    await assertKefuConversation(this.container, kefuUid, peerUid, isTourist);
  }
}
