import {
  and,
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
  workCallbackEvent,
  workClientCurrent,
  workClientProjectionFence,
  workGroupChatAuth,
  workGroupMsgSendResult,
  workGroupTemplate,
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

interface WorkCatalogEnvironment {
  WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY?: string;
  WECHAT_WORK_CLIENT_CURRENT_AUTHORITY?: string;
  WECHAT_WORK_GROUP_CHAT_CURRENT_AUTHORITY?: string;
  WECHAT_WORK_TAG_CURRENT_AUTHORITY?: string;
  WECHAT_WORK_EXTERNAL_CONTACT_FULL_VISIBILITY?: string;
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

interface CurrentClientCatalogRow {
  id: number;
  external_userid: string;
  uid: number | null;
  name: string;
  avatar: string | null;
  type: number;
  gender: number;
  unionid: string | null;
  position: string | null;
  corp_name: string | null;
  corp_full_name: string | null;
  create_time: number;
  update_time: number;
}

interface LegacyClientCatalogRow {
  blocked_current_rows: number;
  id: number | null;
  external_userid: string | null;
  uid: number | null;
  name: string | null;
  avatar: string | null;
  type: number | null;
  gender: number | null;
  unionid: string | null;
  position: string | null;
  corp_name: string | null;
  corp_full_name: string | null;
  remark: string | null;
  create_time: number | null;
  update_time: number | null;
  total_count: number;
}

function currentClientCatalogRow(row: Record<string, unknown>): CurrentClientCatalogRow & {
  total_count: number;
} {
  return {
    id: Number(row.id),
    external_userid: String(row.external_userid ?? ""),
    uid: row.uid === null || row.uid === undefined ? null : Number(row.uid),
    name: String(row.name ?? ""),
    avatar: row.avatar === null || row.avatar === undefined ? null : String(row.avatar),
    type: Number(row.type),
    gender: Number(row.gender),
    unionid: row.unionid === null || row.unionid === undefined ? null : String(row.unionid),
    position: row.position === null || row.position === undefined ? null : String(row.position),
    corp_name: row.corp_name === null || row.corp_name === undefined ? null : String(row.corp_name),
    corp_full_name: row.corp_full_name === null || row.corp_full_name === undefined
      ? null
      : String(row.corp_full_name),
    create_time: Number(row.create_time),
    update_time: Number(row.update_time),
    total_count: Number(row.total_count ?? 0),
  };
}

function legacyClientCatalogRow(row: Record<string, unknown>): LegacyClientCatalogRow {
  const nullableNumber = (value: unknown) => value === null || value === undefined
    ? null
    : Number(value);
  const nullableString = (value: unknown) => value === null || value === undefined
    ? null
    : String(value);
  return {
    blocked_current_rows: Number(row.blocked_current_rows ?? 0),
    id: nullableNumber(row.id),
    external_userid: nullableString(row.external_userid),
    uid: nullableNumber(row.uid),
    name: nullableString(row.name),
    avatar: nullableString(row.avatar),
    type: nullableNumber(row.type),
    gender: nullableNumber(row.gender),
    unionid: nullableString(row.unionid),
    position: nullableString(row.position),
    corp_name: nullableString(row.corp_name),
    corp_full_name: nullableString(row.corp_full_name),
    remark: nullableString(row.remark),
    create_time: nullableNumber(row.create_time),
    update_time: nullableNumber(row.update_time),
    total_count: Number(row.total_count ?? 0),
  };
}

function currentDepartmentRuntimeMeta(authority: string) {
  return {
    catalog_authority: authority,
    remote_write_authority: "not_migrated_requires_idempotent_outbox" as const,
    pii_display: "masked" as const,
  };
}

function clientCatalogRuntimeMeta(authority: string) {
  return {
    client_catalog_authority: authority,
    remote_write_authority: "not_migrated_requires_idempotent_outbox" as const,
    pii_display: "masked" as const,
  };
}

function groupCatalogRuntimeMeta(authority: string) {
  return {
    group_catalog_authority: authority,
    remote_write_authority: "not_migrated_requires_idempotent_outbox" as const,
    pii_display: "masked" as const,
  };
}

export class EnterpriseWechatCatalogService {
  constructor(
    private readonly container: Container,
    private readonly env: WorkCatalogEnvironment = {},
  ) {}

  private async clientSummary(): Promise<{
    count: number;
    blockedCurrentRows: number;
    authority: string;
  }> {
    const currentAuthority = this.env.WECHAT_WORK_CLIENT_CURRENT_AUTHORITY?.trim()
      === "verified";
    if (currentAuthority) {
      const rows = await this.container.db.select({ value: count() })
        .from(workClientCurrent)
        .innerJoin(workClientProjectionFence, and(
          eq(workClientProjectionFence.corpId, workClientCurrent.corpId),
          eq(workClientProjectionFence.externalUserid, workClientCurrent.externalUserid),
          eq(workClientProjectionFence.lastEventId, workClientCurrent.lastEventId),
          eq(workClientProjectionFence.lastEventKey, workClientCurrent.lastEventKey),
          eq(
            workClientProjectionFence.lastEventSubjectKeyHash,
            workClientCurrent.lastEventSubjectKeyHash,
          ),
          eq(workClientProjectionFence.lastEventTime, workClientCurrent.lastEventTime),
          eq(workClientProjectionFence.lastSequenceRank, workClientCurrent.lastSequenceRank),
        ))
        .innerJoin(workCallbackEvent, and(
          eq(workCallbackEvent.id, workClientCurrent.lastEventId),
          eq(workCallbackEvent.corpId, workClientCurrent.corpId),
          eq(workCallbackEvent.eventKey, workClientCurrent.lastEventKey),
          eq(workCallbackEvent.subjectKeyHash, workClientCurrent.lastEventSubjectKeyHash),
          eq(workCallbackEvent.eventTime, workClientCurrent.lastEventTime),
          eq(workCallbackEvent.sequenceRank, workClientCurrent.lastSequenceRank),
        )).where(and(
          eq(workClientCurrent.lifecycleState, "ACTIVE"),
          eq(workClientCurrent.profileComplete, true),
          eq(workClientCurrent.providerSnapshotComplete, true),
          eq(workCallbackEvent.status, "ORDERED"),
          or(
            eq(workCallbackEvent.projectionStatus, "APPLIED"),
            eq(workCallbackEvent.projectionStatus, "APPLIED_NOOP"),
          ),
          or(
            eq(workCallbackEvent.changeType, "add_external_contact"),
            eq(workCallbackEvent.changeType, "edit_external_contact"),
          ),
        ));
      return {
        count: Number(rows[0]?.value ?? 0),
        blockedCurrentRows: 0,
        authority: "enterprise_wechat_client_current",
      };
    }
    const raw = await this.container.db.execute(sql`
      WITH current_state AS MATERIALIZED (
        SELECT count(*)::double precision AS blocked_current_rows
        FROM work_client_current
      ), legacy_state AS MATERIALIZED (
        SELECT count(*)::double precision AS client_count
        FROM work_client AS legacy_row
        CROSS JOIN current_state
        WHERE current_state.blocked_current_rows = 0
          AND legacy_row.delete_time IS NULL
      )
      SELECT current_state.blocked_current_rows, legacy_state.client_count
      FROM current_state CROSS JOIN legacy_state
    `);
    const row = raw[0];
    const blockedCurrentRows = Number(row?.blocked_current_rows ?? 0);
    return {
      count: Number(row?.client_count ?? 0),
      blockedCurrentRows,
      authority: blockedCurrentRows > 0
        ? "client_current_authority_disabled"
        : "postgresql_imported_history",
    };
  }

  private async groupSummary(): Promise<{
    count: number;
    blockedCurrentRows: number;
    authority: string;
  }> {
    const currentAuthority = this.env.WECHAT_WORK_GROUP_CHAT_CURRENT_AUTHORITY?.trim()
      === "verified";
    if (currentAuthority) {
      const raw = await this.container.db.execute(sql`
        SELECT count(*)::double precision AS group_count
        FROM work_group_chat_current AS current_row
        INNER JOIN work_group_chat_projection_fence AS fence
          ON fence.corp_id = current_row.corp_id
         AND fence.chat_id = current_row.chat_id
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
        WHERE callback_event.status = 'ORDERED'
          AND callback_event.projection_status IN ('APPLIED','APPLIED_NOOP')
          AND callback_event.msg_type = 'event'
          AND callback_event.event_type = 'change_external_chat'
          AND (
            (current_row.lifecycle_state = 'ACTIVE'
              AND current_row.profile_complete AND current_row.members_complete
              AND callback_event.change_type IN ('create','update'))
            OR (current_row.lifecycle_state = 'DISMISSED'
              AND callback_event.change_type = 'dismiss')
          )
      `);
      return {
        count: Number(raw[0]?.group_count ?? 0),
        blockedCurrentRows: 0,
        authority: "enterprise_wechat_group_chat_current",
      };
    }
    const raw = await this.container.db.execute(sql`
      WITH current_state AS MATERIALIZED (
        SELECT count(*)::double precision AS blocked_current_rows
        FROM work_group_chat_current
      ), legacy_state AS MATERIALIZED (
        SELECT count(*)::double precision AS group_count
        FROM work_group_chat AS legacy_row
        CROSS JOIN current_state
        WHERE current_state.blocked_current_rows = 0
      )
      SELECT current_state.blocked_current_rows, legacy_state.group_count
      FROM current_state CROSS JOIN legacy_state
    `);
    const blockedCurrentRows = Number(raw[0]?.blocked_current_rows ?? 0);
    return {
      count: Number(raw[0]?.group_count ?? 0),
      blockedCurrentRows,
      authority: blockedCurrentRows > 0
        ? "group_chat_current_authority_disabled"
        : "postgresql_imported_history",
    };
  }

  async summary() {
    const [members, activeMembers, clients, groups, channels, templates, moments, pendingGroup, pendingMoment] =
      await Promise.all([
        this.container.db.select({ value: count() }).from(workMember),
        this.container.db.select({ value: count() }).from(workMember).where(and(eq(workMember.enable, 1), eq(workMember.status, 1))),
        this.clientSummary(),
        this.groupSummary(),
        this.container.db.select({ value: count() }).from(workChannelCode).where(isNull(workChannelCode.deleteTime)),
        this.container.db.select({ value: count() }).from(workGroupTemplate),
        this.container.db.select({ value: count() }).from(workMoment),
        this.container.db.select({ value: count() }).from(workGroupMsgSendResult).where(eq(workGroupMsgSendResult.status, 0)),
        this.container.db.select({ value: count() }).from(workMomentSendResult).where(eq(workMomentSendResult.status, 0)),
      ]);
    return {
      members: Number(members[0]?.value ?? 0),
      active_members: Number(activeMembers[0]?.value ?? 0),
      clients: clients.count,
      groups: groups.count,
      channels: Number(channels[0]?.value ?? 0),
      templates: Number(templates[0]?.value ?? 0),
      moments: Number(moments[0]?.value ?? 0),
      pending_delivery_results: Number(pendingGroup[0]?.value ?? 0) + Number(pendingMoment[0]?.value ?? 0),
      ...runtimeMeta(),
      ...clientCatalogRuntimeMeta(clients.authority),
      blocked_client_current_rows: clients.blockedCurrentRows,
      ...groupCatalogRuntimeMeta(groups.authority),
      blocked_group_current_rows: groups.blockedCurrentRows,
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
    const pattern = like(search);
    const searchCurrent = search
      ? sql`AND (
          current_row.name ILIKE ${pattern} ESCAPE '\\'
          OR current_row.corp_name ILIKE ${pattern} ESCAPE '\\'
          OR current_row.external_userid ILIKE ${pattern} ESCAPE '\\'
        )`
      : sql``;
    const searchLegacy = search
      ? sql`AND (
          legacy_row.name ILIKE ${pattern} ESCAPE '\\'
          OR legacy_row.corp_name ILIKE ${pattern} ESCAPE '\\'
          OR legacy_row.remark ILIKE ${pattern} ESCAPE '\\'
          OR legacy_row.external_userid ILIKE ${pattern} ESCAPE '\\'
        )`
      : sql``;
    const currentAuthority = this.env.WECHAT_WORK_CLIENT_CURRENT_AUTHORITY?.trim()
      === "verified";
    if (currentAuthority) {
      const raw = await this.container.db.execute(sql`
        WITH eligible AS MATERIALIZED (
          SELECT current_row.*
          FROM work_client_current AS current_row
          INNER JOIN work_client_projection_fence AS fence
            ON fence.corp_id = current_row.corp_id
           AND fence.external_userid = current_row.external_userid
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
            AND current_row.provider_snapshot_complete = true
            AND callback_event.status = 'ORDERED'
            AND callback_event.projection_status IN ('APPLIED', 'APPLIED_NOOP')
            AND callback_event.change_type IN ('add_external_contact', 'edit_external_contact')
            ${searchCurrent}
        ), totals AS MATERIALIZED (
          SELECT count(*)::double precision AS total_count FROM eligible
        ), paged AS MATERIALIZED (
          SELECT eligible.*
          FROM eligible
          ORDER BY eligible.update_time DESC, eligible.id DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}
        )
        SELECT
          paged.id::integer,
          paged.external_userid,
          paged.uid::integer,
          paged.name,
          paged.avatar,
          paged.type::integer,
          paged.gender::integer,
          paged.unionid,
          paged.position,
          paged.corp_name,
          paged.corp_full_name,
          paged.create_time::integer,
          paged.update_time::integer,
          totals.total_count
        FROM totals
        LEFT JOIN paged ON true
        ORDER BY paged.update_time DESC NULLS LAST, paged.id DESC NULLS LAST
      `);
      const rows: Array<CurrentClientCatalogRow & { total_count: number }> = [];
      for (const rawRow of raw) {
        if (rawRow.id === null || rawRow.id === undefined) continue;
        rows.push(currentClientCatalogRow(rawRow));
      }
      return {
        list: rows.map((row) => ({
          id: Number(row.id),
          external_userid: maskIdentifier(row.external_userid),
          uid: Number(row.uid ?? 0),
          name: row.name,
          avatar: row.avatar ?? "",
          type: Number(row.type),
          gender: Number(row.gender),
          unionid: maskIdentifier(row.unionid ?? ""),
          position: row.position ?? "",
          corp_name: row.corp_name ?? "",
          corp_full_name: row.corp_full_name ?? "",
          remark: "",
          create_time: Number(row.create_time),
          update_time: Number(row.update_time),
        })),
        count: Number(raw[0]?.total_count ?? 0),
        ...clientCatalogRuntimeMeta("enterprise_wechat_client_current"),
      };
    }

    // Authority-off fallback and its current-row sentinel share one statement
    // snapshot, so a first current row cannot race a stale legacy page.
    const raw = await this.container.db.execute(sql`
      WITH current_state AS MATERIALIZED (
        SELECT count(*)::double precision AS blocked_current_rows
        FROM work_client_current
      ), eligible_legacy AS MATERIALIZED (
        SELECT legacy_row.*
        FROM work_client AS legacy_row
        CROSS JOIN current_state
        WHERE current_state.blocked_current_rows = 0
          AND legacy_row.delete_time IS NULL
          ${searchLegacy}
      ), totals AS MATERIALIZED (
        SELECT count(*)::double precision AS total_count FROM eligible_legacy
      ), paged AS MATERIALIZED (
        SELECT eligible_legacy.*
        FROM eligible_legacy
        ORDER BY eligible_legacy.update_time DESC, eligible_legacy.id DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      )
      SELECT current_state.blocked_current_rows, totals.total_count, paged.*
      FROM current_state
      CROSS JOIN totals
      LEFT JOIN paged ON true
      ORDER BY paged.update_time DESC NULLS LAST, paged.id DESC NULLS LAST
    `);
    const rows: LegacyClientCatalogRow[] = [];
    for (const rawRow of raw) rows.push(legacyClientCatalogRow(rawRow));
    const blockedCurrentRows = Number(rows[0]?.blocked_current_rows ?? 0);
    if (blockedCurrentRows > 0) {
      return {
        list: [],
        count: 0,
        blocked_current_rows: blockedCurrentRows,
        ...clientCatalogRuntimeMeta("client_current_authority_disabled"),
      };
    }
    const legacyRows = rows.filter(
      (row): row is LegacyClientCatalogRow & { id: number } => row.id !== null,
    );
    return {
      list: legacyRows.map((row) => ({
        id: row.id,
        external_userid: maskIdentifier(row.external_userid ?? ""),
        uid: Number(row.uid ?? 0),
        name: row.name ?? "",
        avatar: row.avatar ?? "",
        type: Number(row.type ?? 0),
        gender: Number(row.gender ?? 0),
        unionid: maskIdentifier(row.unionid ?? ""),
        position: row.position ?? "",
        corp_name: row.corp_name ?? "",
        corp_full_name: row.corp_full_name ?? "",
        remark: row.remark ?? "",
        create_time: Number(row.create_time ?? 0),
        update_time: Number(row.update_time ?? 0),
      })),
      count: Number(rows[0]?.total_count ?? 0),
      ...runtimeMeta(),
      ...clientCatalogRuntimeMeta("postgresql_imported_history"),
    };
  }

  async groups(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = keyword(query.keyword ?? query.name);
    const status = optionalStatus(query.status);
    const pattern = like(search);
    const currentAuthority = this.env.WECHAT_WORK_GROUP_CHAT_CURRENT_AUTHORITY?.trim()
      === "verified";
    if (currentAuthority) {
      const raw = await this.container.db.execute(sql`
        WITH eligible AS MATERIALIZED (
          SELECT current_row.*
          FROM work_group_chat_current AS current_row
          INNER JOIN work_group_chat_projection_fence AS fence
            ON fence.corp_id = current_row.corp_id
           AND fence.chat_id = current_row.chat_id
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
          WHERE callback_event.status = 'ORDERED'
            AND callback_event.projection_status IN ('APPLIED','APPLIED_NOOP')
            AND callback_event.msg_type = 'event'
            AND callback_event.event_type = 'change_external_chat'
            AND (
              (current_row.lifecycle_state = 'ACTIVE'
                AND current_row.profile_complete AND current_row.members_complete
                AND callback_event.change_type IN ('create','update'))
              OR (current_row.lifecycle_state = 'DISMISSED'
                AND callback_event.change_type = 'dismiss')
            )
            ${status === undefined ? sql`` : sql`AND current_row.provider_status = ${status}`}
            ${search ? sql`AND (
              current_row.name ILIKE ${pattern} ESCAPE '\\'
              OR current_row.chat_id ILIKE ${pattern} ESCAPE '\\'
              OR current_row.owner ILIKE ${pattern} ESCAPE '\\'
            )` : sql``}
        ), totals AS (
          SELECT count(*)::double precision AS total_count FROM eligible
        ), paged AS (
          SELECT * FROM eligible
          ORDER BY update_time DESC, id DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}
        )
        SELECT paged.*, totals.total_count
        FROM totals LEFT JOIN LATERAL (SELECT * FROM paged) AS paged ON true
        ORDER BY paged.update_time DESC NULLS LAST, paged.id DESC NULLS LAST
      `);
      const rows = raw.filter((row) => row.id !== null && row.id !== undefined);
      return {
        list: rows.map((row) => {
          const lifecycle = String(row.lifecycle_state ?? "");
          const admins = Array.isArray(row.admin_list) ? row.admin_list : [];
          return {
            id: Number(row.id),
            chat_id: maskIdentifier(String(row.chat_id ?? "")),
            name: String(row.name ?? ""),
            owner: maskIdentifier(String(row.owner ?? "")),
            group_create_time: Number(row.group_created_time ?? 0),
            notice: previewText(row.notice == null ? "" : String(row.notice), 120),
            admin_count: admins.length,
            member_num: Number(row.member_count ?? 0),
            retreat_group_num: Number(row.departed_member_count ?? 0),
            status: row.provider_status == null ? 0 : Number(row.provider_status),
            lifecycle_state: lifecycle,
            update_time: Number(row.update_time ?? 0),
          };
        }),
        count: Number(raw[0]?.total_count ?? 0),
        ...groupCatalogRuntimeMeta("enterprise_wechat_group_chat_current"),
      };
    }

    const raw = await this.container.db.execute(sql`
      WITH current_state AS MATERIALIZED (
        SELECT count(*)::double precision AS blocked_current_rows
        FROM work_group_chat_current
      ), eligible_legacy AS MATERIALIZED (
        SELECT legacy_row.*
        FROM work_group_chat AS legacy_row
        CROSS JOIN current_state
        WHERE current_state.blocked_current_rows = 0
          ${status === undefined ? sql`` : sql`AND legacy_row.status = ${status}`}
          ${search ? sql`AND (
            legacy_row.name ILIKE ${pattern} ESCAPE '\\'
            OR legacy_row.chat_id ILIKE ${pattern} ESCAPE '\\'
            OR legacy_row.owner ILIKE ${pattern} ESCAPE '\\'
          )` : sql``}
      ), totals AS (
        SELECT count(*)::double precision AS total_count FROM eligible_legacy
      ), paged AS (
        SELECT * FROM eligible_legacy
        ORDER BY update_time DESC, id DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      )
      SELECT current_state.blocked_current_rows, paged.*, totals.total_count
      FROM current_state CROSS JOIN totals
      LEFT JOIN LATERAL (SELECT * FROM paged) AS paged ON true
      ORDER BY paged.update_time DESC NULLS LAST, paged.id DESC NULLS LAST
    `);
    const blockedCurrentRows = Number(raw[0]?.blocked_current_rows ?? 0);
    if (blockedCurrentRows > 0) {
      return {
        list: [],
        count: 0,
        blocked_current_rows: blockedCurrentRows,
        ...groupCatalogRuntimeMeta("group_chat_current_authority_disabled"),
      };
    }
    const rows = raw.filter((row) => row.id !== null && row.id !== undefined);
    return {
      list: rows.map((row) => ({
        id: Number(row.id),
        chat_id: maskIdentifier(String(row.chat_id ?? "")),
        name: String(row.name ?? ""),
        owner: maskIdentifier(String(row.owner ?? "")),
        group_create_time: Number(row.group_create_time ?? 0),
        notice: previewText(row.notice == null ? "" : String(row.notice), 120),
        admin_count: parseStringList(row.admin_list == null ? "" : String(row.admin_list)).length,
        member_num: Number(row.member_num ?? 0),
        retreat_group_num: Number(row.retreat_group_num ?? 0),
        status: Number(row.status ?? 0),
        update_time: Number(row.update_time ?? 0),
      })),
      count: Number(raw[0]?.total_count ?? 0),
      ...groupCatalogRuntimeMeta("postgresql_imported_history"),
    };
  }

  async groupMembers(groupValue: string, query: Record<string, string>) {
    const groupId = integer(groupValue, "客户群ID", { fallback: 0, min: 1 });
    const { page, limit } = pageQuery(query);
    const status = optionalStatus(query.status);
    const currentAuthority = this.env.WECHAT_WORK_GROUP_CHAT_CURRENT_AUTHORITY?.trim()
      === "verified";
    if (currentAuthority) {
      const lifecycle = status === undefined
        ? undefined
        : status === 1
          ? "ACTIVE"
          : status === 0
            ? "LEFT"
            : status === 2
              ? "DISMISSED"
              : "__NONE__";
      const raw = await this.container.db.execute(sql`
        WITH eligible_group AS MATERIALIZED (
          SELECT current_row.id, current_row.corp_id
          FROM work_group_chat_current AS current_row
          INNER JOIN work_group_chat_projection_fence AS fence
            ON fence.corp_id = current_row.corp_id
           AND fence.chat_id = current_row.chat_id
           AND fence.last_event_id = current_row.last_event_id
           AND fence.last_event_key = current_row.last_event_key
           AND fence.last_event_subject_key_hash = current_row.last_event_subject_key_hash
           AND fence.last_event_time = current_row.last_event_time
           AND fence.last_sequence_rank = current_row.last_sequence_rank
          INNER JOIN work_callback_event AS group_event
            ON group_event.id = current_row.last_event_id
           AND group_event.corp_id = current_row.corp_id
           AND group_event.event_key = current_row.last_event_key
           AND group_event.subject_key_hash = current_row.last_event_subject_key_hash
           AND group_event.event_time = current_row.last_event_time
           AND group_event.sequence_rank = current_row.last_sequence_rank
          WHERE current_row.id = ${groupId}
            AND (SELECT count(*) FROM work_group_chat_current
              WHERE id = ${groupId}) = 1
            AND group_event.status = 'ORDERED'
            AND group_event.projection_status IN ('APPLIED','APPLIED_NOOP')
            AND group_event.msg_type = 'event'
            AND group_event.event_type = 'change_external_chat'
            AND (
              (current_row.lifecycle_state = 'ACTIVE'
                AND current_row.profile_complete AND current_row.members_complete
                AND group_event.change_type IN ('create','update'))
              OR (current_row.lifecycle_state = 'DISMISSED'
                AND group_event.change_type = 'dismiss')
            )
        ), eligible AS MATERIALIZED (
          SELECT member_row.*
          FROM work_group_chat_member_current AS member_row
          INNER JOIN eligible_group AS group_row
            ON group_row.corp_id = member_row.corp_id
           AND group_row.id = member_row.group_id
          INNER JOIN work_callback_event AS member_event
            ON member_event.id = member_row.last_event_id
           AND member_event.corp_id = member_row.corp_id
           AND member_event.event_key = member_row.last_event_key
           AND member_event.subject_key_hash = member_row.last_event_subject_key_hash
           AND member_event.event_time = member_row.last_event_time
           AND member_event.sequence_rank = member_row.last_sequence_rank
          WHERE member_event.status = 'ORDERED'
            AND member_event.projection_status IN ('APPLIED','APPLIED_NOOP')
            AND member_event.msg_type = 'event'
            AND member_event.event_type = 'change_external_chat'
            AND member_event.change_type IN ('create','update','dismiss')
            ${lifecycle === undefined ? sql`` : sql`AND member_row.lifecycle_state = ${lifecycle}`}
        ), totals AS (
          SELECT count(*)::double precision AS total_count FROM eligible
        ), paged AS (
          SELECT * FROM eligible
          ORDER BY join_time DESC, id DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}
        )
        SELECT paged.*, totals.total_count
        FROM totals LEFT JOIN LATERAL (SELECT * FROM paged) AS paged ON true
        ORDER BY paged.join_time DESC NULLS LAST, paged.id DESC NULLS LAST
      `);
      const rows = raw.filter((row) => row.id !== null && row.id !== undefined);
      return {
        list: rows.map((row) => {
          const memberLifecycle = String(row.lifecycle_state ?? "");
          return {
            id: Number(row.id),
            group_id: Number(row.group_id),
            userid: maskIdentifier(String(row.userid ?? "")),
            type: Number(row.type ?? 0),
            unionid: maskIdentifier(String(row.unionid ?? "")),
            join_time: Number(row.join_time ?? 0),
            join_scene: Number(row.join_scene ?? 0),
            group_nickname: String(row.group_nickname ?? ""),
            name: String(row.name ?? ""),
            status: memberLifecycle === "ACTIVE" ? 1 : memberLifecycle === "LEFT" ? 0 : 2,
            lifecycle_state: memberLifecycle,
            state: String(row.state ?? ""),
            left_time: row.left_time == null ? null : Number(row.left_time),
          };
        }),
        count: Number(raw[0]?.total_count ?? 0),
        ...groupCatalogRuntimeMeta("enterprise_wechat_group_chat_current"),
      };
    }

    const raw = await this.container.db.execute(sql`
      WITH current_state AS MATERIALIZED (
        SELECT count(*)::double precision AS blocked_current_rows
        FROM work_group_chat_current
      ), eligible_legacy AS MATERIALIZED (
        SELECT member_row.*
        FROM work_group_chat_member AS member_row
        CROSS JOIN current_state
        WHERE current_state.blocked_current_rows = 0
          AND member_row.group_id = ${groupId}
          ${status === undefined ? sql`` : sql`AND member_row.status = ${status}`}
      ), totals AS (
        SELECT count(*)::double precision AS total_count FROM eligible_legacy
      ), paged AS (
        SELECT * FROM eligible_legacy
        ORDER BY join_time DESC, id DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      )
      SELECT current_state.blocked_current_rows, paged.*, totals.total_count
      FROM current_state CROSS JOIN totals
      LEFT JOIN LATERAL (SELECT * FROM paged) AS paged ON true
      ORDER BY paged.join_time DESC NULLS LAST, paged.id DESC NULLS LAST
    `);
    const blockedCurrentRows = Number(raw[0]?.blocked_current_rows ?? 0);
    if (blockedCurrentRows > 0) {
      return {
        list: [],
        count: 0,
        blocked_current_rows: blockedCurrentRows,
        ...groupCatalogRuntimeMeta("group_chat_current_authority_disabled"),
      };
    }
    const rows = raw.filter((row) => row.id !== null && row.id !== undefined);
    return {
      list: rows.map((row) => ({
        id: Number(row.id),
        group_id: Number(row.group_id),
        userid: maskIdentifier(String(row.userid ?? "")),
        type: Number(row.type ?? 0),
        unionid: maskIdentifier(String(row.unionid ?? "")),
        join_time: Number(row.join_time ?? 0),
        join_scene: Number(row.join_scene ?? 0),
        group_nickname: String(row.group_nickname ?? ""),
        name: String(row.name ?? ""),
        status: Number(row.status ?? 0),
        state: String(row.state ?? ""),
      })),
      count: Number(raw[0]?.total_count ?? 0),
      ...groupCatalogRuntimeMeta("postgresql_imported_history"),
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
    const pattern = like(search);
    const currentAuthority = this.env.WECHAT_WORK_TAG_CURRENT_AUTHORITY?.trim()
      === "verified"
      && this.env.WECHAT_WORK_EXTERNAL_CONTACT_FULL_VISIBILITY?.trim() === "verified";
    if (currentAuthority) {
      const raw = await this.container.db.execute(sql`
        SELECT
          tag_row.strategy_id,
          tag_row.tag_id,
          tag_row.group_id,
          group_row.group_name,
          tag_row.name,
          tag_row.sort_order,
          tag_row.provider_create_time
        FROM work_external_tag_current AS tag_row
        INNER JOIN work_external_tag_group_current AS group_row
          ON group_row.corp_id = tag_row.corp_id
         AND group_row.strategy_id = tag_row.strategy_id
         AND group_row.group_id = tag_row.group_id
        INNER JOIN work_callback_event AS tag_event
          ON tag_event.id = tag_row.last_event_id
         AND tag_event.corp_id = tag_row.corp_id
         AND tag_event.event_key = tag_row.last_event_key
         AND tag_event.subject_key_hash = tag_row.last_event_subject_key_hash
         AND tag_event.event_time = tag_row.last_event_time
         AND tag_event.sequence_rank = tag_row.last_sequence_rank
        INNER JOIN work_callback_event AS group_event
          ON group_event.id = group_row.last_event_id
         AND group_event.corp_id = group_row.corp_id
         AND group_event.event_key = group_row.last_event_key
         AND group_event.subject_key_hash = group_row.last_event_subject_key_hash
         AND group_event.event_time = group_row.last_event_time
         AND group_event.sequence_rank = group_row.last_sequence_rank
        WHERE tag_row.lifecycle_state = 'ACTIVE'
          AND tag_row.snapshot_complete
          AND group_row.lifecycle_state = 'ACTIVE'
          AND group_row.snapshot_complete
          AND tag_event.status = 'ORDERED'
          AND tag_event.projection_status IN ('APPLIED','APPLIED_NOOP')
          AND tag_event.msg_type = 'event'
          AND tag_event.event_type = 'change_external_tag'
          AND tag_event.change_type IN ('create','update','delete','shuffle')
          AND group_event.status = 'ORDERED'
          AND group_event.projection_status IN ('APPLIED','APPLIED_NOOP')
          AND group_event.msg_type = 'event'
          AND group_event.event_type = 'change_external_tag'
          AND group_event.change_type IN ('create','update','delete','shuffle')
          ${search ? sql`AND (
            tag_row.name ILIKE ${pattern} ESCAPE '\\'
            OR group_row.group_name ILIKE ${pattern} ESCAPE '\\'
          )` : sql``}
        ORDER BY tag_row.strategy_id, group_row.sort_order, group_row.group_id,
          tag_row.sort_order, tag_row.tag_id
        LIMIT ${MAX_TREE_ROWS}
      `);
      return {
        list: raw.map((row) => ({
          id: String(row.tag_id ?? ""),
          tag_id: String(row.tag_id ?? ""),
          group_id: String(row.group_id ?? ""),
          group_name: String(row.group_name ?? ""),
          name: String(row.name ?? ""),
          sort: Number(row.sort_order ?? 0),
          strategy_id: Number(row.strategy_id ?? 0),
          create_time: Number(row.provider_create_time ?? 0),
        })),
        count: raw.length,
        truncated: raw.length === MAX_TREE_ROWS,
        ...runtimeMeta(),
        label_catalog_authority: "enterprise_wechat_external_tag_current",
      };
    }
    const raw = await this.container.db.execute(sql`
      WITH current_state AS MATERIALIZED (
        SELECT (
          (SELECT count(*) FROM work_external_tag_group_current)
          + (SELECT count(*) FROM work_external_tag_current)
          + (SELECT count(*) FROM work_external_tag_projection_fence)
        )::double precision AS blocked_current_rows
      ), eligible_legacy AS MATERIALIZED (
        SELECT legacy_row.*
        FROM work_label AS legacy_row
        CROSS JOIN current_state
        WHERE current_state.blocked_current_rows = 0
          ${search ? sql`AND (
            legacy_row.name ILIKE ${pattern} ESCAPE '\\'
            OR legacy_row.group_name ILIKE ${pattern} ESCAPE '\\'
          )` : sql``}
        ORDER BY legacy_row.group_id, legacy_row.sort, legacy_row.id
        LIMIT ${MAX_TREE_ROWS}
      )
      SELECT current_state.blocked_current_rows, eligible_legacy.*
      FROM current_state LEFT JOIN LATERAL (
        SELECT * FROM eligible_legacy
      ) AS eligible_legacy ON true
      ORDER BY eligible_legacy.group_id NULLS LAST,
        eligible_legacy.sort NULLS LAST, eligible_legacy.id NULLS LAST
    `);
    const blockedCurrentRows = Number(raw[0]?.blocked_current_rows ?? 0);
    if (blockedCurrentRows > 0) {
      return {
        list: [],
        count: 0,
        blocked_current_rows: blockedCurrentRows,
        truncated: false,
        ...runtimeMeta(),
        label_catalog_authority: "external_tag_current_authority_disabled",
      };
    }
    const rows = raw.filter((row) => row.id !== null && row.id !== undefined);
    return {
      list: rows.map((row) => ({
        id: Number(row.id),
        group_id: Number(row.group_id ?? 0),
        group_name: String(row.group_name ?? ""),
        name: String(row.name ?? ""),
        sort: Number(row.sort ?? 0),
      })),
      count: rows.length,
      truncated: rows.length === MAX_TREE_ROWS,
      ...runtimeMeta(),
      label_catalog_authority: "postgresql_imported_history",
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
