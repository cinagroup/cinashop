/**
 * Canonical Enterprise WeChat department projection.
 *
 * The legacy work_department table remains import evidence. The projection
 * fence is deliberately separate from business current state so a parked or
 * in-flight event can advance latest-seen ordering without exposing a partial
 * department snapshot.
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
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { workCallbackEvent } from "./work_callback";

export const WORK_DEPARTMENT_CURRENT_STATES = [
  "UNRESOLVED",
  "ACTIVE",
  "DELETED",
] as const;
export type WorkDepartmentCurrentState =
  (typeof WORK_DEPARTMENT_CURRENT_STATES)[number];

export const workDepartmentCurrent = pgTable(
  "work_department_current",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    departmentId: integer("department_id").notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkDepartmentCurrentState>()
      .default("UNRESOLVED")
      .notNull(),
    profileComplete: boolean("profile_complete").default(false).notNull(),
    name: varchar("name", { length: 128 }),
    nameEn: varchar("name_en", { length: 128 }),
    parentDepartmentId: integer("parent_department_id"),
    sortOrder: bigint("sort_order", { mode: "number" }),
    lastEventId: integer("last_event_id"),
    lastEventKey: varchar("last_event_key", { length: 64 }),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }),
    lastEventTime: integer("last_event_time").default(0).notNull(),
    lastSequenceRank: integer("last_sequence_rank").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    deletedTime: integer("deleted_time"),
  },
  (table) => [
    primaryKey({
      name: "wdc_pk",
      columns: [table.corpId, table.departmentId],
    }),
    foreignKey({
      name: "wdc_parent_fk",
      columns: [table.corpId, table.parentDepartmentId],
      foreignColumns: [table.corpId, table.departmentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "wdc_last_event_fk",
      columns: [
        table.lastEventId,
        table.corpId,
        table.lastEventKey,
        table.lastEventSubjectKeyHash,
        table.lastEventTime,
        table.lastSequenceRank,
      ],
      foreignColumns: [
        workCallbackEvent.id,
        workCallbackEvent.corpId,
        workCallbackEvent.eventKey,
        workCallbackEvent.subjectKeyHash,
        workCallbackEvent.eventTime,
        workCallbackEvent.sequenceRank,
      ],
    }).onDelete("restrict"),
    check("wdc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wdc_identity_ck",
      sql`${table.departmentId} > 0
        AND (${table.parentDepartmentId} IS NULL OR (
          ${table.parentDepartmentId} > 0
          AND ${table.parentDepartmentId} <> ${table.departmentId}
        ))`,
    ),
    check(
      "wdc_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('UNRESOLVED', 'ACTIVE', 'DELETED')`,
    ),
    check(
      "wdc_name_ck",
      sql`(${table.name} IS NULL OR (
          ${table.name} <> ''
          AND ${table.name} = btrim(${table.name})
          AND ${table.name} !~ '[[:cntrl:]]'
        ))
        AND (${table.nameEn} IS NULL OR (
          ${table.nameEn} = btrim(${table.nameEn})
          AND ${table.nameEn} !~ '[[:cntrl:]]'
        ))`,
    ),
    check(
      "wdc_sort_ck",
      sql`${table.sortOrder} IS NULL OR (
        ${table.sortOrder} >= 0 AND ${table.sortOrder} <= 4294967295
      )`,
    ),
    check(
      "wdc_event_fence_ck",
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
      "wdc_lifecycle_snapshot_ck",
      sql`(
          ${table.lifecycleState} = 'UNRESOLVED'
          AND ${table.profileComplete} = false
          AND ${table.name} IS NULL
          AND ${table.nameEn} IS NULL
          AND ${table.parentDepartmentId} IS NULL
          AND ${table.sortOrder} IS NULL
          AND ${table.lastEventId} IS NULL
          AND ${table.deletedTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'ACTIVE'
          AND ${table.profileComplete} = true
          AND ${table.name} IS NOT NULL
          AND ${table.nameEn} IS NOT NULL
          AND ${table.sortOrder} IS NOT NULL
          AND ${table.lastEventId} IS NOT NULL
          AND ${table.deletedTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'DELETED'
          AND ${table.profileComplete} = false
          AND ${table.lastEventId} IS NOT NULL
          AND ${table.deletedTime} IS NOT NULL
        )`,
    ),
    check(
      "wdc_time_ck",
      sql`${table.createTime} >= 0
        AND ${table.updateTime} >= 0
        AND (${table.deletedTime} IS NULL OR ${table.deletedTime} > 0)`,
    ),
    index("wdc_active_tree_idx")
      .on(table.corpId, table.parentDepartmentId, table.sortOrder.desc(), table.departmentId)
      .where(sql`${table.lifecycleState} = 'ACTIVE'`),
    uniqueIndex("wdc_active_root_uidx")
      .on(table.corpId)
      .where(sql`${table.lifecycleState} = 'ACTIVE' AND ${table.parentDepartmentId} IS NULL`),
    index("wdc_parent_idx").on(table.corpId, table.parentDepartmentId, table.departmentId),
    index("wdc_last_event_idx")
      .on(table.lastEventId)
      .where(sql`${table.lastEventId} IS NOT NULL`),
  ],
);

export const workDepartmentProjectionFence = pgTable(
  "work_department_projection_fence",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    departmentId: integer("department_id").notNull(),
    lastEventId: integer("last_event_id").notNull(),
    lastEventKey: varchar("last_event_key", { length: 64 }).notNull(),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }).notNull(),
    lastEventTime: integer("last_event_time").notNull(),
    lastSequenceRank: integer("last_sequence_rank").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      name: "wdpf_pk",
      columns: [table.corpId, table.departmentId],
    }),
    foreignKey({
      name: "wdpf_department_fk",
      columns: [table.corpId, table.departmentId],
      foreignColumns: [workDepartmentCurrent.corpId, workDepartmentCurrent.departmentId],
    }).onDelete("restrict"),
    foreignKey({
      name: "wdpf_last_event_fk",
      columns: [
        table.lastEventId,
        table.corpId,
        table.lastEventKey,
        table.lastEventSubjectKeyHash,
        table.lastEventTime,
        table.lastSequenceRank,
      ],
      foreignColumns: [
        workCallbackEvent.id,
        workCallbackEvent.corpId,
        workCallbackEvent.eventKey,
        workCallbackEvent.subjectKeyHash,
        workCallbackEvent.eventTime,
        workCallbackEvent.sequenceRank,
      ],
    }).onDelete("restrict"),
    check("wdpf_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check("wdpf_identity_ck", sql`${table.departmentId} > 0`),
    check(
      "wdpf_event_fence_ck",
      sql`${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0
        AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wdpf_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
    index("wdpf_last_event_idx").on(table.lastEventId),
  ],
);

export const workDepartmentLeaderCurrent = pgTable(
  "work_department_leader_current",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    departmentId: integer("department_id").notNull(),
    userid: varchar("userid", { length: 64 }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      name: "wdlc_pk",
      columns: [table.corpId, table.departmentId, table.userid],
    }),
    foreignKey({
      name: "wdlc_department_fk",
      columns: [table.corpId, table.departmentId],
      foreignColumns: [workDepartmentCurrent.corpId, workDepartmentCurrent.departmentId],
    }).onDelete("restrict"),
    check("wdlc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check("wdlc_identity_ck", sql`${table.departmentId} > 0`),
    check(
      "wdlc_userid_ck",
      sql`${table.userid} <> ''
        AND ${table.userid} = btrim(${table.userid})
        AND ${table.userid} = lower(${table.userid})
        AND ${table.userid} ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$'
        AND ${table.userid} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wdlc_values_ck",
      sql`${table.sortOrder} BETWEEN 0 AND 9
        AND ${table.createTime} >= 0
        AND ${table.updateTime} >= 0`,
    ),
    uniqueIndex("wdlc_position_uidx").on(
      table.corpId,
      table.departmentId,
      table.sortOrder,
    ),
    index("wdlc_userid_idx").on(table.corpId, table.userid, table.departmentId),
  ],
);

// This table is an auditable provider declaration, not an authorization
// grant. Any future permission check must resolve userid through the same-corp
// ACTIVE member/alias current projection and fail closed when unresolved.

export type WorkDepartmentCurrent = typeof workDepartmentCurrent.$inferSelect;
export type NewWorkDepartmentCurrent = typeof workDepartmentCurrent.$inferInsert;
export type WorkDepartmentProjectionFence = typeof workDepartmentProjectionFence.$inferSelect;
export type NewWorkDepartmentProjectionFence = typeof workDepartmentProjectionFence.$inferInsert;
export type WorkDepartmentLeaderCurrent = typeof workDepartmentLeaderCurrent.$inferSelect;
export type NewWorkDepartmentLeaderCurrent = typeof workDepartmentLeaderCurrent.$inferInsert;
