import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  workChannelCode,
  workClient,
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
import { MAX_DEPARTMENT_ANCESTOR_DEPTH } from "@/services/work/EnterpriseWechatDepartmentProjection";
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

interface DepartmentCatalogEnvironment {
  WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY?: string;
}

interface CurrentDepartmentCatalogRow {
  corp_id: string;
  department_id: number;
  name: string;
  name_en: string;
  parent_department_id: number | null;
  sort_order: number;
  leader_count: number;
  create_time: number;
  update_time: number;
}

interface LegacyDepartmentCatalogRow {
  blocked_current_rows: number;
  id: number | null;
  corp_id: string | null;
  department_id: number | null;
  name: string | null;
  name_en: string | null;
  department_leader: string | null;
  parentid: number | null;
  srot: number | null;
  create_time: number | null;
  update_time: number | null;
}

function currentDepartmentRuntimeMeta(authority: string) {
  return {
    catalog_authority: authority,
    remote_write_authority: "not_migrated_requires_idempotent_outbox" as const,
    pii_display: "masked" as const,
  };
}

export class EnterpriseWechatCatalogService {
  constructor(
    private readonly container: Container,
    private readonly env: DepartmentCatalogEnvironment = {},
  ) {}

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
    const currentAuthority = this.env.WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY?.trim()
      === "verified";

    if (currentAuthority) {
      const corpScope = corpId
        ? sql`AND current_row.corp_id = ${corpId}`
        : sql``;
      const raw = await this.container.db.execute(sql`
        WITH RECURSIVE eligible AS (
          SELECT current_row.*
          FROM work_department_current AS current_row
          INNER JOIN work_department_projection_fence AS fence
            ON fence.corp_id = current_row.corp_id
           AND fence.department_id = current_row.department_id
           AND fence.last_event_id = current_row.last_event_id
           AND fence.last_event_key = current_row.last_event_key
           AND fence.last_event_subject_key_hash = current_row.last_event_subject_key_hash
           AND fence.last_event_time = current_row.last_event_time
           AND fence.last_sequence_rank = current_row.last_sequence_rank
          INNER JOIN work_callback_event AS callback_event
            ON callback_event.id = current_row.last_event_id
           AND callback_event.corp_id = current_row.corp_id
           AND callback_event.event_key = current_row.last_event_key
           AND callback_event.subject_key_hash = current_row.last_event_subject_key_hash
           AND callback_event.event_time = current_row.last_event_time
           AND callback_event.sequence_rank = current_row.last_sequence_rank
          WHERE current_row.lifecycle_state = 'ACTIVE'
            AND current_row.profile_complete = true
            ${corpScope}
        ), visible AS (
          SELECT root.*, ARRAY[root.department_id]::integer[] AS ancestor_path
          FROM eligible AS root
          WHERE root.parent_department_id IS NULL
          UNION ALL
          SELECT child.*, parent.ancestor_path || child.department_id
          FROM visible AS parent
          INNER JOIN eligible AS child
            ON child.corp_id = parent.corp_id
           AND child.parent_department_id = parent.department_id
          WHERE NOT child.department_id = ANY(parent.ancestor_path)
            AND cardinality(parent.ancestor_path) <= ${MAX_DEPARTMENT_ANCESTOR_DEPTH}
        )
        SELECT
          visible.corp_id,
          visible.department_id::integer,
          visible.name,
          visible.name_en,
          visible.parent_department_id::integer,
          visible.sort_order::double precision AS sort_order,
          (
            SELECT count(*)::integer
            FROM work_department_leader_current AS leader
            WHERE leader.corp_id = visible.corp_id
              AND leader.department_id = visible.department_id
          ) AS leader_count,
          visible.create_time::integer,
          visible.update_time::integer
        FROM visible
        ORDER BY
          visible.corp_id,
          visible.parent_department_id NULLS FIRST,
          visible.sort_order DESC,
          visible.department_id
        LIMIT ${MAX_TREE_ROWS}
      `);
      const rows = Array.from(raw) as unknown as CurrentDepartmentCatalogRow[];
      return {
        list: rows.map((row) => ({
          id: Number(row.department_id),
          corp_id: maskIdentifier(row.corp_id),
          department_id: Number(row.department_id),
          name: row.name,
          name_en: row.name_en,
          parentid: row.parent_department_id ?? 0,
          srot: Number(row.sort_order),
          department_leader_count: Number(row.leader_count),
          create_time: Number(row.create_time),
          update_time: Number(row.update_time),
        })),
        count: rows.length,
        truncated: rows.length === MAX_TREE_ROWS,
        ...currentDepartmentRuntimeMeta("enterprise_wechat_department_current"),
      };
    }

    // The authority-off decision and legacy rows must share one PostgreSQL
    // statement snapshot. A separate COUNT followed by a legacy SELECT could
    // leak stale legacy rows if the first current/tombstone commits between
    // those statements.
    const currentScope = corpId
      ? sql`WHERE current_row.corp_id = ${corpId}`
      : sql``;
    const legacyScope = corpId
      ? sql`AND legacy_row.corp_id = ${corpId}`
      : sql``;
    const rawFallback = await this.container.db.execute(sql`
      WITH current_state AS MATERIALIZED (
        SELECT count(*)::double precision AS blocked_current_rows
        FROM work_department_current AS current_row
        ${currentScope}
      ), legacy_rows AS MATERIALIZED (
        SELECT legacy_row.*
        FROM work_department AS legacy_row
        CROSS JOIN current_state
        WHERE current_state.blocked_current_rows = 0
          ${legacyScope}
        ORDER BY legacy_row.parentid, legacy_row.srot, legacy_row.id
        LIMIT ${MAX_TREE_ROWS}
      )
      SELECT current_state.blocked_current_rows, legacy_rows.*
      FROM current_state
      LEFT JOIN legacy_rows ON true
      ORDER BY legacy_rows.parentid NULLS FIRST, legacy_rows.srot, legacy_rows.id
    `);
    const fallbackRows = Array.from(rawFallback) as unknown as LegacyDepartmentCatalogRow[];
    const blockedCurrentRows = Number(fallbackRows[0]?.blocked_current_rows ?? 0);
    if (blockedCurrentRows > 0) {
      return {
        list: [],
        count: 0,
        truncated: false,
        blocked_current_rows: blockedCurrentRows,
        ...currentDepartmentRuntimeMeta("department_current_authority_disabled"),
      };
    }

    const rows = fallbackRows.filter(
      (row): row is LegacyDepartmentCatalogRow & { id: number } => row.id !== null,
    );
    return {
      list: rows.map((row) => ({
        id: row.id,
        corp_id: maskIdentifier(row.corp_id ?? ""),
        department_id: Number(row.department_id),
        name: row.name ?? "",
        name_en: row.name_en ?? "",
        parentid: Number(row.parentid),
        srot: Number(row.srot),
        department_leader_count: parseStringList(row.department_leader).length,
        create_time: Number(row.create_time),
        update_time: Number(row.update_time),
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
