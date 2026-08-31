/**
 * Canonical Enterprise WeChat external-contact projection.
 *
 * Legacy work_client/work_client_follow/work_client_follow_tags rows remain
 * immutable import evidence. A client-wide latest-seen fence is separate from
 * business state because callback subjects are relationship-scoped while a
 * provider response can describe several employee relationships.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { workCallbackEvent } from "./work_callback";

export const WORK_CLIENT_CURRENT_STATES = [
  "UNRESOLVED",
  "ACTIVE",
  "INACTIVE",
] as const;
export type WorkClientCurrentState = (typeof WORK_CLIENT_CURRENT_STATES)[number];

export const WORK_CLIENT_FOLLOW_CURRENT_STATES = ["ACTIVE", "DELETED"] as const;
export type WorkClientFollowCurrentState =
  (typeof WORK_CLIENT_FOLLOW_CURRENT_STATES)[number];
export const WORK_CLIENT_FOLLOW_SOURCE_KINDS = ["DIRECT", "SNAPSHOT"] as const;
export type WorkClientFollowSourceKind =
  (typeof WORK_CLIENT_FOLLOW_SOURCE_KINDS)[number];

export const workClientCurrent = pgTable(
  "work_client_current",
  {
    id: integer("id").generatedAlwaysAsIdentity(),
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    externalUserid: varchar("external_userid", { length: 64 }).notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkClientCurrentState>()
      .default("UNRESOLVED")
      .notNull(),
    profileComplete: boolean("profile_complete").default(false).notNull(),
    // This records that one externalcontact/get cursor chain was fully
    // exhausted. It does not authorize deleting a relationship merely because
    // a later callback-triggered snapshot omits it; direct callbacks remain the
    // relationship deletion authority.
    providerSnapshotComplete: boolean("provider_snapshot_complete").default(false).notNull(),

    // uid is a later, separately-authoritative commerce identity link. C5
    // never fabricates it from unionid or from a callback payload.
    uid: integer("uid"),
    name: varchar("name", { length: 128 }),
    avatar: varchar("avatar", { length: 1024 }),
    type: smallint("type"),
    gender: smallint("gender"),
    unionid: varchar("unionid", { length: 128 }),
    position: varchar("position", { length: 128 }),
    corpName: varchar("corp_name", { length: 128 }),
    corpFullName: varchar("corp_full_name", { length: 256 }),
    externalProfile: jsonb("external_profile").$type<Record<string, unknown>>(),

    lastEventId: integer("last_event_id"),
    lastEventKey: varchar("last_event_key", { length: 64 }),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }),
    lastEventTime: integer("last_event_time").default(0).notNull(),
    lastSequenceRank: integer("last_sequence_rank").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    inactiveTime: integer("inactive_time"),
  },
  (table) => [
    primaryKey({ name: "wcc_pk", columns: [table.corpId, table.id] }),
    foreignKey({
      name: "wcc_last_event_fk",
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
    check("wcc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wcc_external_userid_ck",
      sql`${table.externalUserid} <> ''
        AND ${table.externalUserid} = btrim(${table.externalUserid})
        AND octet_length(${table.externalUserid}) <= 64
        AND ${table.externalUserid} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wcc_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('UNRESOLVED', 'ACTIVE', 'INACTIVE')`,
    ),
    check(
      "wcc_values_ck",
      sql`${table.id} > 0
        AND (${table.uid} IS NULL OR ${table.uid} > 0)
        AND (${table.type} IS NULL OR ${table.type} IN (1, 2))
        AND (${table.gender} IS NULL OR ${table.gender} IN (0, 1, 2))
        AND (${table.name} IS NULL OR (
          ${table.name} <> '' AND ${table.name} = btrim(${table.name})
          AND ${table.name} !~ '[[:cntrl:]]'
        ))
        AND (${table.avatar} IS NULL OR ${table.avatar} !~ '[[:cntrl:]]')
        AND (${table.unionid} IS NULL OR ${table.unionid} !~ '[[:cntrl:]]')
        AND (${table.position} IS NULL OR ${table.position} !~ '[[:cntrl:]]')
        AND (${table.corpName} IS NULL OR ${table.corpName} !~ '[[:cntrl:]]')
        AND (${table.corpFullName} IS NULL OR ${table.corpFullName} !~ '[[:cntrl:]]')
        AND (${table.externalProfile} IS NULL OR octet_length(${table.externalProfile}::text) <= 65536)`,
    ),
    check(
      "wcc_event_fence_ck",
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
      "wcc_snapshot_ck",
      sql`(
          ${table.lifecycleState} = 'UNRESOLVED'
          AND ${table.profileComplete} = false
          AND ${table.providerSnapshotComplete} = false
          AND ${table.name} IS NULL
          AND ${table.type} IS NULL
          AND ${table.gender} IS NULL
          AND ${table.externalProfile} IS NULL
          AND ${table.inactiveTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'ACTIVE'
          AND ${table.profileComplete} = true
          AND ${table.providerSnapshotComplete} = true
          AND ${table.name} IS NOT NULL
          AND ${table.type} IS NOT NULL
          AND ${table.gender} IS NOT NULL
          AND ${table.externalProfile} IS NOT NULL
          AND ${table.lastEventId} IS NOT NULL
          AND ${table.inactiveTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'INACTIVE'
          AND ${table.profileComplete} = true
          AND ${table.providerSnapshotComplete} = true
          AND ${table.name} IS NOT NULL
          AND ${table.type} IS NOT NULL
          AND ${table.gender} IS NOT NULL
          AND ${table.externalProfile} IS NOT NULL
          AND ${table.lastEventId} IS NOT NULL
          AND ${table.inactiveTime} IS NOT NULL
        )`,
    ),
    check(
      "wcc_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0
        AND (${table.inactiveTime} IS NULL OR ${table.inactiveTime} > 0)`,
    ),
    uniqueIndex("wcc_corp_external_userid_uq").on(table.corpId, table.externalUserid),
    index("wcc_catalog_idx").on(
      table.corpId,
      table.lifecycleState,
      table.updateTime.desc(),
      table.id,
    ),
    index("wcc_last_event_idx")
      .on(table.lastEventId)
      .where(sql`${table.lastEventId} IS NOT NULL`),
  ],
);

export const workClientProjectionFence = pgTable(
  "work_client_projection_fence",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    externalUserid: varchar("external_userid", { length: 64 }).notNull(),
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
      name: "wcpf_pk",
      columns: [table.corpId, table.externalUserid],
    }),
    foreignKey({
      name: "wcpf_client_fk",
      columns: [table.corpId, table.externalUserid],
      foreignColumns: [workClientCurrent.corpId, workClientCurrent.externalUserid],
    }).onDelete("restrict"),
    foreignKey({
      name: "wcpf_last_event_fk",
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
    check("wcpf_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wcpf_external_userid_ck",
      sql`${table.externalUserid} <> ''
        AND ${table.externalUserid} = btrim(${table.externalUserid})
        AND octet_length(${table.externalUserid}) <= 64
        AND ${table.externalUserid} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wcpf_event_fence_ck",
      sql`${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0
        AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wcpf_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
    index("wcpf_last_event_idx").on(table.lastEventId),
  ],
);

export const workClientFollowCurrent = pgTable(
  "work_client_follow_current",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    clientId: integer("client_id").notNull(),
    userid: varchar("userid", { length: 64 }).notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkClientFollowCurrentState>()
      .default("DELETED")
      .notNull(),
    sourceKind: varchar("source_kind", { length: 16 })
      .$type<WorkClientFollowSourceKind>()
      .default("DIRECT")
      .notNull(),
    profileComplete: boolean("profile_complete").default(false).notNull(),
    tagsComplete: boolean("tags_complete").default(false).notNull(),
    remark: varchar("remark", { length: 512 }),
    description: varchar("description", { length: 1024 }),
    followCreatedTime: integer("follow_created_time"),
    remarkCorpName: varchar("remark_corp_name", { length: 128 }),
    remarkMobiles: text("remark_mobiles"),
    addWay: integer("add_way"),
    operUserid: varchar("oper_userid", { length: 64 }),
    state: varchar("state", { length: 128 }),
    lastEventId: integer("last_event_id").notNull(),
    lastEventKey: varchar("last_event_key", { length: 64 }).notNull(),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }).notNull(),
    lastEventTime: integer("last_event_time").notNull(),
    lastSequenceRank: integer("last_sequence_rank").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    deletedTime: integer("deleted_time"),
  },
  (table) => [
    primaryKey({
      name: "wcfc_pk",
      columns: [table.corpId, table.clientId, table.userid],
    }),
    foreignKey({
      name: "wcfc_client_fk",
      columns: [table.corpId, table.clientId],
      foreignColumns: [workClientCurrent.corpId, workClientCurrent.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "wcfc_last_event_fk",
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
    check("wcfc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wcfc_userid_ck",
      sql`${table.userid} <> ''
        AND ${table.userid} = btrim(${table.userid})
        AND ${table.userid} = lower(${table.userid})
        AND ${table.userid} ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$'
        AND ${table.userid} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wcfc_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('ACTIVE', 'DELETED')`,
    ),
    check(
      "wcfc_source_kind_ck",
      sql`${table.sourceKind} IN ('DIRECT', 'SNAPSHOT')`,
    ),
    check(
      "wcfc_values_ck",
      sql`${table.clientId} > 0
        AND (${table.followCreatedTime} IS NULL OR ${table.followCreatedTime} >= 0)
        AND (${table.addWay} IS NULL OR ${table.addWay} BETWEEN 0 AND 1000)
        AND (${table.remark} IS NULL OR ${table.remark} !~ '[[:cntrl:]]')
        AND (${table.description} IS NULL OR ${table.description} !~ '[[:cntrl:]]')
        AND (${table.remarkCorpName} IS NULL OR ${table.remarkCorpName} !~ '[[:cntrl:]]')
        AND (${table.remarkMobiles} IS NULL OR (
          octet_length(${table.remarkMobiles}) <= 2048
          AND jsonb_typeof(${table.remarkMobiles}::jsonb) = 'array'
        ))
        AND (${table.operUserid} IS NULL OR (
          ${table.operUserid} = lower(${table.operUserid})
          AND ${table.operUserid} ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$'
        ))
        AND (${table.state} IS NULL OR ${table.state} !~ '[[:cntrl:]]')`,
    ),
    check(
      "wcfc_event_fence_ck",
      sql`${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0
        AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wcfc_snapshot_ck",
      sql`(
          ${table.lifecycleState} = 'ACTIVE'
          AND ${table.profileComplete} = true
          AND ${table.tagsComplete} = true
          AND ${table.followCreatedTime} IS NOT NULL
          AND ${table.remarkMobiles} IS NOT NULL
          AND ${table.deletedTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'DELETED'
          AND ${table.sourceKind} = 'DIRECT'
          AND ${table.tagsComplete} = false
          AND ${table.deletedTime} IS NOT NULL
        )`,
    ),
    check(
      "wcfc_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0
        AND (${table.deletedTime} IS NULL OR ${table.deletedTime} > 0)`,
    ),
    index("wcfc_active_user_idx")
      .on(table.corpId, table.userid, table.clientId)
      .where(sql`${table.lifecycleState} = 'ACTIVE'`),
    index("wcfc_last_event_idx").on(table.lastEventId),
  ],
);

/**
 * Relationship-scoped latest-seen callback fence.
 *
 * A client profile snapshot can refresh several ACTIVE follows, but it must
 * never replace the direct add/edit/delete authority for another employee.
 * Keeping this fence separate also lets a delete for employee A apply even
 * when employee B has a newer client-profile event.
 */
export const workClientFollowProjectionFence = pgTable(
  "work_client_follow_projection_fence",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    clientId: integer("client_id").notNull(),
    userid: varchar("userid", { length: 64 }).notNull(),
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
      name: "wcfpf_pk",
      columns: [table.corpId, table.clientId, table.userid],
    }),
    foreignKey({
      name: "wcfpf_client_fk",
      columns: [table.corpId, table.clientId],
      foreignColumns: [workClientCurrent.corpId, workClientCurrent.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "wcfpf_last_event_fk",
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
    check("wcfpf_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wcfpf_userid_ck",
      sql`${table.userid} <> ''
        AND ${table.userid} = btrim(${table.userid})
        AND ${table.userid} = lower(${table.userid})
        AND ${table.userid} ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$'`,
    ),
    check(
      "wcfpf_event_fence_ck",
      sql`${table.clientId} > 0
        AND ${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0
        AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wcfpf_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
    index("wcfpf_last_event_idx").on(table.lastEventId),
  ],
);

export const workClientFollowTagCurrent = pgTable(
  "work_client_follow_tag_current",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    clientId: integer("client_id").notNull(),
    userid: varchar("userid", { length: 64 }).notNull(),
    // Some personal tags (provider type=2) have no stable tag_id. The key is
    // SHA-256 over the canonical type/id/group/name tuple, never a local ID.
    tagKeyHash: varchar("tag_key_hash", { length: 64 }).notNull(),
    tagId: varchar("tag_id", { length: 128 }),
    groupName: varchar("group_name", { length: 256 }),
    tagName: varchar("tag_name", { length: 256 }).notNull(),
    type: smallint("type").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      name: "wcftc_pk",
      columns: [table.corpId, table.clientId, table.userid, table.tagKeyHash],
    }),
    foreignKey({
      name: "wcftc_follow_fk",
      columns: [table.corpId, table.clientId, table.userid],
      foreignColumns: [
        workClientFollowCurrent.corpId,
        workClientFollowCurrent.clientId,
        workClientFollowCurrent.userid,
      ],
    }).onDelete("restrict"),
    check("wcftc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wcftc_userid_ck",
      sql`${table.userid} <> ''
        AND ${table.userid} = btrim(${table.userid})
        AND ${table.userid} = lower(${table.userid})
        AND ${table.userid} ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$'`,
    ),
    check(
      "wcftc_values_ck",
      sql`${table.clientId} > 0
        AND ${table.tagKeyHash} ~ '^[0-9a-f]{64}$'
        AND (${table.tagId} IS NULL OR (
          ${table.tagId} <> '' AND ${table.tagId} = btrim(${table.tagId})
          AND ${table.tagId} !~ '[[:cntrl:]]'
        ))
        AND (${table.groupName} IS NULL OR ${table.groupName} !~ '[[:cntrl:]]')
        AND ${table.tagName} <> '' AND ${table.tagName} = btrim(${table.tagName})
        AND ${table.tagName} !~ '[[:cntrl:]]'
        AND ${table.type} BETWEEN 1 AND 3
        AND ${table.sortOrder} BETWEEN 0 AND 255
        AND ${table.createTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
    uniqueIndex("wcftc_position_uq").on(
      table.corpId,
      table.clientId,
      table.userid,
      table.sortOrder,
    ),
  ],
);

export type WorkClientCurrent = typeof workClientCurrent.$inferSelect;
export type NewWorkClientCurrent = typeof workClientCurrent.$inferInsert;
export type WorkClientProjectionFence = typeof workClientProjectionFence.$inferSelect;
export type NewWorkClientProjectionFence = typeof workClientProjectionFence.$inferInsert;
export type WorkClientFollowCurrent = typeof workClientFollowCurrent.$inferSelect;
export type NewWorkClientFollowCurrent = typeof workClientFollowCurrent.$inferInsert;
export type WorkClientFollowProjectionFence =
  typeof workClientFollowProjectionFence.$inferSelect;
export type NewWorkClientFollowProjectionFence =
  typeof workClientFollowProjectionFence.$inferInsert;
export type WorkClientFollowTagCurrent = typeof workClientFollowTagCurrent.$inferSelect;
export type NewWorkClientFollowTagCurrent = typeof workClientFollowTagCurrent.$inferInsert;
