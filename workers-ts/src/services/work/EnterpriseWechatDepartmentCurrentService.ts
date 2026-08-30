import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  workDepartmentCurrent,
  workDepartmentLeaderCurrent,
  workDepartmentProjectionFence,
  type WorkDepartmentCurrent,
} from "@/models/schema";
import {
  departmentProjectionIdentity,
  EnterpriseWechatDepartmentProjectionError,
  MAX_DEPARTMENT_ANCESTOR_DEPTH,
  type DepartmentProjectionClaim,
  type EnterpriseWechatDepartmentSnapshot,
  type PreparedDepartmentProjection,
} from "@/services/work/EnterpriseWechatDepartmentProjection";
import { compareMemberProjectionFence } from "@/services/work/EnterpriseWechatMemberCurrentService";

export type DepartmentProjectionApplyResult =
  | "applied"
  | "applied-noop"
  | "refresh-required"
  | "superseded";

interface ProjectionFence {
  eventTime: number;
  sequenceRank: number;
  eventId: number;
}

function projectionError(code: string, terminal = true): never {
  throw new EnterpriseWechatDepartmentProjectionError(code, terminal);
}

function incomingFence(claim: DepartmentProjectionClaim): ProjectionFence {
  return {
    eventTime: claim.eventTime,
    sequenceRank: claim.sequenceRank,
    eventId: claim.eventId,
  };
}

function currentFence(row: WorkDepartmentCurrent): ProjectionFence {
  return {
    eventTime: row.lastEventTime,
    sequenceRank: row.lastSequenceRank,
    eventId: row.lastEventId ?? 0,
  };
}

function exactCurrentFence(
  row: WorkDepartmentCurrent,
  claim: DepartmentProjectionClaim,
): boolean {
  return row.lastEventId === claim.eventId
    && row.lastEventKey === claim.eventKey
    && row.lastEventSubjectKeyHash === claim.subjectKeyHash
    && row.lastEventTime === claim.eventTime
    && row.lastSequenceRank === claim.sequenceRank;
}

function exactFence(
  row: {
    lastEventId: number;
    lastEventKey: string;
    lastEventSubjectKeyHash: string;
    lastEventTime: number;
    lastSequenceRank: number;
  },
  claim: DepartmentProjectionClaim,
): boolean {
  return row.lastEventId === claim.eventId
    && row.lastEventKey === claim.eventKey
    && row.lastEventSubjectKeyHash === claim.subjectKeyHash
    && row.lastEventTime === claim.eventTime
    && row.lastSequenceRank === claim.sequenceRank;
}

function appliedEvent(claim: DepartmentProjectionClaim) {
  return {
    lastEventId: claim.eventId,
    lastEventKey: claim.eventKey,
    lastEventSubjectKeyHash: claim.subjectKeyHash,
    lastEventTime: claim.eventTime,
    lastSequenceRank: claim.sequenceRank,
  };
}

export async function lockDepartmentProjectionCorp(
  tx: DbClient,
  corpId: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`work-department:${corpId}`}, 0)
  )`);
}

async function ensureDepartmentIdentity(
  tx: DbClient,
  claim: DepartmentProjectionClaim,
  departmentId: number,
  now: number,
): Promise<void> {
  await tx.insert(workDepartmentCurrent).values({
    corpId: claim.corpId,
    departmentId,
    lifecycleState: "UNRESOLVED",
    profileComplete: false,
    createTime: now,
    updateTime: now,
  }).onConflictDoNothing();
}

/**
 * Phase 1 latest-seen fence. It commits before provider I/O and is also used
 * while authority is disabled, without mutating an existing business snapshot.
 */
export async function recordDepartmentProjectionSeen(
  tx: DbClient,
  claim: DepartmentProjectionClaim,
  now: number,
): Promise<"ready" | "superseded"> {
  const departmentId = departmentProjectionIdentity(claim);
  await lockDepartmentProjectionCorp(tx, claim.corpId);
  await ensureDepartmentIdentity(tx, claim, departmentId, now);
  const rows = await tx.select().from(workDepartmentProjectionFence).where(and(
    eq(workDepartmentProjectionFence.corpId, claim.corpId),
    eq(workDepartmentProjectionFence.departmentId, departmentId),
  )).limit(1).for("update");
  const stored = rows[0];
  if (stored) {
    const comparison = compareMemberProjectionFence({
      eventTime: stored.lastEventTime,
      sequenceRank: stored.lastSequenceRank,
      eventId: stored.lastEventId,
    }, incomingFence(claim));
    if (comparison > 0) return "superseded";
    if (comparison === 0) {
      if (!exactFence(stored, claim)) projectionError("callback_department_seen_fence_conflict");
      return "ready";
    }
    const updated = await tx.update(workDepartmentProjectionFence).set({
      ...appliedEvent(claim),
      updateTime: now,
    }).where(and(
      eq(workDepartmentProjectionFence.corpId, claim.corpId),
      eq(workDepartmentProjectionFence.departmentId, departmentId),
      eq(workDepartmentProjectionFence.lastEventId, stored.lastEventId),
    )).returning({ departmentId: workDepartmentProjectionFence.departmentId });
    if (updated.length !== 1) projectionError("callback_department_seen_fence_lost");
    return "ready";
  }

  const inserted = await tx.insert(workDepartmentProjectionFence).values({
    corpId: claim.corpId,
    departmentId,
    ...appliedEvent(claim),
    createTime: now,
    updateTime: now,
  }).onConflictDoNothing().returning({
    departmentId: workDepartmentProjectionFence.departmentId,
  });
  if (inserted.length !== 1) projectionError("callback_department_seen_fence_conflict");
  return "ready";
}

function snapshotBusinessEquals(
  current: WorkDepartmentCurrent,
  snapshot: EnterpriseWechatDepartmentSnapshot,
  leaders: string[],
): boolean {
  return current.lifecycleState === "ACTIVE"
    && current.profileComplete
    && current.name === snapshot.name
    && current.nameEn === snapshot.nameEn
    && current.parentDepartmentId === snapshot.parentDepartmentId
    && current.sortOrder === snapshot.sortOrder
    && leaders.length === snapshot.leaders.length
    && leaders.every((userid, index) => userid === snapshot.leaders[index]);
}

async function validateProposedParent(
  tx: DbClient,
  departmentId: number,
  parentDepartmentId: number | null,
  claim: DepartmentProjectionClaim,
  now: number,
): Promise<"ready" | "superseded"> {
  if (parentDepartmentId === null) return "ready";
  let candidate: number | null = parentDepartmentId;
  const visited = new Set<number>([departmentId]);
  for (
    let depth = 0;
    candidate !== null && depth < MAX_DEPARTMENT_ANCESTOR_DEPTH;
    depth += 1
  ) {
    if (visited.has(candidate)) projectionError("callback_department_hierarchy_cycle");
    visited.add(candidate);
    let row: WorkDepartmentCurrent | undefined = (await tx.select().from(workDepartmentCurrent).where(and(
      eq(workDepartmentCurrent.corpId, claim.corpId),
      eq(workDepartmentCurrent.departmentId, candidate),
    )).limit(1).for("update"))[0];
    if (!row) {
      await ensureDepartmentIdentity(tx, claim, candidate, now);
      row = (await tx.select().from(workDepartmentCurrent).where(and(
        eq(workDepartmentCurrent.corpId, claim.corpId),
        eq(workDepartmentCurrent.departmentId, candidate),
      )).limit(1).for("update"))[0];
      if (!row) projectionError("callback_department_parent_placeholder_lost");
    }
    if (row.lifecycleState === "UNRESOLVED") return "ready";
    if (row.lifecycleState === "DELETED") {
      if (compareMemberProjectionFence(currentFence(row), incomingFence(claim)) > 0) {
        return "superseded";
      }
      // Preserve the explicit orphan until the parent's newer recreate event
      // or a full reconciliation arrives; never fabricate a parent snapshot.
      return "ready";
    }
    candidate = row.parentDepartmentId;
  }
  if (candidate !== null) projectionError("callback_department_hierarchy_depth");
  return "ready";
}

async function applyDepartmentSnapshot(
  tx: DbClient,
  claim: DepartmentProjectionClaim,
  current: WorkDepartmentCurrent,
  snapshot: EnterpriseWechatDepartmentSnapshot,
  now: number,
): Promise<DepartmentProjectionApplyResult> {
  const currentComparison = compareMemberProjectionFence(
    currentFence(current),
    incomingFence(claim),
  );
  if (currentComparison > 0) {
    projectionError("callback_department_current_ahead_of_seen_fence");
  }
  if (currentComparison === 0 && !exactCurrentFence(current, claim)) {
    projectionError("callback_department_current_fence_conflict");
  }
  if (
    await validateProposedParent(
      tx,
      snapshot.departmentId,
      snapshot.parentDepartmentId,
      claim,
      now,
    ) === "superseded"
  ) return "superseded";

  if (snapshot.parentDepartmentId === null) {
    const conflictingRoots = await tx.select({
      departmentId: workDepartmentCurrent.departmentId,
    }).from(workDepartmentCurrent).where(and(
      eq(workDepartmentCurrent.corpId, claim.corpId),
      eq(workDepartmentCurrent.lifecycleState, "ACTIVE"),
      sql`${workDepartmentCurrent.parentDepartmentId} IS NULL`,
      sql`${workDepartmentCurrent.departmentId} <> ${snapshot.departmentId}`,
    )).limit(1).for("update");
    if (conflictingRoots.length > 0) projectionError("callback_department_root_conflict");
  }

  const existingLeaders = await tx.select({
    userid: workDepartmentLeaderCurrent.userid,
  }).from(workDepartmentLeaderCurrent).where(and(
    eq(workDepartmentLeaderCurrent.corpId, claim.corpId),
    eq(workDepartmentLeaderCurrent.departmentId, snapshot.departmentId),
  )).orderBy(asc(workDepartmentLeaderCurrent.sortOrder)).for("update");
  const businessUnchanged = snapshotBusinessEquals(
    current,
    snapshot,
    existingLeaders.map((row) => row.userid),
  );

  const updated = await tx.update(workDepartmentCurrent).set({
    lifecycleState: "ACTIVE",
    profileComplete: true,
    name: snapshot.name,
    nameEn: snapshot.nameEn,
    parentDepartmentId: snapshot.parentDepartmentId,
    sortOrder: snapshot.sortOrder,
    ...appliedEvent(claim),
    updateTime: now,
    deletedTime: null,
  }).where(and(
    eq(workDepartmentCurrent.corpId, claim.corpId),
    eq(workDepartmentCurrent.departmentId, snapshot.departmentId),
  )).returning({ departmentId: workDepartmentCurrent.departmentId });
  if (updated.length !== 1) projectionError("callback_department_snapshot_update_lost");

  await tx.delete(workDepartmentLeaderCurrent).where(and(
    eq(workDepartmentLeaderCurrent.corpId, claim.corpId),
    eq(workDepartmentLeaderCurrent.departmentId, snapshot.departmentId),
  ));
  if (snapshot.leaders.length > 0) {
    const inserted = await tx.insert(workDepartmentLeaderCurrent).values(
      snapshot.leaders.map((userid, sortOrder) => ({
        corpId: claim.corpId,
        departmentId: snapshot.departmentId,
        userid,
        sortOrder,
        createTime: now,
        updateTime: now,
      })),
    ).returning({ userid: workDepartmentLeaderCurrent.userid });
    if (inserted.length !== snapshot.leaders.length) {
      projectionError("callback_department_leader_replace_lost");
    }
  }
  return businessUnchanged ? "applied-noop" : "applied";
}

async function applyDepartmentDelete(
  tx: DbClient,
  claim: DepartmentProjectionClaim,
  current: WorkDepartmentCurrent,
  departmentId: number,
  now: number,
): Promise<DepartmentProjectionApplyResult> {
  const currentComparison = compareMemberProjectionFence(
    currentFence(current),
    incomingFence(claim),
  );
  if (currentComparison > 0) {
    projectionError("callback_department_current_ahead_of_seen_fence");
  }
  if (currentComparison === 0 && !exactCurrentFence(current, claim)) {
    projectionError("callback_department_current_fence_conflict");
  }

  const alreadyDeleted = current.lifecycleState === "DELETED";
  await tx.delete(workDepartmentLeaderCurrent).where(and(
    eq(workDepartmentLeaderCurrent.corpId, claim.corpId),
    eq(workDepartmentLeaderCurrent.departmentId, departmentId),
  ));
  const updated = await tx.update(workDepartmentCurrent).set({
    lifecycleState: "DELETED",
    profileComplete: false,
    ...appliedEvent(claim),
    updateTime: now,
    deletedTime: current.deletedTime ?? now,
  }).where(and(
    eq(workDepartmentCurrent.corpId, claim.corpId),
    eq(workDepartmentCurrent.departmentId, departmentId),
  )).returning({ departmentId: workDepartmentCurrent.departmentId });
  if (updated.length !== 1) projectionError("callback_department_delete_update_lost");
  return alreadyDeleted ? "applied-noop" : "applied";
}

/** Phase 3: recheck latest-seen and atomically apply the complete snapshot. */
export async function applyDepartmentCurrentProjection(
  tx: DbClient,
  claim: DepartmentProjectionClaim,
  prepared: PreparedDepartmentProjection,
  now: number,
): Promise<DepartmentProjectionApplyResult> {
  const departmentId = departmentProjectionIdentity(claim);
  if (prepared.departmentId !== departmentId) {
    projectionError("callback_department_projection_identity_mismatch");
  }
  await lockDepartmentProjectionCorp(tx, claim.corpId);
  const fences = await tx.select().from(workDepartmentProjectionFence).where(and(
    eq(workDepartmentProjectionFence.corpId, claim.corpId),
    eq(workDepartmentProjectionFence.departmentId, departmentId),
  )).limit(1).for("update");
  const latest = fences[0];
  if (!latest) projectionError("callback_department_seen_fence_missing");
  const comparison = compareMemberProjectionFence({
    eventTime: latest.lastEventTime,
    sequenceRank: latest.lastSequenceRank,
    eventId: latest.lastEventId,
  }, incomingFence(claim));
  if (comparison > 0) return "superseded";
  if (comparison < 0 || !exactFence(latest, claim)) {
    projectionError("callback_department_seen_fence_conflict");
  }

  if (prepared.kind === "not_found" || prepared.kind === "incomplete") {
    return "refresh-required";
  }
  const current = (await tx.select().from(workDepartmentCurrent).where(and(
    eq(workDepartmentCurrent.corpId, claim.corpId),
    eq(workDepartmentCurrent.departmentId, departmentId),
  )).limit(1).for("update"))[0];
  if (!current) projectionError("callback_department_current_missing");
  if (
    prepared.kind === "snapshot"
    && prepared.snapshot.departmentId !== departmentId
  ) {
    projectionError("callback_department_snapshot_identity_mismatch");
  }
  return prepared.kind === "absent"
    ? applyDepartmentDelete(tx, claim, current, departmentId, now)
    : applyDepartmentSnapshot(tx, claim, current, prepared.snapshot, now);
}

export async function auditDepartmentProjectionRows(
  tx: DbClient,
  corpId: string,
  departmentIds: number[],
) {
  const ids = [...new Set(departmentIds)].sort((left, right) => left - right);
  if (ids.length === 0) return { departments: [], fences: [], leaders: [] };
  const departments = await tx.select().from(workDepartmentCurrent).where(and(
    eq(workDepartmentCurrent.corpId, corpId),
    inArray(workDepartmentCurrent.departmentId, ids),
  )).orderBy(asc(workDepartmentCurrent.departmentId));
  const fences = await tx.select().from(workDepartmentProjectionFence).where(and(
    eq(workDepartmentProjectionFence.corpId, corpId),
    inArray(workDepartmentProjectionFence.departmentId, ids),
  )).orderBy(asc(workDepartmentProjectionFence.departmentId));
  const leaders = await tx.select().from(workDepartmentLeaderCurrent).where(and(
    eq(workDepartmentLeaderCurrent.corpId, corpId),
    inArray(workDepartmentLeaderCurrent.departmentId, ids),
  )).orderBy(
    asc(workDepartmentLeaderCurrent.departmentId),
    asc(workDepartmentLeaderCurrent.sortOrder),
  );
  return { departments, fences, leaders };
}
