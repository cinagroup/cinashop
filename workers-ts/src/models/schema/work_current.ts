/**
 * Canonical Enterprise WeChat member projection.
 *
 * The legacy work_member/work_member_other/work_member_relation tables remain
 * an immutable import record. These tables are Worker-owned current state and
 * never require fabricated provider fields while a refresh is incomplete.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { workCallbackEvent } from "./work_callback";

export const WORK_MEMBER_CURRENT_STATES = ["ACTIVE", "DELETED"] as const;
export type WorkMemberCurrentState = (typeof WORK_MEMBER_CURRENT_STATES)[number];
export const WORK_MEMBER_IDENTITY_ALIAS_STATES = [
  "UNRESOLVED",
  "ACTIVE",
  "RENAMED",
  "DELETED",
] as const;
export type WorkMemberIdentityAliasState =
  (typeof WORK_MEMBER_IDENTITY_ALIAS_STATES)[number];

export const workMemberCurrent = pgTable(
  "work_member_current",
  {
    id: integer("id").generatedAlwaysAsIdentity(),
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    userid: varchar("userid", { length: 64 }).notNull(),
    canonicalUserid: varchar("canonical_userid", { length: 64 }).notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkMemberCurrentState>()
      .default("ACTIVE")
      .notNull(),
    legacyMemberId: integer("legacy_member_id"),

    // Provider profile fields remain nullable until a complete provider read.
    uid: integer("uid"),
    name: varchar("name", { length: 128 }),
    position: varchar("position", { length: 128 }),
    mobile: varchar("mobile", { length: 32 }),
    gender: smallint("gender"),
    email: varchar("email", { length: 254 }),
    bizMail: varchar("biz_mail", { length: 254 }),
    directLeader: text("direct_leader"),
    avatar: varchar("avatar", { length: 1024 }),
    thumbAvatar: varchar("thumb_avatar", { length: 1024 }),
    telephone: varchar("telephone", { length: 64 }),
    alias: varchar("alias", { length: 64 }),
    enable: smallint("enable"),
    isLeader: smallint("is_leader"),
    hideMobile: smallint("hide_mobile"),
    address: varchar("address", { length: 512 }),
    openUserid: varchar("open_userid", { length: 128 }),
    mainDepartment: integer("main_department"),
    status: smallint("status"),
    qrCode: varchar("qr_code", { length: 1024 }),
    externalPosition: varchar("external_position", { length: 128 }),
    profileComplete: boolean("profile_complete").default(false).notNull(),
    relationsComplete: boolean("relations_complete").default(false).notNull(),

    deletedTime: integer("deleted_time"),
    // Last-applied fence. A null event id represents a provider/bootstrap
    // snapshot with no callback predecessor; otherwise all fields travel together.
    lastEventId: integer("last_event_id"),
    lastEventKey: varchar("last_event_key", { length: 64 }),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }),
    lastEventTime: integer("last_event_time").default(0).notNull(),
    lastSequenceRank: integer("last_sequence_rank").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({ name: "wmc_pk", columns: [table.id] }),
    foreignKey({
      name: "wmc_last_event_fk",
      columns: [table.lastEventId],
      foreignColumns: [workCallbackEvent.id],
    }).onDelete("restrict"),
    check("wmc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wmc_userid_ck",
      sql`${table.userid} <> '' AND ${table.userid} = btrim(${table.userid})
        AND ${table.userid} = lower(${table.userid}) AND ${table.userid} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wmc_canonical_userid_ck",
      sql`${table.canonicalUserid} <> ''
        AND ${table.canonicalUserid} = btrim(${table.canonicalUserid})
        AND ${table.canonicalUserid} = lower(${table.canonicalUserid})
        AND ${table.canonicalUserid} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wmc_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('ACTIVE', 'DELETED')`,
    ),
    check(
      "wmc_values_ck",
      sql`${table.id} > 0
        AND (${table.status} IS NULL OR ${table.status} IN (1, 2, 4, 5))
        AND (${table.enable} IS NULL OR ${table.enable} IN (0, 1))
        AND (${table.isLeader} IS NULL OR ${table.isLeader} IN (0, 1))
        AND (${table.hideMobile} IS NULL OR ${table.hideMobile} IN (0, 1))
        AND (${table.gender} IS NULL OR ${table.gender} IN (0, 1, 2))
        AND (${table.mainDepartment} IS NULL OR ${table.mainDepartment} > 0)
        AND (
          NOT ${table.profileComplete}
          OR (
            ${table.name} IS NOT NULL
            AND ${table.status} IS NOT NULL
            AND ${table.enable} IS NOT NULL
            AND ${table.mainDepartment} IS NOT NULL
          )
        )
        AND (
          ${table.lifecycleState} <> 'DELETED'
          OR (${table.status} = 5 AND ${table.enable} = 0)
        )`,
    ),
    check(
      "wmc_lifecycle_identity_ck",
      sql`(
        ${table.lifecycleState} = 'ACTIVE'
        AND ${table.userid} = ${table.canonicalUserid}
        AND ${table.deletedTime} IS NULL
      ) OR (
        ${table.lifecycleState} = 'DELETED'
        AND ${table.userid} = ${table.canonicalUserid}
        AND ${table.deletedTime} IS NOT NULL
      )`,
    ),
    check(
      "wmc_event_fence_ck",
      sql`(
        ${table.lastEventId} IS NULL
        AND ${table.lastEventKey} IS NULL
        AND ${table.lastEventSubjectKeyHash} IS NULL
        AND ${table.lastEventTime} = 0
        AND ${table.lastSequenceRank} = 0
      ) OR (
        ${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0
        AND ${table.lastSequenceRank} >= 0
      )`,
    ),
    check(
      "wmc_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0
        AND (${table.deletedTime} IS NULL OR ${table.deletedTime} > 0)`,
    ),
    uniqueIndex("wmc_corp_id_uq").on(table.corpId, table.id),
    uniqueIndex("wmc_corp_userid_uq").on(table.corpId, table.userid),
    uniqueIndex("wmc_legacy_member_id_uq")
      .on(table.legacyMemberId)
      .where(sql`${table.legacyMemberId} IS NOT NULL`),
    index("wmc_catalog").on(
      table.corpId,
      table.lifecycleState,
      table.status,
      table.name,
      table.id,
    ),
    index("wmc_last_event_idx")
      .on(table.lastEventId)
      .where(sql`${table.lastEventId} IS NOT NULL`),
  ],
);

export const workMemberIdentityAlias = pgTable(
  "work_member_identity_alias",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    userid: varchar("userid", { length: 64 }).notNull(),
    memberId: integer("member_id"),
    canonicalUserid: varchar("canonical_userid", { length: 64 }).notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkMemberIdentityAliasState>()
      .notNull(),
    // Latest-seen fence is advanced before provider I/O, including while the
    // identity remains UNRESOLVED after a provider failure.
    lastEventId: integer("last_event_id"),
    lastEventKey: varchar("last_event_key", { length: 64 }),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }),
    lastEventTime: integer("last_event_time").default(0).notNull(),
    lastSequenceRank: integer("last_sequence_rank").default(0).notNull(),
    // A rename edge has its own immutable fence. While pending it is stored on
    // the target alias (which points back to its source); once resolved it moves
    // to the source RENAMED alias (which points to the immediate next UserID).
    linkEventId: integer("link_event_id"),
    linkEventTime: integer("link_event_time").default(0).notNull(),
    linkSequenceRank: integer("link_sequence_rank").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({ name: "wmia_pk", columns: [table.corpId, table.userid] }),
    foreignKey({
      name: "wmia_member_fk",
      columns: [table.corpId, table.memberId],
      foreignColumns: [workMemberCurrent.corpId, workMemberCurrent.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "wmia_last_event_fk",
      columns: [table.lastEventId],
      foreignColumns: [workCallbackEvent.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "wmia_link_event_fk",
      columns: [table.linkEventId],
      foreignColumns: [workCallbackEvent.id],
    }).onDelete("restrict"),
    check("wmia_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wmia_userid_ck",
      sql`${table.userid} <> '' AND ${table.userid} = btrim(${table.userid})
        AND ${table.userid} = lower(${table.userid}) AND ${table.userid} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wmia_canonical_userid_ck",
      sql`${table.canonicalUserid} <> ''
        AND ${table.canonicalUserid} = btrim(${table.canonicalUserid})
        AND ${table.canonicalUserid} = lower(${table.canonicalUserid})
        AND ${table.canonicalUserid} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wmia_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('UNRESOLVED', 'ACTIVE', 'RENAMED', 'DELETED')`,
    ),
    check(
      "wmia_lifecycle_identity_ck",
      sql`((
          ${table.lifecycleState} = 'UNRESOLVED'
          AND (
            (${table.userid} = ${table.canonicalUserid} AND ${table.linkEventId} IS NULL)
            OR (${table.userid} <> ${table.canonicalUserid} AND ${table.linkEventId} IS NOT NULL)
          )
        ) OR (
          ${table.lifecycleState} = 'ACTIVE'
          AND ${table.memberId} IS NOT NULL
          AND ${table.userid} = ${table.canonicalUserid}
          AND ${table.linkEventId} IS NULL
        ) OR (
          ${table.lifecycleState} = 'RENAMED'
          AND ${table.memberId} IS NOT NULL
          AND ${table.userid} <> ${table.canonicalUserid}
          AND ${table.linkEventId} IS NOT NULL
        ) OR (
          ${table.lifecycleState} = 'DELETED'
          AND ${table.userid} = ${table.canonicalUserid}
          AND ${table.linkEventId} IS NULL
        ))
        AND (${table.memberId} IS NULL OR ${table.memberId} > 0)`,
    ),
    check(
      "wmia_resolved_link_required_ck",
      sql`${table.lifecycleState} <> 'RENAMED' OR ${table.linkEventId} IS NOT NULL`,
    ),
    check(
      "wmia_event_fence_ck",
      sql`(
        ${table.lastEventId} IS NULL
        AND ${table.lastEventKey} IS NULL
        AND ${table.lastEventSubjectKeyHash} IS NULL
        AND ${table.lastEventTime} = 0
        AND ${table.lastSequenceRank} = 0
      ) OR (
        ${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0
        AND ${table.lastSequenceRank} >= 0
      )`,
    ),
    check(
      "wmia_link_fence_ck",
      sql`(
        ${table.linkEventId} IS NULL
        AND ${table.linkEventTime} = 0
        AND ${table.linkSequenceRank} = 0
      ) OR (
        ${table.linkEventId} > 0
        AND ${table.linkEventTime} > 0
        AND ${table.linkSequenceRank} >= 0
        AND ${table.lastEventId} IS NOT NULL
        AND (${table.linkEventTime}, ${table.linkSequenceRank}, ${table.linkEventId})
          <= (${table.lastEventTime}, ${table.lastSequenceRank}, ${table.lastEventId})
      )`,
    ),
    check(
      "wmia_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
    uniqueIndex("wmia_active_member_uq")
      .on(table.corpId, table.memberId)
      .where(sql`${table.lifecycleState} = 'ACTIVE'`),
    uniqueIndex("wmia_active_canonical_uq")
      .on(table.corpId, table.canonicalUserid)
      .where(sql`${table.lifecycleState} = 'ACTIVE'`),
    index("wmia_pending_source_idx")
      .on(table.corpId, table.canonicalUserid, table.userid)
      .where(sql`${table.lifecycleState} = 'UNRESOLVED' AND ${table.userid} <> ${table.canonicalUserid}`),
    index("wmia_member_history").on(table.corpId, table.memberId, table.updateTime, table.userid),
    index("wmia_last_event_idx")
      .on(table.lastEventId)
      .where(sql`${table.lastEventId} IS NOT NULL`),
    index("wmia_link_event_idx")
      .on(table.linkEventId)
      .where(sql`${table.linkEventId} IS NOT NULL`),
  ],
);

export const workMemberOtherCurrent = pgTable(
  "work_member_other_current",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    memberId: integer("member_id").notNull(),
    extattr: text("extattr"),
    externalProfile: text("external_profile"),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({ name: "wmoc_pk", columns: [table.corpId, table.memberId] }),
    foreignKey({
      name: "wmoc_member_fk",
      columns: [table.corpId, table.memberId],
      foreignColumns: [workMemberCurrent.corpId, workMemberCurrent.id],
    }).onDelete("cascade"),
    check("wmoc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check("wmoc_values_ck", sql`${table.memberId} > 0 AND ${table.updateTime} >= 0`),
  ],
);

export const workMemberRelationCurrent = pgTable(
  "work_member_relation_current",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    memberId: integer("member_id").notNull(),
    departmentId: integer("department_id").notNull(),
    sortOrder: bigint("sort_order", { mode: "number" }).default(0).notNull(),
    isLeaderInDept: smallint("is_leader_in_dept").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      name: "wmrc_pk",
      columns: [table.corpId, table.memberId, table.departmentId],
    }),
    foreignKey({
      name: "wmrc_member_fk",
      columns: [table.corpId, table.memberId],
      foreignColumns: [workMemberCurrent.corpId, workMemberCurrent.id],
    }).onDelete("cascade"),
    check("wmrc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wmrc_values_ck",
      sql`${table.memberId} > 0 AND ${table.departmentId} > 0
        AND ${table.sortOrder} BETWEEN 0 AND 4294967295
        AND ${table.isLeaderInDept} IN (0, 1)`,
    ),
    check(
      "wmrc_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
    index("wmrc_department_catalog").on(
      table.corpId,
      table.departmentId,
      table.sortOrder,
      table.memberId,
    ),
  ],
);

export type WorkMemberCurrent = typeof workMemberCurrent.$inferSelect;
export type NewWorkMemberCurrent = typeof workMemberCurrent.$inferInsert;
export type WorkMemberIdentityAlias = typeof workMemberIdentityAlias.$inferSelect;
export type NewWorkMemberIdentityAlias = typeof workMemberIdentityAlias.$inferInsert;
export type WorkMemberOtherCurrent = typeof workMemberOtherCurrent.$inferSelect;
export type WorkMemberRelationCurrent = typeof workMemberRelationCurrent.$inferSelect;
