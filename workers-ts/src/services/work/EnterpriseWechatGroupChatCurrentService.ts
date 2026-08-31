import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  workGroupChatCurrent,
  workGroupChatMemberCurrent,
  workGroupChatProjectionFence,
  type WorkGroupChatCurrent,
  type WorkGroupChatMemberCurrent,
} from "@/models/schema";
import {
  EnterpriseWechatGroupChatProjectionError,
  groupChatProjectionIdentity,
  type EnterpriseWechatGroupChatMemberSnapshot,
  type EnterpriseWechatGroupChatSnapshot,
  type GroupChatProjectionClaim,
  type PreparedGroupChatProjection,
} from "@/services/work/EnterpriseWechatGroupChatProjection";

export type GroupChatProjectionApplyResult =
  | "applied"
  | "applied-noop"
  | "refresh-required"
  | "superseded";

interface ProjectionFence {
  eventTime: number;
  sequenceRank: number;
  eventId: number;
}

const MEMBER_WRITE_BATCH = 200;

function projectionError(code: string, terminal = true): never {
  throw new EnterpriseWechatGroupChatProjectionError(code, terminal);
}

function incomingFence(claim: GroupChatProjectionClaim): ProjectionFence {
  return {
    eventTime: claim.eventTime,
    sequenceRank: claim.sequenceRank,
    eventId: claim.eventId,
  };
}

function rowFence(row: {
  lastEventId: number | null;
  lastEventTime: number;
  lastSequenceRank: number;
}): ProjectionFence {
  return {
    eventTime: row.lastEventTime,
    sequenceRank: row.lastSequenceRank,
    eventId: row.lastEventId ?? 0,
  };
}

/** A dismiss is terminal and dominates every non-dismiss event, even if an
 * inconsistent provider callback carries a later wall-clock timestamp. */
export function compareGroupChatProjectionFence(
  left: ProjectionFence,
  right: ProjectionFence,
): number {
  const leftTerminal = left.sequenceRank >= 100 ? 1 : 0;
  const rightTerminal = right.sequenceRank >= 100 ? 1 : 0;
  if (leftTerminal !== rightTerminal) return leftTerminal - rightTerminal;
  if (left.eventTime !== right.eventTime) return left.eventTime - right.eventTime;
  if (left.sequenceRank !== right.sequenceRank) return left.sequenceRank - right.sequenceRank;
  return left.eventId - right.eventId;
}

function exactFence(
  row: {
    lastEventId: number | null;
    lastEventKey: string | null;
    lastEventSubjectKeyHash: string | null;
    lastEventTime: number;
    lastSequenceRank: number;
  },
  claim: GroupChatProjectionClaim,
): boolean {
  return row.lastEventId === claim.eventId
    && row.lastEventKey === claim.eventKey
    && row.lastEventSubjectKeyHash === claim.subjectKeyHash
    && row.lastEventTime === claim.eventTime
    && row.lastSequenceRank === claim.sequenceRank;
}

function appliedEvent(claim: GroupChatProjectionClaim) {
  return {
    lastEventId: claim.eventId,
    lastEventKey: claim.eventKey,
    lastEventSubjectKeyHash: claim.subjectKeyHash,
    lastEventTime: claim.eventTime,
    lastSequenceRank: claim.sequenceRank,
  };
}

function chunks<T>(values: T[], size = MEMBER_WRITE_BATCH): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

export async function lockGroupChatProjectionIdentity(
  tx: DbClient,
  corpId: string,
  chatId: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`work-group-chat:${corpId}:${chatId}`}, 0)
  )`);
}

async function ensureGroupChatIdentity(
  tx: DbClient,
  claim: GroupChatProjectionClaim,
  chatId: string,
  now: number,
): Promise<number> {
  await tx.insert(workGroupChatCurrent).values({
    corpId: claim.corpId,
    chatId,
    lifecycleState: "UNRESOLVED",
    profileComplete: false,
    membersComplete: false,
    createTime: now,
    updateTime: now,
  }).onConflictDoNothing();
  const rows = await tx.select({ id: workGroupChatCurrent.id })
    .from(workGroupChatCurrent)
    .where(and(
      eq(workGroupChatCurrent.corpId, claim.corpId),
      eq(workGroupChatCurrent.chatId, chatId),
    ))
    .limit(1)
    .for("update");
  if (!rows[0]?.id) projectionError("callback_group_chat_identity_missing");
  return rows[0].id;
}

/** Phase 1: persist latest-seen ordering before provider I/O. */
export async function recordGroupChatProjectionSeen(
  tx: DbClient,
  claim: GroupChatProjectionClaim,
  now: number,
): Promise<"ready" | "superseded"> {
  const chatId = groupChatProjectionIdentity(claim);
  await lockGroupChatProjectionIdentity(tx, claim.corpId, chatId);
  const groupId = await ensureGroupChatIdentity(tx, claim, chatId, now);
  const current = (await tx.select().from(workGroupChatCurrent).where(and(
    eq(workGroupChatCurrent.corpId, claim.corpId),
    eq(workGroupChatCurrent.id, groupId),
  )).limit(1).for("update"))[0];
  if (!current) projectionError("callback_group_chat_current_missing");
  if (current.lifecycleState === "DISMISSED" && claim.changeType !== "dismiss") {
    return "superseded";
  }

  const stored = (await tx.select().from(workGroupChatProjectionFence).where(and(
    eq(workGroupChatProjectionFence.corpId, claim.corpId),
    eq(workGroupChatProjectionFence.chatId, chatId),
  )).limit(1).for("update"))[0];
  if (stored) {
    const comparison = compareGroupChatProjectionFence(rowFence(stored), incomingFence(claim));
    if (comparison > 0) return "superseded";
    if (comparison === 0) {
      if (!exactFence(stored, claim)) {
        projectionError("callback_group_chat_seen_fence_conflict");
      }
      return "ready";
    }
    const updated = await tx.update(workGroupChatProjectionFence).set({
      ...appliedEvent(claim),
      updateTime: now,
    }).where(and(
      eq(workGroupChatProjectionFence.corpId, claim.corpId),
      eq(workGroupChatProjectionFence.chatId, chatId),
      eq(workGroupChatProjectionFence.lastEventId, stored.lastEventId),
    )).returning({ chatId: workGroupChatProjectionFence.chatId });
    if (updated.length !== 1) projectionError("callback_group_chat_seen_fence_lost");
    return "ready";
  }

  const inserted = await tx.insert(workGroupChatProjectionFence).values({
    corpId: claim.corpId,
    chatId,
    ...appliedEvent(claim),
    createTime: now,
    updateTime: now,
  }).onConflictDoNothing().returning({ chatId: workGroupChatProjectionFence.chatId });
  if (inserted.length !== 1) projectionError("callback_group_chat_seen_fence_conflict");
  return "ready";
}

function arraysEqual(left: string[] | null, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function memberBusinessEquals(
  current: WorkGroupChatMemberCurrent,
  snapshot: EnterpriseWechatGroupChatMemberSnapshot,
): boolean {
  return current.lifecycleState === "ACTIVE"
    && current.type === snapshot.type
    && current.unionid === snapshot.unionid
    && current.joinTime === snapshot.joinTime
    && current.joinScene === snapshot.joinScene
    && current.invitorUserid === snapshot.invitorUserid
    && current.groupNickname === snapshot.groupNickname
    && current.name === snapshot.name
    && current.state === snapshot.state;
}

function snapshotBusinessEquals(
  current: WorkGroupChatCurrent,
  snapshot: EnterpriseWechatGroupChatSnapshot,
  members: WorkGroupChatMemberCurrent[],
): boolean {
  if (
    current.lifecycleState !== "ACTIVE"
    || !current.profileComplete
    || !current.membersComplete
    || current.name !== snapshot.name
    || current.owner !== snapshot.owner
    || current.groupCreatedTime !== snapshot.groupCreatedTime
    || current.notice !== snapshot.notice
    || !arraysEqual(current.adminList, snapshot.adminList)
    || current.providerStatus !== snapshot.providerStatus
    || current.memberCount !== snapshot.members.length
  ) return false;
  const active = members.filter((member) => member.lifecycleState === "ACTIVE");
  if (active.length !== snapshot.members.length) return false;
  const byUserid = new Map(active.map((member) => [member.userid, member]));
  return snapshot.members.every((member) => {
    const stored = byUserid.get(member.userid);
    return Boolean(stored && memberBusinessEquals(stored, member));
  });
}

async function upsertActiveMembers(
  tx: DbClient,
  claim: GroupChatProjectionClaim,
  groupId: number,
  members: EnterpriseWechatGroupChatMemberSnapshot[],
  now: number,
): Promise<void> {
  const event = appliedEvent(claim);
  const values = members.map((member) => ({
    corpId: claim.corpId,
    groupId,
    userid: member.userid,
    lifecycleState: "ACTIVE" as const,
    type: member.type,
    unionid: member.unionid,
    joinTime: member.joinTime,
    joinScene: member.joinScene,
    invitorUserid: member.invitorUserid,
    groupNickname: member.groupNickname,
    name: member.name,
    state: member.state,
    ...event,
    createTime: now,
    updateTime: now,
    leftTime: null,
  }));
  for (const batch of chunks(values)) {
    const rows = await tx.insert(workGroupChatMemberCurrent).values(batch)
      .onConflictDoUpdate({
        target: [
          workGroupChatMemberCurrent.corpId,
          workGroupChatMemberCurrent.groupId,
          workGroupChatMemberCurrent.userid,
        ],
        set: {
          lifecycleState: "ACTIVE",
          type: sql`excluded.type`,
          unionid: sql`excluded.unionid`,
          joinTime: sql`excluded.join_time`,
          joinScene: sql`excluded.join_scene`,
          invitorUserid: sql`excluded.invitor_userid`,
          groupNickname: sql`excluded.group_nickname`,
          name: sql`excluded.name`,
          state: sql`excluded.state`,
          lastEventId: claim.eventId,
          lastEventKey: claim.eventKey,
          lastEventSubjectKeyHash: claim.subjectKeyHash,
          lastEventTime: claim.eventTime,
          lastSequenceRank: claim.sequenceRank,
          updateTime: now,
          leftTime: null,
        },
      }).returning({ userid: workGroupChatMemberCurrent.userid });
    if (rows.length !== batch.length) projectionError("callback_group_chat_member_upsert_lost");
  }
}

async function applyGroupChatSnapshot(
  tx: DbClient,
  claim: GroupChatProjectionClaim,
  current: WorkGroupChatCurrent,
  snapshot: EnterpriseWechatGroupChatSnapshot,
  now: number,
): Promise<GroupChatProjectionApplyResult> {
  if (current.lifecycleState === "DISMISSED") return "superseded";
  const comparison = compareGroupChatProjectionFence(rowFence(current), incomingFence(claim));
  if (comparison > 0) projectionError("callback_group_chat_current_ahead_of_seen_fence");
  if (comparison === 0 && !exactFence(current, claim)) {
    projectionError("callback_group_chat_current_fence_conflict");
  }

  const existing = await tx.select().from(workGroupChatMemberCurrent).where(and(
    eq(workGroupChatMemberCurrent.corpId, claim.corpId),
    eq(workGroupChatMemberCurrent.groupId, current.id),
  )).orderBy(asc(workGroupChatMemberCurrent.userid)).for("update");
  const businessUnchanged = snapshotBusinessEquals(current, snapshot, existing);
  const incomingIds = new Set(snapshot.members.map((member) => member.userid));
  const departed = existing.filter(
    (member) => member.lifecycleState === "ACTIVE" && !incomingIds.has(member.userid),
  );
  const nextDepartedCount = current.departedMemberCount + departed.length;
  if (!Number.isSafeInteger(nextDepartedCount) || nextDepartedCount > 2_147_483_647) {
    projectionError("callback_group_chat_departed_count_overflow");
  }

  for (const batch of chunks(departed.map((member) => member.userid))) {
    const rows = await tx.update(workGroupChatMemberCurrent).set({
      lifecycleState: "LEFT",
      ...appliedEvent(claim),
      updateTime: now,
      leftTime: now,
    }).where(and(
      eq(workGroupChatMemberCurrent.corpId, claim.corpId),
      eq(workGroupChatMemberCurrent.groupId, current.id),
      eq(workGroupChatMemberCurrent.lifecycleState, "ACTIVE"),
      inArray(workGroupChatMemberCurrent.userid, batch),
    )).returning({ userid: workGroupChatMemberCurrent.userid });
    if (rows.length !== batch.length) projectionError("callback_group_chat_member_leave_lost");
  }

  await upsertActiveMembers(tx, claim, current.id, snapshot.members, now);
  const activeRows = await tx.select({ userid: workGroupChatMemberCurrent.userid })
    .from(workGroupChatMemberCurrent)
    .where(and(
      eq(workGroupChatMemberCurrent.corpId, claim.corpId),
      eq(workGroupChatMemberCurrent.groupId, current.id),
      eq(workGroupChatMemberCurrent.lifecycleState, "ACTIVE"),
    ));
  if (activeRows.length !== snapshot.members.length) {
    projectionError("callback_group_chat_member_count_mismatch");
  }

  const updated = await tx.update(workGroupChatCurrent).set({
    lifecycleState: "ACTIVE",
    profileComplete: true,
    membersComplete: true,
    name: snapshot.name,
    owner: snapshot.owner,
    groupCreatedTime: snapshot.groupCreatedTime,
    notice: snapshot.notice,
    adminList: snapshot.adminList,
    providerStatus: snapshot.providerStatus,
    memberCount: snapshot.members.length,
    departedMemberCount: nextDepartedCount,
    ...appliedEvent(claim),
    updateTime: now,
    dismissedTime: null,
  }).where(and(
    eq(workGroupChatCurrent.corpId, claim.corpId),
    eq(workGroupChatCurrent.id, current.id),
  )).returning({ id: workGroupChatCurrent.id });
  if (updated.length !== 1) projectionError("callback_group_chat_snapshot_update_lost");
  return businessUnchanged ? "applied-noop" : "applied";
}

async function applyGroupChatDismiss(
  tx: DbClient,
  claim: GroupChatProjectionClaim,
  current: WorkGroupChatCurrent,
  now: number,
): Promise<GroupChatProjectionApplyResult> {
  const comparison = compareGroupChatProjectionFence(rowFence(current), incomingFence(claim));
  if (comparison > 0) projectionError("callback_group_chat_current_ahead_of_seen_fence");
  if (comparison === 0 && !exactFence(current, claim)) {
    projectionError("callback_group_chat_current_fence_conflict");
  }
  const alreadyDismissed = current.lifecycleState === "DISMISSED";
  const active = await tx.select({ userid: workGroupChatMemberCurrent.userid })
    .from(workGroupChatMemberCurrent)
    .where(and(
      eq(workGroupChatMemberCurrent.corpId, claim.corpId),
      eq(workGroupChatMemberCurrent.groupId, current.id),
      eq(workGroupChatMemberCurrent.lifecycleState, "ACTIVE"),
    )).orderBy(asc(workGroupChatMemberCurrent.userid)).for("update");
  for (const batch of chunks(active.map((member) => member.userid))) {
    const rows = await tx.update(workGroupChatMemberCurrent).set({
      lifecycleState: "DISMISSED",
      ...appliedEvent(claim),
      updateTime: now,
      leftTime: now,
    }).where(and(
      eq(workGroupChatMemberCurrent.corpId, claim.corpId),
      eq(workGroupChatMemberCurrent.groupId, current.id),
      eq(workGroupChatMemberCurrent.lifecycleState, "ACTIVE"),
      inArray(workGroupChatMemberCurrent.userid, batch),
    )).returning({ userid: workGroupChatMemberCurrent.userid });
    if (rows.length !== batch.length) projectionError("callback_group_chat_member_dismiss_lost");
  }
  const updated = await tx.update(workGroupChatCurrent).set({
    lifecycleState: "DISMISSED",
    profileComplete: false,
    membersComplete: false,
    ...appliedEvent(claim),
    updateTime: now,
    dismissedTime: current.dismissedTime ?? now,
  }).where(and(
    eq(workGroupChatCurrent.corpId, claim.corpId),
    eq(workGroupChatCurrent.id, current.id),
  )).returning({ id: workGroupChatCurrent.id });
  if (updated.length !== 1) projectionError("callback_group_chat_dismiss_update_lost");
  return alreadyDismissed ? "applied-noop" : "applied";
}

/** Phase 3: recheck latest-seen and atomically apply the group snapshot. */
export async function applyGroupChatCurrentProjection(
  tx: DbClient,
  claim: GroupChatProjectionClaim,
  prepared: PreparedGroupChatProjection,
  now: number,
): Promise<GroupChatProjectionApplyResult> {
  const chatId = groupChatProjectionIdentity(claim);
  if (prepared.chatId !== chatId) {
    projectionError("callback_group_chat_projection_identity_mismatch");
  }
  await lockGroupChatProjectionIdentity(tx, claim.corpId, chatId);
  const latest = (await tx.select().from(workGroupChatProjectionFence).where(and(
    eq(workGroupChatProjectionFence.corpId, claim.corpId),
    eq(workGroupChatProjectionFence.chatId, chatId),
  )).limit(1).for("update"))[0];
  if (!latest) projectionError("callback_group_chat_seen_fence_missing");
  const comparison = compareGroupChatProjectionFence(rowFence(latest), incomingFence(claim));
  if (comparison > 0) return "superseded";
  if (comparison < 0 || !exactFence(latest, claim)) {
    projectionError("callback_group_chat_seen_fence_conflict");
  }
  if (prepared.kind === "not_found" || prepared.kind === "incomplete") {
    return "refresh-required";
  }

  const current = (await tx.select().from(workGroupChatCurrent).where(and(
    eq(workGroupChatCurrent.corpId, claim.corpId),
    eq(workGroupChatCurrent.chatId, chatId),
  )).limit(1).for("update"))[0];
  if (!current) projectionError("callback_group_chat_current_missing");
  if (prepared.kind === "snapshot" && prepared.snapshot.chatId !== chatId) {
    projectionError("callback_group_chat_snapshot_identity_mismatch");
  }
  return prepared.kind === "absent"
    ? applyGroupChatDismiss(tx, claim, current, now)
    : applyGroupChatSnapshot(tx, claim, current, prepared.snapshot, now);
}

export async function auditGroupChatProjectionRows(
  tx: DbClient,
  corpId: string,
  chatIds: string[],
) {
  const identities = [...new Set(chatIds)].sort();
  if (identities.length === 0) return { groups: [], fences: [], members: [] };
  const groups = await tx.select().from(workGroupChatCurrent).where(and(
    eq(workGroupChatCurrent.corpId, corpId),
    inArray(workGroupChatCurrent.chatId, identities),
  )).orderBy(asc(workGroupChatCurrent.chatId));
  const fences = await tx.select().from(workGroupChatProjectionFence).where(and(
    eq(workGroupChatProjectionFence.corpId, corpId),
    inArray(workGroupChatProjectionFence.chatId, identities),
  )).orderBy(asc(workGroupChatProjectionFence.chatId));
  const groupIds = groups.map((group) => group.id);
  const members = groupIds.length === 0
    ? []
    : await tx.select().from(workGroupChatMemberCurrent).where(and(
        eq(workGroupChatMemberCurrent.corpId, corpId),
        inArray(workGroupChatMemberCurrent.groupId, groupIds),
      )).orderBy(
        asc(workGroupChatMemberCurrent.groupId),
        asc(workGroupChatMemberCurrent.userid),
      );
  return { groups, fences, members };
}
