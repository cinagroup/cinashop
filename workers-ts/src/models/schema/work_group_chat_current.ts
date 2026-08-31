/**
 * Canonical Enterprise WeChat external group-chat projection.
 *
 * Legacy work_group_chat/work_group_chat_member rows remain immutable import
 * evidence. One group-wide latest-seen fence is sufficient because the
 * provider detail response is a complete snapshot of the group and members.
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
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { workCallbackEvent } from "./work_callback";

export const WORK_GROUP_CHAT_CURRENT_STATES = [
  "UNRESOLVED",
  "ACTIVE",
  "DISMISSED",
] as const;
export type WorkGroupChatCurrentState =
  (typeof WORK_GROUP_CHAT_CURRENT_STATES)[number];

export const WORK_GROUP_CHAT_MEMBER_CURRENT_STATES = [
  "ACTIVE",
  "LEFT",
  "DISMISSED",
] as const;
export type WorkGroupChatMemberCurrentState =
  (typeof WORK_GROUP_CHAT_MEMBER_CURRENT_STATES)[number];

export const workGroupChatCurrent = pgTable(
  "work_group_chat_current",
  {
    id: integer("id").generatedAlwaysAsIdentity(),
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    chatId: varchar("chat_id", { length: 64 }).notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkGroupChatCurrentState>()
      .default("UNRESOLVED")
      .notNull(),
    profileComplete: boolean("profile_complete").default(false).notNull(),
    membersComplete: boolean("members_complete").default(false).notNull(),
    name: varchar("name", { length: 255 }),
    owner: varchar("owner", { length: 64 }),
    groupCreatedTime: integer("group_created_time"),
    notice: varchar("notice", { length: 2048 }),
    adminList: jsonb("admin_list").$type<string[]>(),
    providerStatus: smallint("provider_status"),
    memberCount: integer("member_count"),
    // Count only evidence-backed ACTIVE -> LEFT transitions. A dismiss does
    // not fabricate individual departures, and a later rejoin does not erase
    // the historical departure count.
    departedMemberCount: integer("departed_member_count").default(0).notNull(),
    lastEventId: integer("last_event_id"),
    lastEventKey: varchar("last_event_key", { length: 64 }),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }),
    lastEventTime: integer("last_event_time").default(0).notNull(),
    lastSequenceRank: integer("last_sequence_rank").default(0).notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    dismissedTime: integer("dismissed_time"),
  },
  (table) => [
    primaryKey({ name: "wgcc_pk", columns: [table.corpId, table.id] }),
    foreignKey({
      name: "wgcc_last_event_fk",
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
    check("wgcc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wgcc_chat_id_ck",
      sql`${table.chatId} <> ''
        AND ${table.chatId} = btrim(${table.chatId})
        AND octet_length(${table.chatId}) <= 64
        AND ${table.chatId} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wgcc_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('UNRESOLVED', 'ACTIVE', 'DISMISSED')`,
    ),
    check(
      "wgcc_values_ck",
      sql`${table.id} > 0
        AND (${table.name} IS NULL OR ${table.name} !~ '[[:cntrl:]]')
        AND (${table.owner} IS NULL OR (
          ${table.owner} = lower(${table.owner})
          AND ${table.owner} ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$'
        ))
        AND (${table.groupCreatedTime} IS NULL OR ${table.groupCreatedTime} >= 0)
        AND (${table.notice} IS NULL OR translate(${table.notice}, E'\\t\\r\\n', '') !~ '[[:cntrl:]]')
        AND (${table.adminList} IS NULL OR (
          jsonb_typeof(${table.adminList}) = 'array'
          AND octet_length(${table.adminList}::text) <= 8192
        ))
        AND (${table.providerStatus} IS NULL OR ${table.providerStatus} BETWEEN 0 AND 255)
        AND (${table.memberCount} IS NULL OR ${table.memberCount} BETWEEN 0 AND 2000)
        AND ${table.departedMemberCount} >= 0`,
    ),
    check(
      "wgcc_event_fence_ck",
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
      "wgcc_snapshot_ck",
      sql`(
          ${table.lifecycleState} = 'UNRESOLVED'
          AND ${table.profileComplete} = false
          AND ${table.membersComplete} = false
          AND ${table.name} IS NULL
          AND ${table.owner} IS NULL
          AND ${table.groupCreatedTime} IS NULL
          AND ${table.notice} IS NULL
          AND ${table.adminList} IS NULL
          AND ${table.providerStatus} IS NULL
          AND ${table.memberCount} IS NULL
          AND ${table.lastEventId} IS NULL
          AND ${table.dismissedTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'ACTIVE'
          AND ${table.profileComplete} = true
          AND ${table.membersComplete} = true
          AND ${table.name} IS NOT NULL
          AND ${table.owner} IS NOT NULL
          AND ${table.groupCreatedTime} IS NOT NULL
          AND ${table.notice} IS NOT NULL
          AND ${table.adminList} IS NOT NULL
          AND ${table.providerStatus} IS NOT NULL
          AND ${table.memberCount} IS NOT NULL
          AND ${table.lastEventId} IS NOT NULL
          AND ${table.dismissedTime} IS NULL
        ) OR (
          ${table.lifecycleState} = 'DISMISSED'
          AND ${table.profileComplete} = false
          AND ${table.membersComplete} = false
          AND ${table.lastEventId} IS NOT NULL
          AND ${table.dismissedTime} IS NOT NULL
        )`,
    ),
    check(
      "wgcc_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0
        AND (${table.dismissedTime} IS NULL OR ${table.dismissedTime} > 0)`,
    ),
    uniqueIndex("wgcc_corp_chat_id_uq").on(table.corpId, table.chatId),
    index("wgcc_catalog_idx").on(
      table.corpId,
      table.lifecycleState,
      table.updateTime.desc(),
      table.id,
    ),
    index("wgcc_last_event_idx")
      .on(table.lastEventId)
      .where(sql`${table.lastEventId} IS NOT NULL`),
  ],
);

export const workGroupChatProjectionFence = pgTable(
  "work_group_chat_projection_fence",
  {
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    chatId: varchar("chat_id", { length: 64 }).notNull(),
    lastEventId: integer("last_event_id").notNull(),
    lastEventKey: varchar("last_event_key", { length: 64 }).notNull(),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }).notNull(),
    lastEventTime: integer("last_event_time").notNull(),
    lastSequenceRank: integer("last_sequence_rank").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
  },
  (table) => [
    primaryKey({ name: "wgcpf_pk", columns: [table.corpId, table.chatId] }),
    foreignKey({
      name: "wgcpf_group_fk",
      columns: [table.corpId, table.chatId],
      foreignColumns: [workGroupChatCurrent.corpId, workGroupChatCurrent.chatId],
    }).onDelete("restrict"),
    foreignKey({
      name: "wgcpf_last_event_fk",
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
    check("wgcpf_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wgcpf_chat_id_ck",
      sql`${table.chatId} <> ''
        AND ${table.chatId} = btrim(${table.chatId})
        AND octet_length(${table.chatId}) <= 64
        AND ${table.chatId} !~ '[[:cntrl:]]'`,
    ),
    check(
      "wgcpf_event_fence_ck",
      sql`${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0
        AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wgcpf_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0`,
    ),
    index("wgcpf_last_event_idx").on(table.lastEventId),
  ],
);

export const workGroupChatMemberCurrent = pgTable(
  "work_group_chat_member_current",
  {
    id: integer("id").generatedAlwaysAsIdentity(),
    corpId: varchar("corp_id", { length: 18 }).notNull(),
    groupId: integer("group_id").notNull(),
    userid: varchar("userid", { length: 64 }).notNull(),
    lifecycleState: varchar("lifecycle_state", { length: 16 })
      .$type<WorkGroupChatMemberCurrentState>()
      .default("ACTIVE")
      .notNull(),
    type: smallint("type").notNull(),
    unionid: varchar("unionid", { length: 128 }),
    joinTime: integer("join_time").notNull(),
    joinScene: smallint("join_scene").notNull(),
    invitorUserid: varchar("invitor_userid", { length: 64 }),
    groupNickname: varchar("group_nickname", { length: 128 }).notNull(),
    name: varchar("name", { length: 128 }),
    state: varchar("state", { length: 128 }),
    lastEventId: integer("last_event_id").notNull(),
    lastEventKey: varchar("last_event_key", { length: 64 }).notNull(),
    lastEventSubjectKeyHash: varchar("last_event_subject_key_hash", { length: 64 }).notNull(),
    lastEventTime: integer("last_event_time").notNull(),
    lastSequenceRank: integer("last_sequence_rank").notNull(),
    createTime: integer("create_time").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    leftTime: integer("left_time"),
  },
  (table) => [
    primaryKey({
      name: "wgcmc_pk",
      columns: [table.corpId, table.id],
    }),
    foreignKey({
      name: "wgcmc_group_fk",
      columns: [table.corpId, table.groupId],
      foreignColumns: [workGroupChatCurrent.corpId, workGroupChatCurrent.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "wgcmc_last_event_fk",
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
    check("wgcmc_corp_id_ck", sql`${table.corpId} ~ '^[A-Za-z0-9_-]{1,18}$'`),
    check(
      "wgcmc_userid_ck",
      sql`${table.userid} <> ''
        AND ${table.userid} = btrim(${table.userid})
        AND ${table.userid} ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$'
        AND (${table.type} <> 1 OR ${table.userid} = lower(${table.userid}))`,
    ),
    check(
      "wgcmc_lifecycle_state_ck",
      sql`${table.lifecycleState} IN ('ACTIVE', 'LEFT', 'DISMISSED')`,
    ),
    check(
      "wgcmc_values_ck",
      sql`${table.id} > 0
        AND ${table.groupId} > 0
        AND ${table.type} IN (1, 2)
        AND (${table.unionid} IS NULL OR (
          ${table.unionid} <> '' AND ${table.unionid} = btrim(${table.unionid})
          AND ${table.unionid} !~ '[[:cntrl:]]'
        ))
        AND ${table.joinTime} >= 0
        AND ${table.joinScene} BETWEEN 0 AND 255
        AND (${table.invitorUserid} IS NULL OR (
          ${table.invitorUserid} = lower(${table.invitorUserid})
          AND ${table.invitorUserid} ~ '^[a-z0-9][a-z0-9_@.-]{0,63}$'
        ))
        AND ${table.groupNickname} !~ '[[:cntrl:]]'
        AND (${table.name} IS NULL OR ${table.name} !~ '[[:cntrl:]]')
        AND (${table.state} IS NULL OR ${table.state} !~ '[[:cntrl:]]')`,
    ),
    check(
      "wgcmc_event_fence_ck",
      sql`${table.lastEventId} > 0
        AND ${table.lastEventKey} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventSubjectKeyHash} ~ '^[0-9a-f]{64}$'
        AND ${table.lastEventTime} > 0
        AND ${table.lastSequenceRank} >= 0`,
    ),
    check(
      "wgcmc_snapshot_ck",
      sql`(
          ${table.lifecycleState} = 'ACTIVE'
          AND ${table.leftTime} IS NULL
        ) OR (
          ${table.lifecycleState} IN ('LEFT', 'DISMISSED')
          AND ${table.leftTime} IS NOT NULL
        )`,
    ),
    check(
      "wgcmc_time_ck",
      sql`${table.createTime} >= 0 AND ${table.updateTime} >= 0
        AND (${table.leftTime} IS NULL OR ${table.leftTime} > 0)`,
    ),
    index("wgcmc_active_user_idx")
      .on(table.corpId, table.userid, table.groupId)
      .where(sql`${table.lifecycleState} = 'ACTIVE'`),
    index("wgcmc_group_state_idx").on(
      table.corpId,
      table.groupId,
      table.lifecycleState,
      table.joinTime.desc(),
      table.userid,
    ),
    index("wgcmc_last_event_idx").on(table.lastEventId),
    uniqueIndex("wgcmc_group_userid_uq").on(
      table.corpId,
      table.groupId,
      table.userid,
    ),
  ],
);

export type WorkGroupChatCurrent = typeof workGroupChatCurrent.$inferSelect;
export type NewWorkGroupChatCurrent = typeof workGroupChatCurrent.$inferInsert;
export type WorkGroupChatProjectionFence =
  typeof workGroupChatProjectionFence.$inferSelect;
export type NewWorkGroupChatProjectionFence =
  typeof workGroupChatProjectionFence.$inferInsert;
export type WorkGroupChatMemberCurrent =
  typeof workGroupChatMemberCurrent.$inferSelect;
export type NewWorkGroupChatMemberCurrent =
  typeof workGroupChatMemberCurrent.$inferInsert;
