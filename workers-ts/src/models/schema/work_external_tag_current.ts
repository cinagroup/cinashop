/**
 * Canonical Enterprise WeChat customer-tag catalog.
 *
 * Remote group/tag identifiers are strings and are intentionally kept apart
 * from legacy work_label's local serial/integer identities.  Rows are never
 * deleted: provider snapshots and authoritative callbacks move them to an
 * explicit tombstone state while preserving replay evidence.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  varchar,
} from "drizzle-orm/pg-core";
import { workCallbackEvent } from "./work_callback";

export const WORK_EXTERNAL_TAG_CURRENT_STATES = ["ACTIVE", "DELETED"] as const;
export type WorkExternalTagCurrentState =
  (typeof WORK_EXTERNAL_TAG_CURRENT_STATES)[number];

function callbackColumns() {
  return {
    lastEventId: integer("last_event_id").notNull(),
    lastEventKey: varchar("last_event_key", { length: 64 }).notNull(),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }).notNull(),
    lastEventTime: integer("last_event_time").notNull(),
    lastSequenceRank: integer("last_sequence_rank").notNull(),
  };
}

export const workExternalTagGroupCurrent = pgTable(
  "work_external_tag_group_current",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    strategyId: integer("strategy_id").default(0).notNull(),
    groupId: varchar("group_id", { length: 128 }).notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkExternalTagCurrentState>()
      .notNull(),
    snapshotComplete: boolean("snapshot_complete").default(false).notNull(),
    groupName: varchar("group_name", { length: 256 }),
    sortOrder: integer("sort_order"),
    providerCreateTime: integer("provider_create_time"),
    ...callbackColumns(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    deletedTime: integer("deleted_time"),
  },
  (table) => [
    primaryKey({
      name: "wetgc_pk",
      columns: [table.corpId, table.strategyId, table.groupId],
    }),
    foreignKey({
      name: "wetgc_last_event_fk",
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
    check("wetgc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wetgc_identity_ck",
      sql`${table.strategyId} BETWEEN 0 AND 2147483647
        AND ${table.groupId} <> '' AND ${table.groupId} = btrim(${table.groupId})
        AND octet_length(${table.groupId}) <= 128
        AND ${table.groupId} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wetgc_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('ACTIVE', 'DELETED')`,
    ),
    check(
      "wetgc_values_ck",
      sql`(${table.groupName} IS NULL OR (
          ${table.groupName} <> '' AND ${table.groupName} = btrim(${table.groupName})
          AND ${table.groupName} !~ '[[:cntrl:]]'
        ))
        AND (${table.sortOrder} IS NULL OR ${table.sortOrder} BETWEEN 0 AND 2147483647)
        AND (${table.providerCreateTime} IS NULL OR ${table.providerCreateTime} >= 0)`,
    ),
    check(
      "wetgc_event_fence_ck",
      sql`${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0 AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wetgc_snapshot_ck",
      sql`(
          ${table.lifecycleState} = 'ACTIVE'
          AND ${table.snapshotComplete} = true
          AND ${table.groupName} IS NOT NULL
          AND ${table.sortOrder} IS NOT NULL
          AND ${table.providerCreateTime} IS NOT NULL
          AND ${table.deletedTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'DELETED'
          AND ${table.snapshotComplete} = false
          AND ${table.deletedTime} IS NOT NULL
        )`,
    ),
    check(
      "wetgc_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0
        AND (${table.deletedTime} IS NULL OR ${table.deletedTime} > 0)`,
    ),
    index("wetgc_catalog_idx").on(
      table.corpId,
      table.strategyId,
      table.lifecycleState,
      table.sortOrder,
      table.groupId,
    ),
    index("wetgc_last_event_idx").on(table.lastEventId),
  ],
);

export const workExternalTagCurrent = pgTable(
  "work_external_tag_current",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    strategyId: integer("strategy_id").default(0).notNull(),
    tagId: varchar("tag_id", { length: 128 }).notNull(),
    groupId: varchar("group_id", { length: 128 }),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkExternalTagCurrentState>()
      .notNull(),
    snapshotComplete: boolean("snapshot_complete").default(false).notNull(),
    name: varchar("name", { length: 256 }),
    sortOrder: integer("sort_order"),
    providerCreateTime: integer("provider_create_time"),
    ...callbackColumns(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    deletedTime: integer("deleted_time"),
  },
  (table) => [
    primaryKey({
      name: "wetc_pk",
      columns: [table.corpId, table.strategyId, table.tagId],
    }),
    foreignKey({
      name: "wetc_group_fk",
      columns: [table.corpId, table.strategyId, table.groupId],
      foreignColumns: [
        workExternalTagGroupCurrent.corpId,
        workExternalTagGroupCurrent.strategyId,
        workExternalTagGroupCurrent.groupId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "wetc_last_event_fk",
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
    check("wetc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wetc_identity_ck",
      sql`${table.strategyId} BETWEEN 0 AND 2147483647
        AND ${table.tagId} <> '' AND ${table.tagId} = btrim(${table.tagId})
        AND octet_length(${table.tagId}) <= 128 AND ${table.tagId} !~ '[[:cntrl:]]'
        AND (${table.groupId} IS NULL OR (
          ${table.groupId} <> '' AND ${table.groupId} = btrim(${table.groupId})
          AND octet_length(${table.groupId}) <= 128
          AND ${table.groupId} !~ '[[:cntrl:]]'
        ))`,
    ),
    check(
      "wetc_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('ACTIVE', 'DELETED')`,
    ),
    check(
      "wetc_values_ck",
      sql`(${table.name} IS NULL OR (
          ${table.name} <> '' AND ${table.name} = btrim(${table.name})
          AND ${table.name} !~ '[[:cntrl:]]'
        ))
        AND (${table.sortOrder} IS NULL OR ${table.sortOrder} BETWEEN 0 AND 2147483647)
        AND (${table.providerCreateTime} IS NULL OR ${table.providerCreateTime} >= 0)`,
    ),
    check(
      "wetc_event_fence_ck",
      sql`${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0 AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wetc_snapshot_ck",
      sql`(
          ${table.lifecycleState} = 'ACTIVE'
          AND ${table.snapshotComplete} = true
          AND ${table.groupId} IS NOT NULL
          AND ${table.name} IS NOT NULL
          AND ${table.sortOrder} IS NOT NULL
          AND ${table.providerCreateTime} IS NOT NULL
          AND ${table.deletedTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'DELETED'
          AND ${table.snapshotComplete} = false
          AND ${table.deletedTime} IS NOT NULL
        )`,
    ),
    check(
      "wetc_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0
        AND (${table.deletedTime} IS NULL OR ${table.deletedTime} > 0)`,
    ),
    index("wetc_group_state_idx").on(
      table.corpId,
      table.strategyId,
      table.groupId,
      table.lifecycleState,
      table.sortOrder,
      table.tagId,
    ),
    index("wetc_last_event_idx").on(table.lastEventId),
  ],
);

export const workExternalTagProjectionFence = pgTable(
  "work_external_tag_projection_fence",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    strategyId: integer("strategy_id").default(0).notNull(),
    subjectType: varchar("subject_type", { length: 16 }).notNull(),
    remoteId: varchar("remote_id", { length: 128 }).notNull(),
    ...callbackColumns(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      name: "wetpf_pk",
      columns: [table.corpId, table.strategyId, table.subjectType, table.remoteId],
    }),
    foreignKey({
      name: "wetpf_last_event_fk",
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
    check("wetpf_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wetpf_identity_ck",
      sql`${table.strategyId} BETWEEN 0 AND 2147483647
        AND ${table.subjectType} IN ('tag', 'tag_group', 'catalog')
        AND ${table.remoteId} <> '' AND ${table.remoteId} = btrim(${table.remoteId})
        AND octet_length(${table.remoteId}) <= 128
        AND ${table.remoteId} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wetpf_event_fence_ck",
      sql`${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0 AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wetpf_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
    index("wetpf_last_event_idx").on(table.lastEventId),
  ],
);

export type WorkExternalTagGroupCurrent =
  typeof workExternalTagGroupCurrent.$inferSelect;
export type WorkExternalTagCurrent = typeof workExternalTagCurrent.$inferSelect;
export type WorkExternalTagProjectionFence =
  typeof workExternalTagProjectionFence.$inferSelect;
