import {
  and,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  workExternalTagCurrent,
  workExternalTagGroupCurrent,
  workExternalTagProjectionFence,
  type WorkExternalTagCurrent,
  type WorkExternalTagGroupCurrent,
} from "@/models/schema";
import {
  EnterpriseWechatExternalTagProjectionError,
  externalTagProjectionIdentity,
  type EnterpriseWechatExternalTagGroupSnapshot,
  type EnterpriseWechatExternalTagSnapshot,
  type ExternalTagProjectionClaim,
  type ExternalTagProjectionIdentity,
  type PreparedExternalTagProjection,
} from "@/services/work/EnterpriseWechatExternalTagProjection";

export type ExternalTagProjectionApplyResult =
  | "applied"
  | "applied-noop"
  | "refresh-required"
  | "superseded";

interface ProjectionFence {
  eventTime: number;
  sequenceRank: number;
  eventId: number;
}

const WRITE_BATCH = 200;

function projectionError(code: string, terminal = true): never {
  throw new EnterpriseWechatExternalTagProjectionError(code, terminal);
}

function incomingFence(claim: ExternalTagProjectionClaim): ProjectionFence {
  return {
    eventTime: claim.eventTime,
    sequenceRank: claim.sequenceRank,
    eventId: claim.eventId,
  };
}

function rowFence(row: {
  lastEventId: number;
  lastEventTime: number;
  lastSequenceRank: number;
}): ProjectionFence {
  return {
    eventTime: row.lastEventTime,
    sequenceRank: row.lastSequenceRank,
    eventId: row.lastEventId,
  };
}

/** Deletes are terminal for immutable remote IDs and dominate later-looking updates. */
export function compareExternalTagProjectionFence(
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
    lastEventId: number;
    lastEventKey: string;
    lastEventSubjectKeyHash: string;
    lastEventTime: number;
    lastSequenceRank: number;
  },
  claim: ExternalTagProjectionClaim,
): boolean {
  return row.lastEventId === claim.eventId
    && row.lastEventKey === claim.eventKey
    && row.lastEventSubjectKeyHash === claim.subjectKeyHash
    && row.lastEventTime === claim.eventTime
    && row.lastSequenceRank === claim.sequenceRank;
}

function appliedEvent(claim: ExternalTagProjectionClaim) {
  return {
    lastEventId: claim.eventId,
    lastEventKey: claim.eventKey,
    lastEventSubjectKeyHash: claim.subjectKeyHash,
    lastEventTime: claim.eventTime,
    lastSequenceRank: claim.sequenceRank,
  };
}

function chunks<T>(values: T[], size = WRITE_BATCH): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function lockExternalTagProjectionCatalog(
  tx: DbClient,
  corpId: string,
  strategyId: number,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`work-external-tag:${corpId}:${strategyId}`}, 0)
  )`);
}

/** Phase 1: persist the direct callback fence before provider I/O. */
export async function recordExternalTagProjectionSeen(
  tx: DbClient,
  claim: ExternalTagProjectionClaim,
  now: number,
): Promise<"ready" | "superseded"> {
  const identity = externalTagProjectionIdentity(claim);
  await lockExternalTagProjectionCatalog(tx, claim.corpId, identity.strategyId);
  const stored = (await tx.select().from(workExternalTagProjectionFence).where(and(
    eq(workExternalTagProjectionFence.corpId, claim.corpId),
    eq(workExternalTagProjectionFence.strategyId, identity.strategyId),
    eq(workExternalTagProjectionFence.subjectType, identity.subjectType),
    eq(workExternalTagProjectionFence.remoteId, identity.remoteId),
  )).limit(1).for("update"))[0];
  if (stored) {
    const comparison = compareExternalTagProjectionFence(
      rowFence(stored),
      incomingFence(claim),
    );
    if (comparison > 0) return "superseded";
    if (comparison === 0) {
      if (!exactFence(stored, claim)) {
        projectionError("callback_external_tag_seen_fence_conflict");
      }
      return "ready";
    }
    const updated = await tx.update(workExternalTagProjectionFence).set({
      ...appliedEvent(claim),
      updateTime: now,
    }).where(and(
      eq(workExternalTagProjectionFence.corpId, claim.corpId),
      eq(workExternalTagProjectionFence.strategyId, identity.strategyId),
      eq(workExternalTagProjectionFence.subjectType, identity.subjectType),
      eq(workExternalTagProjectionFence.remoteId, identity.remoteId),
      eq(workExternalTagProjectionFence.lastEventId, stored.lastEventId),
    )).returning({ remoteId: workExternalTagProjectionFence.remoteId });
    if (updated.length !== 1) projectionError("callback_external_tag_seen_fence_lost");
    return "ready";
  }
  const inserted = await tx.insert(workExternalTagProjectionFence).values({
    corpId: claim.corpId,
    strategyId: identity.strategyId,
    subjectType: identity.subjectType,
    remoteId: identity.remoteId,
    ...appliedEvent(claim),
    createTime: now,
    updateTime: now,
  }).onConflictDoNothing().returning({ remoteId: workExternalTagProjectionFence.remoteId });
  if (inserted.length !== 1) projectionError("callback_external_tag_seen_fence_conflict");
  return "ready";
}

function groupBusinessEquals(
  row: WorkExternalTagGroupCurrent,
  snapshot: EnterpriseWechatExternalTagGroupSnapshot,
): boolean {
  const expectedState = snapshot.deleted ? "DELETED" : "ACTIVE";
  return row.lifecycleState === expectedState
    && row.snapshotComplete === !snapshot.deleted
    && row.groupName === snapshot.groupName
    && row.sortOrder === snapshot.sortOrder
    && row.providerCreateTime === snapshot.providerCreateTime
    && (snapshot.deleted ? row.deletedTime !== null : row.deletedTime === null);
}

function tagBusinessEquals(
  row: WorkExternalTagCurrent,
  group: EnterpriseWechatExternalTagGroupSnapshot,
  snapshot: EnterpriseWechatExternalTagSnapshot,
): boolean {
  const deleted = group.deleted || snapshot.deleted;
  return row.lifecycleState === (deleted ? "DELETED" : "ACTIVE")
    && row.snapshotComplete === !deleted
    && row.groupId === group.groupId
    && row.name === snapshot.name
    && row.sortOrder === snapshot.sortOrder
    && row.providerCreateTime === snapshot.providerCreateTime
    && (deleted ? row.deletedTime !== null : row.deletedTime === null);
}

function canApplyRow(
  row: { lastEventId: number; lastEventTime: number; lastSequenceRank: number },
  claim: ExternalTagProjectionClaim,
): boolean {
  return compareExternalTagProjectionFence(rowFence(row), incomingFence(claim)) <= 0;
}

async function loadCurrentCatalog(
  tx: DbClient,
  claim: ExternalTagProjectionClaim,
  strategyId: number,
): Promise<{
  groups: WorkExternalTagGroupCurrent[];
  tags: WorkExternalTagCurrent[];
}> {
  const groups = await tx.select().from(workExternalTagGroupCurrent).where(and(
    eq(workExternalTagGroupCurrent.corpId, claim.corpId),
    eq(workExternalTagGroupCurrent.strategyId, strategyId),
  )).for("update");
  const tags = await tx.select().from(workExternalTagCurrent).where(and(
    eq(workExternalTagCurrent.corpId, claim.corpId),
    eq(workExternalTagCurrent.strategyId, strategyId),
  )).for("update");
  return { groups, tags };
}

async function applyAbsent(
  tx: DbClient,
  claim: ExternalTagProjectionClaim,
  identity: ExternalTagProjectionIdentity,
  current: Awaited<ReturnType<typeof loadCurrentCatalog>>,
  now: number,
): Promise<ExternalTagProjectionApplyResult> {
  const event = appliedEvent(claim);
  const deletedTime = Math.max(1, claim.eventTime);
  if (identity.subjectType === "tag_group") {
    const group = current.groups.find((row) => row.groupId === identity.remoteId);
    if (group?.lifecycleState === "DELETED") return "applied-noop";
    if (group && !canApplyRow(group, claim)) return "superseded";
    if (group) {
      const updated = await tx.update(workExternalTagGroupCurrent).set({
        lifecycleState: "DELETED",
        snapshotComplete: false,
        ...event,
        updateTime: now,
        deletedTime,
      }).where(and(
        eq(workExternalTagGroupCurrent.corpId, claim.corpId),
        eq(workExternalTagGroupCurrent.strategyId, identity.strategyId),
        eq(workExternalTagGroupCurrent.groupId, identity.remoteId),
      )).returning({ groupId: workExternalTagGroupCurrent.groupId });
      if (updated.length !== 1) projectionError("callback_external_tag_group_delete_lost");
    } else {
      const inserted = await tx.insert(workExternalTagGroupCurrent).values({
        corpId: claim.corpId,
        strategyId: identity.strategyId,
        groupId: identity.remoteId,
        lifecycleState: "DELETED",
        snapshotComplete: false,
        ...event,
        createTime: now,
        updateTime: now,
        deletedTime,
      }).onConflictDoNothing().returning({ groupId: workExternalTagGroupCurrent.groupId });
      if (inserted.length !== 1) projectionError("callback_external_tag_group_delete_conflict");
    }
    const childIds = current.tags.filter((row) =>
      row.groupId === identity.remoteId
      && row.lifecycleState === "ACTIVE"
      && canApplyRow(row, claim)).map((row) => row.tagId);
    for (const batch of chunks(childIds)) {
      await tx.update(workExternalTagCurrent).set({
        lifecycleState: "DELETED",
        snapshotComplete: false,
        ...event,
        updateTime: now,
        deletedTime,
      }).where(and(
        eq(workExternalTagCurrent.corpId, claim.corpId),
        eq(workExternalTagCurrent.strategyId, identity.strategyId),
        inArray(workExternalTagCurrent.tagId, batch),
        eq(workExternalTagCurrent.lifecycleState, "ACTIVE"),
      ));
    }
    return "applied";
  }

  if (identity.subjectType !== "tag") {
    projectionError("callback_external_tag_delete_type_invalid");
  }
  const tag = current.tags.find((row) => row.tagId === identity.remoteId);
  if (tag?.lifecycleState === "DELETED") return "applied-noop";
  if (tag && !canApplyRow(tag, claim)) return "superseded";
  if (tag) {
    const updated = await tx.update(workExternalTagCurrent).set({
      lifecycleState: "DELETED",
      snapshotComplete: false,
      ...event,
      updateTime: now,
      deletedTime,
    }).where(and(
      eq(workExternalTagCurrent.corpId, claim.corpId),
      eq(workExternalTagCurrent.strategyId, identity.strategyId),
      eq(workExternalTagCurrent.tagId, identity.remoteId),
    )).returning({ tagId: workExternalTagCurrent.tagId });
    if (updated.length !== 1) projectionError("callback_external_tag_delete_lost");
  } else {
    const inserted = await tx.insert(workExternalTagCurrent).values({
      corpId: claim.corpId,
      strategyId: identity.strategyId,
      tagId: identity.remoteId,
      groupId: null,
      lifecycleState: "DELETED",
      snapshotComplete: false,
      ...event,
      createTime: now,
      updateTime: now,
      deletedTime,
    }).onConflictDoNothing().returning({ tagId: workExternalTagCurrent.tagId });
    if (inserted.length !== 1) projectionError("callback_external_tag_delete_conflict");
  }
  return "applied";
}

async function applySnapshot(
  tx: DbClient,
  claim: ExternalTagProjectionClaim,
  prepared: Extract<PreparedExternalTagProjection, { kind: "snapshot" }>,
  current: Awaited<ReturnType<typeof loadCurrentCatalog>>,
  now: number,
): Promise<ExternalTagProjectionApplyResult> {
  const { identity, snapshot } = prepared;
  const event = appliedEvent(claim);
  const deletedTime = Math.max(1, claim.eventTime);
  const groupById = new Map(current.groups.map((row) => [row.groupId, row]));
  const tagById = new Map(current.tags.map((row) => [row.tagId, row]));
  const targetGroup = identity.scope === "group"
    ? groupById.get(identity.remoteId)
    : identity.scope === "tag"
      ? groupById.get(snapshot.groups[0]?.groupId ?? "")
      : undefined;
  const targetTag = identity.scope === "tag" ? tagById.get(identity.remoteId) : undefined;
  if (
    targetGroup?.lifecycleState === "DELETED"
    || targetTag?.lifecycleState === "DELETED"
    || (targetGroup && !canApplyRow(targetGroup, claim))
    || (targetTag && !canApplyRow(targetTag, claim))
  ) return "superseded";

  let businessChanged = false;
  const groupValues: Array<typeof workExternalTagGroupCurrent.$inferInsert> = [];
  for (const group of snapshot.groups) {
    const stored = groupById.get(group.groupId);
    if (stored?.lifecycleState === "DELETED" || (stored && !canApplyRow(stored, claim))) {
      if (group.groupId === identity.remoteId && identity.scope === "group") return "superseded";
      continue;
    }
    if (!stored || !groupBusinessEquals(stored, group)) businessChanged = true;
    groupValues.push({
      corpId: claim.corpId,
      strategyId: identity.strategyId,
      groupId: group.groupId,
      lifecycleState: group.deleted ? "DELETED" : "ACTIVE",
      snapshotComplete: !group.deleted,
      groupName: group.groupName,
      sortOrder: group.sortOrder,
      providerCreateTime: group.providerCreateTime,
      ...event,
      createTime: stored?.createTime ?? now,
      updateTime: now,
      deletedTime: group.deleted ? (stored?.deletedTime ?? deletedTime) : null,
    });
  }
  for (const batch of chunks(groupValues)) {
    await tx.insert(workExternalTagGroupCurrent).values(batch).onConflictDoUpdate({
      target: [
        workExternalTagGroupCurrent.corpId,
        workExternalTagGroupCurrent.strategyId,
        workExternalTagGroupCurrent.groupId,
      ],
      set: {
        lifecycleState: sql`excluded.lifecycle_state`,
        snapshotComplete: sql`excluded.snapshot_complete`,
        groupName: sql`excluded.group_name`,
        sortOrder: sql`excluded.sort_order`,
        providerCreateTime: sql`excluded.provider_create_time`,
        lastEventId: sql`excluded.last_event_id`,
        lastEventKey: sql`excluded.last_event_key`,
        lastEventSubjectKeyHash: sql`excluded.last_event_subject_key_hash`,
        lastEventTime: sql`excluded.last_event_time`,
        lastSequenceRank: sql`excluded.last_sequence_rank`,
        updateTime: sql`excluded.update_time`,
        deletedTime: sql`excluded.deleted_time`,
      },
      setWhere: sql`${workExternalTagGroupCurrent.lifecycleState} <> 'DELETED'`,
    });
  }

  const tagValues: Array<typeof workExternalTagCurrent.$inferInsert> = [];
  const seenTagIds = new Set<string>();
  for (const group of snapshot.groups) {
    if (groupById.get(group.groupId)?.lifecycleState === "DELETED") continue;
    for (const tag of group.tags) {
      seenTagIds.add(tag.tagId);
      const stored = tagById.get(tag.tagId);
      if (stored?.lifecycleState === "DELETED" || (stored && !canApplyRow(stored, claim))) {
        if (tag.tagId === identity.remoteId && identity.scope === "tag") return "superseded";
        continue;
      }
      if (!stored || !tagBusinessEquals(stored, group, tag)) businessChanged = true;
      const deleted = group.deleted || tag.deleted;
      tagValues.push({
        corpId: claim.corpId,
        strategyId: identity.strategyId,
        tagId: tag.tagId,
        groupId: group.groupId,
        lifecycleState: deleted ? "DELETED" : "ACTIVE",
        snapshotComplete: !deleted,
        name: tag.name,
        sortOrder: tag.sortOrder,
        providerCreateTime: tag.providerCreateTime,
        ...event,
        createTime: stored?.createTime ?? now,
        updateTime: now,
        deletedTime: deleted ? (stored?.deletedTime ?? deletedTime) : null,
      });
    }
  }
  for (const batch of chunks(tagValues)) {
    await tx.insert(workExternalTagCurrent).values(batch).onConflictDoUpdate({
      target: [
        workExternalTagCurrent.corpId,
        workExternalTagCurrent.strategyId,
        workExternalTagCurrent.tagId,
      ],
      set: {
        groupId: sql`excluded.group_id`,
        lifecycleState: sql`excluded.lifecycle_state`,
        snapshotComplete: sql`excluded.snapshot_complete`,
        name: sql`excluded.name`,
        sortOrder: sql`excluded.sort_order`,
        providerCreateTime: sql`excluded.provider_create_time`,
        lastEventId: sql`excluded.last_event_id`,
        lastEventKey: sql`excluded.last_event_key`,
        lastEventSubjectKeyHash: sql`excluded.last_event_subject_key_hash`,
        lastEventTime: sql`excluded.last_event_time`,
        lastSequenceRank: sql`excluded.last_sequence_rank`,
        updateTime: sql`excluded.update_time`,
        deletedTime: sql`excluded.deleted_time`,
      },
      setWhere: sql`${workExternalTagCurrent.lifecycleState} <> 'DELETED'`,
    });
  }

  const seenGroupIds = new Set(snapshot.groups.map((group) => group.groupId));
  const omittedGroups = snapshot.scope === "catalog"
    ? current.groups.filter((row) =>
        row.lifecycleState === "ACTIVE"
        && !seenGroupIds.has(row.groupId)
        && canApplyRow(row, claim))
    : [];
  const omittedTags = current.tags.filter((row) =>
    row.lifecycleState === "ACTIVE"
    && canApplyRow(row, claim)
    && (
      snapshot.scope === "catalog"
        ? !seenTagIds.has(row.tagId)
        : snapshot.scope === "group"
          ? row.groupId === identity.remoteId && !seenTagIds.has(row.tagId)
          : false
    ));
  if (omittedGroups.length || omittedTags.length) businessChanged = true;

  for (const batch of chunks(omittedGroups.map((row) => row.groupId))) {
    await tx.update(workExternalTagGroupCurrent).set({
      lifecycleState: "DELETED",
      snapshotComplete: false,
      ...event,
      updateTime: now,
      deletedTime,
    }).where(and(
      eq(workExternalTagGroupCurrent.corpId, claim.corpId),
      eq(workExternalTagGroupCurrent.strategyId, identity.strategyId),
      inArray(workExternalTagGroupCurrent.groupId, batch),
      eq(workExternalTagGroupCurrent.lifecycleState, "ACTIVE"),
    ));
  }
  for (const batch of chunks(omittedTags.map((row) => row.tagId))) {
    await tx.update(workExternalTagCurrent).set({
      lifecycleState: "DELETED",
      snapshotComplete: false,
      ...event,
      updateTime: now,
      deletedTime,
    }).where(and(
      eq(workExternalTagCurrent.corpId, claim.corpId),
      eq(workExternalTagCurrent.strategyId, identity.strategyId),
      inArray(workExternalTagCurrent.tagId, batch),
      eq(workExternalTagCurrent.lifecycleState, "ACTIVE"),
    ));
  }

  return businessChanged ? "applied" : "applied-noop";
}

/** Phase 3: atomically apply one direct callback or scoped provider snapshot. */
export async function applyExternalTagCurrentProjection(
  tx: DbClient,
  claim: ExternalTagProjectionClaim,
  prepared: PreparedExternalTagProjection,
  now: number,
): Promise<ExternalTagProjectionApplyResult> {
  const identity = externalTagProjectionIdentity(claim);
  if (
    identity.strategyId !== prepared.identity.strategyId
    || identity.subjectType !== prepared.identity.subjectType
    || identity.remoteId !== prepared.identity.remoteId
    || identity.scope !== prepared.identity.scope
  ) projectionError("callback_external_tag_projection_identity_drift");

  await lockExternalTagProjectionCatalog(tx, claim.corpId, identity.strategyId);
  const fence = (await tx.select().from(workExternalTagProjectionFence).where(and(
    eq(workExternalTagProjectionFence.corpId, claim.corpId),
    eq(workExternalTagProjectionFence.strategyId, identity.strategyId),
    eq(workExternalTagProjectionFence.subjectType, identity.subjectType),
    eq(workExternalTagProjectionFence.remoteId, identity.remoteId),
  )).limit(1).for("update"))[0];
  if (!fence) projectionError("callback_external_tag_seen_fence_missing");
  if (!exactFence(fence, claim)) return "superseded";
  if (prepared.kind === "not_found" || prepared.kind === "incomplete") {
    return "refresh-required";
  }

  const current = await loadCurrentCatalog(tx, claim, identity.strategyId);
  if (prepared.kind === "absent") {
    return applyAbsent(tx, claim, identity, current, now);
  }
  return applySnapshot(tx, claim, prepared, current, now);
}
