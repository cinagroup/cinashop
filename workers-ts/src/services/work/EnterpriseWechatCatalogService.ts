import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNull,
  or,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  workChannelCode,
  workClient,
  workDepartment,
  workGroupChat,
  workGroupChatAuth,
  workGroupChatMember,
  workGroupMsgSendResult,
  workGroupTemplate,
  workLabel,
  workMember,
  workMoment,
  workMomentSendResult,
  workWelcome,
} from "@/models/schema";
import { ValidateException } from "@/utils/errors";

const MAX_LIMIT = 100;
const MAX_TREE_ROWS = 500;

function integer(
  value: unknown,
  label: string,
  options: { fallback: number; min?: number; max?: number },
): number {
  if (value === undefined || value === "") return options.fallback;
  const parsed = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? 2_147_483_647;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function pageQuery(query: Record<string, string>) {
  return {
    page: integer(query.page, "页码", { fallback: 1, min: 1, max: 1_000_000 }),
    limit: integer(query.limit, "每页数量", { fallback: 20, min: 1, max: MAX_LIMIT }),
  };
}

function optionalStatus(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  return integer(value, "状态", { fallback: 0, min: 0, max: 255 });
}

function keyword(value: string | undefined): string {
  return (value ?? "").trim().slice(0, 100);
}

function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function maskIdentifier(value: string): string {
  if (!value) return "";
  if (value.length <= 5) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 4)}***${value.slice(-3)}`;
}

function maskMobile(value: string): string {
  if (!value) return "";
  return value.length >= 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : maskIdentifier(value);
}

function maskEmail(value: string): string {
  const separator = value.indexOf("@");
  if (separator < 1) return value ? maskIdentifier(value) : "";
  return `${value.slice(0, Math.min(2, separator))}***${value.slice(separator)}`;
}

function previewText(value: string | null, max = 180): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function parseStringList(value: string | null, max = 50): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((item) => item.trim()).filter(Boolean).slice(0, max);
    }
  } catch {
    // Fall back to the comma-separated legacy format.
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, max);
}

function jsonArrayLength(value: string | null): number {
  if (!value) return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function runtimeMeta() {
  return {
    catalog_authority: "postgresql_imported_history" as const,
    remote_write_authority: "not_migrated_requires_idempotent_outbox" as const,
    pii_display: "masked" as const,
  };
}

export class EnterpriseWechatCatalogService {
  constructor(private readonly container: Container) {}

  async summary() {
    const [members, activeMembers, clients, groups, channels, templates, moments, pendingGroup, pendingMoment] =
      await Promise.all([
        this.container.db.select({ value: count() }).from(workMember),
        this.container.db.select({ value: count() }).from(workMember).where(and(eq(workMember.enable, 1), eq(workMember.status, 1))),
        this.container.db.select({ value: count() }).from(workClient).where(isNull(workClient.deleteTime)),
        this.container.db.select({ value: count() }).from(workGroupChat),
        this.container.db.select({ value: count() }).from(workChannelCode).where(isNull(workChannelCode.deleteTime)),
        this.container.db.select({ value: count() }).from(workGroupTemplate),
        this.container.db.select({ value: count() }).from(workMoment),
        this.container.db.select({ value: count() }).from(workGroupMsgSendResult).where(eq(workGroupMsgSendResult.status, 0)),
        this.container.db.select({ value: count() }).from(workMomentSendResult).where(eq(workMomentSendResult.status, 0)),
      ]);
    return {
      members: Number(members[0]?.value ?? 0),
      active_members: Number(activeMembers[0]?.value ?? 0),
      clients: Number(clients[0]?.value ?? 0),
      groups: Number(groups[0]?.value ?? 0),
      channels: Number(channels[0]?.value ?? 0),
      templates: Number(templates[0]?.value ?? 0),
      moments: Number(moments[0]?.value ?? 0),
      pending_delivery_results: Number(pendingGroup[0]?.value ?? 0) + Number(pendingMoment[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async departments(query: Record<string, string>) {
    const corpId = keyword(query.corp_id);
    const conditions: SQL[] = [];
    if (corpId) conditions.push(eq(workDepartment.corpId, corpId));
    const rows = await this.container.db
      .select()
      .from(workDepartment)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(workDepartment.parentid), asc(workDepartment.srot), asc(workDepartment.id))
      .limit(MAX_TREE_ROWS);
    return {
      list: rows.map((row) => ({
        id: row.id,
        corp_id: maskIdentifier(row.corpId),
        department_id: row.departmentId,
        name: row.name,
        name_en: row.nameEn,
        parentid: row.parentid,
        srot: row.srot,
        department_leader_count: parseStringList(row.departmentLeader).length,
        create_time: row.createTime,
        update_time: row.updateTime,
      })),
      count: rows.length,
      truncated: rows.length === MAX_TREE_ROWS,
      ...runtimeMeta(),
    };
  }

  async members(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = keyword(query.keyword ?? query.keywords);
    const status = optionalStatus(query.status);
    const conditions: SQL[] = [];
    if (status !== undefined) conditions.push(eq(workMember.status, status));
    if (search) {
      const pattern = like(search);
      conditions.push(or(ilike(workMember.name, pattern), ilike(workMember.userid, pattern), ilike(workMember.mobile, pattern))!);
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workMember).where(where)
        .orderBy(desc(workMember.updateTime), desc(workMember.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workMember).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        userid: maskIdentifier(row.userid),
        uid: row.uid,
        name: row.name,
        position: row.position,
        mobile: maskMobile(row.mobile),
        email: maskEmail(row.email || row.bizMail),
        avatar: row.thumbAvatar || row.avatar,
        enable: row.enable,
        is_leader: row.isLeader,
        hide_mobile: row.hideMobile,
        main_department: row.mainDepartment,
        status: row.status,
        external_position: row.externalPosition,
        update_time: row.updateTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async clients(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = keyword(query.keyword ?? query.name);
    const conditions: SQL[] = [isNull(workClient.deleteTime)];
    if (search) {
      const pattern = like(search);
      conditions.push(or(
        ilike(workClient.name, pattern),
        ilike(workClient.corpName, pattern),
        ilike(workClient.remark, pattern),
        ilike(workClient.externalUserid, pattern),
      )!);
    }
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workClient).where(where)
        .orderBy(desc(workClient.updateTime), desc(workClient.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workClient).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        external_userid: maskIdentifier(row.externalUserid),
        uid: row.uid,
        name: row.name,
        avatar: row.avatar,
        type: row.type,
        gender: row.gender,
        unionid: maskIdentifier(row.unionid),
        position: row.position,
        corp_name: row.corpName,
        corp_full_name: row.corpFullName,
        remark: row.remark,
        create_time: row.createTime,
        update_time: row.updateTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async groups(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = keyword(query.keyword ?? query.name);
    const status = optionalStatus(query.status);
    const conditions: SQL[] = [];
    if (status !== undefined) conditions.push(eq(workGroupChat.status, status));
    if (search) {
      const pattern = like(search);
      conditions.push(or(ilike(workGroupChat.name, pattern), ilike(workGroupChat.chatId, pattern), ilike(workGroupChat.owner, pattern))!);
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workGroupChat).where(where)
        .orderBy(desc(workGroupChat.updateTime), desc(workGroupChat.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workGroupChat).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        chat_id: maskIdentifier(row.chatId),
        name: row.name,
        owner: maskIdentifier(row.owner),
        group_create_time: row.groupCreateTime,
        notice: previewText(row.notice, 120),
        admin_count: parseStringList(row.adminList).length,
        member_num: row.memberNum,
        retreat_group_num: row.retreatGroupNum,
        status: row.status,
        update_time: row.updateTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async groupMembers(groupValue: string, query: Record<string, string>) {
    const groupId = integer(groupValue, "客户群ID", { fallback: 0, min: 1 });
    const { page, limit } = pageQuery(query);
    const status = optionalStatus(query.status);
    const conditions: SQL[] = [eq(workGroupChatMember.groupId, groupId)];
    if (status !== undefined) conditions.push(eq(workGroupChatMember.status, status));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workGroupChatMember).where(where)
        .orderBy(desc(workGroupChatMember.joinTime), desc(workGroupChatMember.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workGroupChatMember).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        group_id: row.groupId,
        userid: maskIdentifier(row.userid),
        type: row.type,
        unionid: maskIdentifier(row.unionid),
        join_time: row.joinTime,
        join_scene: row.joinScene,
        group_nickname: row.groupNickname,
        name: row.name,
        status: row.status,
        state: row.state,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async channels(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = keyword(query.keyword ?? query.name);
    const status = optionalStatus(query.status);
    const conditions: SQL[] = [isNull(workChannelCode.deleteTime)];
    if (status !== undefined) conditions.push(eq(workChannelCode.status, status));
    if (search) conditions.push(ilike(workChannelCode.name, like(search)));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workChannelCode).where(where)
        .orderBy(desc(workChannelCode.createTime), desc(workChannelCode.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workChannelCode).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        cate_id: row.cateId,
        assigned_member_count: parseStringList(row.userids).length,
        has_reserve_member: Boolean(row.reserveUserid),
        skip_verify: row.skipVerify,
        add_upper_limit: row.addUpperLimit,
        welcome_type: row.welcomeType,
        welcome_preview: previewText(row.welcomeWords, 120),
        qrcode_url: row.qrcodeUrl,
        status: row.status,
        client_num: row.clientNum,
        create_time: row.createTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async groupAuths(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = keyword(query.keyword ?? query.name);
    const conditions: SQL[] = [isNull(workGroupChatAuth.deleteTime)];
    if (search) conditions.push(ilike(workGroupChatAuth.name, like(search)));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workGroupChatAuth).where(where)
        .orderBy(desc(workGroupChatAuth.createTime), desc(workGroupChatAuth.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workGroupChatAuth).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        name: row.name,
        auth_group_chat: row.authGroupChat,
        group_name: row.groupName,
        group_num: row.groupNum,
        label: row.label,
        qr_code: row.qrCode,
        create_time: row.createTime,
        update_time: row.updateTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async labels(query: Record<string, string>) {
    const search = keyword(query.keyword ?? query.name);
    const rows = await this.container.db.select().from(workLabel)
      .where(search ? or(ilike(workLabel.name, like(search)), ilike(workLabel.groupName, like(search))) : undefined)
      .orderBy(asc(workLabel.groupId), asc(workLabel.sort), asc(workLabel.id)).limit(MAX_TREE_ROWS);
    return {
      list: rows.map((row) => ({ id: row.id, group_id: row.groupId, group_name: row.groupName, name: row.name, sort: row.sort })),
      count: rows.length,
      truncated: rows.length === MAX_TREE_ROWS,
      ...runtimeMeta(),
    };
  }

  async templates(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = keyword(query.keyword ?? query.name);
    const type = optionalStatus(query.type);
    const conditions: SQL[] = [];
    if (type !== undefined) conditions.push(eq(workGroupTemplate.type, type));
    if (search) conditions.push(ilike(workGroupTemplate.name, like(search)));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workGroupTemplate).where(where)
        .orderBy(desc(workGroupTemplate.createTime), desc(workGroupTemplate.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workGroupTemplate).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        assigned_member_count: parseStringList(row.userids).length,
        client_type: row.clientType,
        where_time: row.whereTime,
        template_type: row.templateType,
        send_time: row.sendTime,
        send_type: row.sendType,
        content_preview: previewText(row.welcomeWords),
        has_failure_detail: Boolean(row.failExternalUserid || row.failMessage),
        fail_message: previewText(row.failMessage, 120),
        create_time: row.createTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async moments(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = keyword(query.keyword ?? query.name);
    const where = search ? ilike(workMoment.name, like(search)) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workMoment).where(where)
        .orderBy(desc(workMoment.createTime), desc(workMoment.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workMoment).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        assigned_member_count: parseStringList(row.userIds).length,
        client_type: row.clientType,
        content_preview: previewText(row.welcomeWords),
        send_type: row.sendType,
        send_time: row.sendTime,
        remote_job_state: row.jobid ? "recorded" : "not_recorded",
        remote_moment_state: row.momentId ? "recorded" : "not_recorded",
        has_invalid_recipients: Boolean(row.invalidSenderList || row.invalidExternalContactList),
        create_time: row.createTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async welcomes(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const where = isNull(workWelcome.deleteTime);
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(workWelcome).where(where)
        .orderBy(desc(workWelcome.sort), desc(workWelcome.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(workWelcome).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        content_preview: previewText(row.content),
        attachment_count: jsonArrayLength(row.attachments),
        sort: row.sort,
        create_time: row.createTime,
        update_time: row.updateTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }
}
