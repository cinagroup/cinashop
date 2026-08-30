import {
  and,
  asc,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  workMember,
  workMemberCurrent,
  workMemberIdentityAlias,
  workMemberOther,
  workMemberOtherCurrent,
  workMemberRelationCurrent,
  type WorkMemberCurrent,
  type WorkMemberIdentityAlias,
} from "@/models/schema";
import {
  EnterpriseWechatMemberProjectionError,
  memberProjectionIdentity,
  type EnterpriseWechatMemberSnapshot,
  type MemberProjectionClaim,
  type PreparedMemberProjection,
} from "@/services/work/EnterpriseWechatMemberProjection";

export interface MemberProjectionFenceClaim extends MemberProjectionClaim {
  subjectKeyHash: string;
}

export type MemberCurrentProjectionResult =
  | "applied"
  | "applied-noop"
  | "refresh-required"
  | "superseded";

interface EventFence {
  eventTime: number;
  sequenceRank: number;
  eventId: number;
}

interface CurrentRelation {
  departmentId: number;
  sortOrder: number;
  isLeaderInDepartment: number;
}

interface LegacySeed {
  id: number;
  uid: number;
  name: string;
  position: string;
  mobile: string;
  gender: number;
  email: string;
  bizMail: string;
  directLeader: string;
  avatar: string;
  thumbAvatar: string;
  telephone: string;
  alias: string;
  isLeader: number;
  hideMobile: number;
  address: string;
  openUserid: string;
  mainDepartment: number;
  qrCode: string;
  externalPosition: string;
  createTime: number;
  extattr: string | null;
  externalProfile: string | null;
}

function projectionError(errorCode: string): never {
  throw new EnterpriseWechatMemberProjectionError(errorCode);
}

/** Positive means left is newer. */
export function compareMemberProjectionFence(left: EventFence, right: EventFence): number {
  if (left.eventTime !== right.eventTime) return left.eventTime > right.eventTime ? 1 : -1;
  if (left.sequenceRank !== right.sequenceRank) {
    return left.sequenceRank > right.sequenceRank ? 1 : -1;
  }
  if (left.eventId !== right.eventId) return left.eventId > right.eventId ? 1 : -1;
  return 0;
}

function claimFence(claim: MemberProjectionFenceClaim): EventFence {
  return {
    eventTime: claim.eventTime,
    sequenceRank: claim.sequenceRank,
    eventId: claim.eventId,
  };
}

function storedFence(row: {
  lastEventTime: number;
  lastSequenceRank: number;
  lastEventId: number | null;
}): EventFence {
  return {
    eventTime: row.lastEventTime,
    sequenceRank: row.lastSequenceRank,
    eventId: row.lastEventId ?? 0,
  };
}

function aliasLinkFence(
  alias: WorkMemberIdentityAlias,
  errorCode: string,
): EventFence {
  if (alias.linkEventId === null || alias.linkEventTime <= 0 || alias.linkSequenceRank < 0) {
    projectionError(errorCode);
  }
  return {
    eventTime: alias.linkEventTime,
    sequenceRank: alias.linkSequenceRank,
    eventId: alias.linkEventId,
  };
}

function identitiesForClaim(claim: MemberProjectionFenceClaim): string[] {
  const identity = memberProjectionIdentity(claim);
  return [...new Set([identity.previousUserid, identity.targetUserid])].sort();
}

const STORED_MEMBER_ID = /^[a-z0-9][a-z0-9_@.-]{0,63}$/;

function pendingRenameSource(alias: WorkMemberIdentityAlias): string | null {
  if (
    alias.lifecycleState !== "UNRESOLVED"
    || alias.canonicalUserid === alias.userid
  ) return null;
  if (!STORED_MEMBER_ID.test(alias.canonicalUserid)) {
    projectionError("callback_member_pending_rename_invalid");
  }
  aliasLinkFence(alias, "callback_member_pending_rename_fence_invalid");
  return alias.canonicalUserid;
}

function pendingRenameFence(alias: WorkMemberIdentityAlias): EventFence | null {
  return pendingRenameSource(alias) === null
    ? null
    : aliasLinkFence(alias, "callback_member_pending_rename_fence_invalid");
}

/**
 * A resolved RENAMED alias keeps the immutable fence of its outgoing rename
 * edge. Its mutable lastEvent fence may continue to advance when a delayed
 * callback names the historical UserID and must never be used as edge time.
 */
function resolvedRenameFence(alias: WorkMemberIdentityAlias): EventFence | null {
  if (alias.lifecycleState !== "RENAMED") return null;
  if (
    alias.memberId === null
    || alias.canonicalUserid === alias.userid
    || !STORED_MEMBER_ID.test(alias.canonicalUserid)
  ) projectionError("callback_member_resolved_rename_invalid");
  return aliasLinkFence(alias, "callback_member_resolved_rename_fence_invalid");
}

/**
 * Return the proved pending rename component in oldest-to-current order.
 * UNRESOLVED aliases point backwards to their authoritative predecessor;
 * resolved RENAMED aliases point forwards and deliberately terminate the
 * pending chain. Explicit rename callbacks contribute the newest edge even
 * when their target already has a later latest-seen fence.
 */
function memberIdentityLineage(
  aliases: WorkMemberIdentityAlias[],
  targetUserid: string,
  explicitPreviousUserid?: string,
): string[] {
  const reverse = [targetUserid];
  let cursor = explicitPreviousUserid && explicitPreviousUserid !== targetUserid
    ? explicitPreviousUserid
    : pendingRenameSource(
        aliases.find((alias) => alias.userid === targetUserid)
          ?? projectionError("callback_member_seen_fence_missing"),
      );
  while (cursor) {
    if (reverse.includes(cursor)) projectionError("callback_member_pending_rename_cycle");
    reverse.push(cursor);
    if (reverse.length > 8) projectionError("callback_member_pending_rename_depth");
    const alias = aliases.find((candidate) => candidate.userid === cursor);
    if (!alias) {
      if (explicitPreviousUserid === cursor) break;
      projectionError("callback_member_seen_fence_missing");
    }
    cursor = pendingRenameSource(alias);
  }
  return reverse.reverse();
}

/**
 * Follow a previously resolved rename target to its current terminal identity.
 * Unlike pending edges, RENAMED aliases point forwards. Every hop must retain
 * the same stable member ID; otherwise the component is corrupt or ambiguous
 * and must be quarantined instead of guessed.
 */
function resolvedForwardRenameLineage(
  aliases: WorkMemberIdentityAlias[],
  targetUserid: string,
): string[] {
  const lineage = [targetUserid];
  let cursor = targetUserid;
  while (true) {
    const alias = aliases.find((candidate) => candidate.userid === cursor)
      ?? projectionError("callback_member_seen_fence_missing");
    const edge = resolvedRenameFence(alias);
    if (!edge) return lineage;
    if (lineage.includes(alias.canonicalUserid)) {
      projectionError("callback_member_resolved_rename_cycle");
    }
    const targetAlias = aliases.find(
      (candidate) => candidate.userid === alias.canonicalUserid,
    );
    if (!targetAlias || targetAlias.memberId !== alias.memberId) {
      projectionError("callback_member_resolved_rename_member_mismatch");
    }
    const previousAlias = lineage.length > 1
      ? aliases.find((candidate) => candidate.userid === lineage[lineage.length - 2])
      : undefined;
    const previousEdge = previousAlias ? resolvedRenameFence(previousAlias) : null;
    if (previousEdge && compareMemberProjectionFence(edge, previousEdge) <= 0) {
      projectionError("callback_member_resolved_rename_order_conflict");
    }
    lineage.push(alias.canonicalUserid);
    if (lineage.length > 8) projectionError("callback_member_resolved_rename_depth");
    cursor = alias.canonicalUserid;
  }
}

interface MemberRenameEdgePlan {
  sourceUserid: string;
  targetUserid: string;
  fence: EventFence;
}

function sameFence(left: EventFence, right: EventFence): boolean {
  return compareMemberProjectionFence(left, right) === 0;
}

/**
 * Freeze all adjacent rename edges before any alias mutation. Pending edges
 * live on their targets, resolved edges live on their sources, and the direct
 * callback supplies the one edge that may not yet exist in either place.
 */
function buildMemberRenameEdgePlan(
  aliases: WorkMemberIdentityAlias[],
  lineage: string[],
  claim: MemberProjectionFenceClaim,
): MemberRenameEdgePlan[] {
  if (new Set(lineage).size !== lineage.length) {
    projectionError("callback_member_identity_lineage_cycle");
  }
  const identity = memberProjectionIdentity(claim);
  const byUserid = new Map(aliases.map((alias) => [alias.userid, alias]));
  const plan: MemberRenameEdgePlan[] = [];

  for (let index = 0; index < lineage.length - 1; index += 1) {
    const sourceUserid = lineage[index]
      ?? projectionError("callback_member_identity_lineage_empty");
    const targetUserid = lineage[index + 1]
      ?? projectionError("callback_member_identity_lineage_empty");
    const sourceAlias = byUserid.get(sourceUserid)
      ?? projectionError("callback_member_seen_fence_missing");
    const targetAlias = byUserid.get(targetUserid)
      ?? projectionError("callback_member_seen_fence_missing");
    const candidates: EventFence[] = [];

    const resolvedFence = resolvedRenameFence(sourceAlias);
    if (resolvedFence) {
      if (sourceAlias.canonicalUserid !== targetUserid) {
        projectionError("callback_member_resolved_rename_target_mismatch");
      }
      candidates.push(resolvedFence);
    }

    const pendingSource = pendingRenameSource(targetAlias);
    if (pendingSource !== null) {
      if (pendingSource !== sourceUserid) {
        projectionError("callback_member_pending_rename_branch");
      }
      const pendingFence = pendingRenameFence(targetAlias)
        ?? projectionError("callback_member_pending_rename_fence_invalid");
      candidates.push(pendingFence);
    }

    const directClaim = identity.renamed
      && identity.previousUserid === sourceUserid
      && identity.targetUserid === targetUserid
      ? claimFence(claim)
      : null;
    if (directClaim) candidates.push(directClaim);
    const edge = candidates[0]
      ?? projectionError("callback_member_resolved_rename_fence_missing");
    if (candidates.some((candidate) => !sameFence(candidate, edge))) {
      projectionError("callback_member_rename_edge_ambiguous");
    }
    if (
      compareMemberProjectionFence(storedFence(sourceAlias), edge) < 0
      && (!directClaim || !sameFence(directClaim, edge))
    ) projectionError("callback_member_resolved_rename_fence_ahead");
    const previous = plan[plan.length - 1];
    if (previous && compareMemberProjectionFence(edge, previous.fence) <= 0) {
      projectionError("callback_member_resolved_rename_order_conflict");
    }
    plan.push({ sourceUserid, targetUserid, fence: edge });
  }
  return plan;
}

function memberIdentityLineageIsStale(
  aliases: WorkMemberIdentityAlias[],
  lineage: string[],
): boolean {
  for (const userid of lineage.slice(1)) {
    const pendingAlias = aliases.find((alias) => alias.userid === userid);
    const edge = pendingAlias ? pendingRenameFence(pendingAlias) : null;
    const sourceUserid = pendingAlias ? pendingRenameSource(pendingAlias) : null;
    const sourceAlias = sourceUserid
      ? aliases.find((alias) => alias.userid === sourceUserid)
      : undefined;
    if (edge && sourceAlias && compareMemberProjectionFence(storedFence(sourceAlias), edge) > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Both claim and finalize use this exact lock order. The key includes CorpID,
 * so the same case-folded UserID in two enterprises remains independent.
 */
export async function lockMemberProjectionIdentities(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
): Promise<string[]> {
  const seedIdentities = identitiesForClaim(claim);
  const identities = await discoverMemberProjectionLockClosure(tx, claim, seedIdentities);
  for (const userid of identities) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`work-member:${claim.corpId}:${userid}`}, 0)
    )`);
  }
  const verified = await discoverMemberProjectionLockClosure(tx, claim, identities);
  if (
    verified.length !== identities.length
    || verified.some((userid, index) => userid !== identities[index])
  ) throw new Error("callback_member_lock_set_changed");
  return identities;
}

/**
 * Pending edges are closed in both directions and then expanded across the
 * stable member component. This prevents two callback transactions from
 * taking advisory locks for A/C and B/D while later row-locking the same
 * current member or historical alias in the opposite order.
 */
async function discoverMemberProjectionLockClosure(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  seedIdentities: string[],
): Promise<string[]> {
  const identities = new Set(seedIdentities);
  const memberIds = new Set<number>();
  for (let depth = 0; depth < 16; depth += 1) {
    const beforeIdentityCount = identities.size;
    const beforeMemberCount = memberIds.size;
    const identityList = [...identities];
    const memberList = [...memberIds];
    const aliasScope = memberList.length
      ? or(
          inArray(workMemberIdentityAlias.userid, identityList),
          inArray(workMemberIdentityAlias.canonicalUserid, identityList),
          inArray(workMemberIdentityAlias.memberId, memberList),
        )
      : or(
          inArray(workMemberIdentityAlias.userid, identityList),
          inArray(workMemberIdentityAlias.canonicalUserid, identityList),
        );
    const aliases = await tx.select().from(workMemberIdentityAlias).where(and(
      eq(workMemberIdentityAlias.corpId, claim.corpId),
      aliasScope,
    ));
    for (const alias of aliases) {
      identities.add(alias.userid);
      const source = pendingRenameSource(alias);
      if (source) identities.add(source);
      if (alias.lifecycleState === "RENAMED") identities.add(alias.canonicalUserid);
      if (alias.memberId !== null) memberIds.add(alias.memberId);
    }

    const expandedIdentityList = [...identities];
    const expandedMemberList = [...memberIds];
    const currentScope = expandedMemberList.length
      ? or(
          inArray(workMemberCurrent.userid, expandedIdentityList),
          inArray(workMemberCurrent.id, expandedMemberList),
        )
      : inArray(workMemberCurrent.userid, expandedIdentityList);
    const currents = await tx.select({
      id: workMemberCurrent.id,
      userid: workMemberCurrent.userid,
    }).from(workMemberCurrent).where(and(
      eq(workMemberCurrent.corpId, claim.corpId),
      currentScope,
    ));
    for (const current of currents) {
      identities.add(current.userid);
      memberIds.add(current.id);
    }
    if (identities.size > 64 || memberIds.size > 64) {
      projectionError("callback_member_identity_component_too_large");
    }
    if (identities.size === beforeIdentityCount && memberIds.size === beforeMemberCount) {
      return [...identities].sort();
    }
  }
  projectionError("callback_member_identity_component_depth");
}

async function lockedAliases(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  identities: string[],
): Promise<WorkMemberIdentityAlias[]> {
  return tx.select().from(workMemberIdentityAlias).where(and(
    eq(workMemberIdentityAlias.corpId, claim.corpId),
    inArray(workMemberIdentityAlias.userid, identities),
  )).orderBy(asc(workMemberIdentityAlias.userid)).for("update");
}

/**
 * Persist a fail-closed latest-seen overlay while member projection is parked.
 * This phase is intentionally narrower than recordMemberProjectionSeen: it may
 * quarantine endpoint aliases and retain an explicit rename edge, but it never
 * reads or mutates current business rows. The same durable event can therefore
 * be replayed after the authority gate opens without exposing stale legacy
 * membership in the meantime.
 */
export async function recordParkedMemberProjectionSeen(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  now: number,
): Promise<void> {
  const eventIdentity = memberProjectionIdentity(claim);
  if (claim.changeType === "delete_user") {
    projectionError("callback_member_delete_must_not_park");
  }
  const identities = await lockMemberProjectionIdentities(tx, claim);
  const aliases = await lockedAliases(tx, claim, identities);
  const incoming = claimFence(claim);
  const endpoints = [...new Set([
    eventIdentity.previousUserid,
    eventIdentity.targetUserid,
  ])].sort();

  for (const userid of endpoints) {
    const alias = aliases.find((candidate) => candidate.userid === userid);
    const renameTarget = eventIdentity.renamed && userid === eventIdentity.targetUserid;
    if (!alias) {
      const inserted = await tx.insert(workMemberIdentityAlias).values({
        corpId: claim.corpId,
        userid,
        memberId: null,
        canonicalUserid: renameTarget ? eventIdentity.previousUserid : userid,
        lifecycleState: "UNRESOLVED",
        lastEventId: claim.eventId,
        lastEventKey: claim.eventKey,
        lastEventSubjectKeyHash: claim.subjectKeyHash,
        lastEventTime: claim.eventTime,
        lastSequenceRank: claim.sequenceRank,
        linkEventId: renameTarget ? claim.eventId : null,
        linkEventTime: renameTarget ? claim.eventTime : 0,
        linkSequenceRank: renameTarget ? claim.sequenceRank : 0,
        createTime: now,
        updateTime: now,
      }).onConflictDoNothing().returning({ userid: workMemberIdentityAlias.userid });
      if (inserted.length !== 1) projectionError("callback_member_parked_seen_conflict");
      continue;
    }

    if (compareMemberProjectionFence(storedFence(alias), incoming) > 0) continue;

    let lifecycleState = alias.lifecycleState;
    let canonicalUserid = alias.canonicalUserid;
    let linkEventId = alias.linkEventId;
    let linkEventTime = alias.linkEventTime;
    let linkSequenceRank = alias.linkSequenceRank;
    if (alias.lifecycleState === "ACTIVE") {
      lifecycleState = "UNRESOLVED";
      canonicalUserid = renameTarget ? eventIdentity.previousUserid : userid;
      linkEventId = renameTarget ? claim.eventId : null;
      linkEventTime = renameTarget ? claim.eventTime : 0;
      linkSequenceRank = renameTarget ? claim.sequenceRank : 0;
    } else if (alias.lifecycleState === "UNRESOLVED" && renameTarget) {
      const existingSource = pendingRenameSource(alias);
      if (existingSource === null || existingSource === eventIdentity.previousUserid) {
        const existingLink = pendingRenameFence(alias);
        if (!existingLink || compareMemberProjectionFence(incoming, existingLink) > 0) {
          canonicalUserid = eventIdentity.previousUserid;
          linkEventId = claim.eventId;
          linkEventTime = claim.eventTime;
          linkSequenceRank = claim.sequenceRank;
        }
      }
    }

    const newerFence = compareMemberProjectionFence(incoming, storedFence(alias)) > 0;
    const changed = lifecycleState !== alias.lifecycleState
      || canonicalUserid !== alias.canonicalUserid
      || linkEventId !== alias.linkEventId
      || linkEventTime !== alias.linkEventTime
      || linkSequenceRank !== alias.linkSequenceRank;
    if (!newerFence && !changed) continue;

    const updated = await tx.update(workMemberIdentityAlias).set({
      lifecycleState,
      canonicalUserid,
      linkEventId,
      linkEventTime,
      linkSequenceRank,
      ...(newerFence ? {
        lastEventId: claim.eventId,
        lastEventKey: claim.eventKey,
        lastEventSubjectKeyHash: claim.subjectKeyHash,
        lastEventTime: claim.eventTime,
        lastSequenceRank: claim.sequenceRank,
      } : {}),
      updateTime: now,
    }).where(and(
      eq(workMemberIdentityAlias.corpId, claim.corpId),
      eq(workMemberIdentityAlias.userid, userid),
    )).returning({ userid: workMemberIdentityAlias.userid });
    if (updated.length !== 1) projectionError("callback_member_parked_seen_lost");
  }
}

/**
 * Phase 1 fence. It deliberately commits before provider I/O, so a newer
 * PROCESSING/FAILED event prevents an older response from touching business
 * state even though no newer applied watermark exists yet.
 */
export async function recordMemberProjectionSeen(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  now: number,
): Promise<"ready" | "superseded"> {
  const eventIdentity = memberProjectionIdentity(claim);
  const identities = await lockMemberProjectionIdentities(tx, claim);
  const aliases = await lockedAliases(tx, claim, identities);
  const incoming = claimFence(claim);
  const targetAlias = aliases.find((alias) => alias.userid === eventIdentity.targetUserid);
  const sourceAlias = aliases.find((alias) => alias.userid === eventIdentity.previousUserid);
  const sourceResolvedFence = sourceAlias ? resolvedRenameFence(sourceAlias) : null;
  const alreadyResolvedRename = eventIdentity.renamed
    && sourceResolvedFence !== null
    && sourceAlias !== undefined
    && sourceAlias.canonicalUserid === eventIdentity.targetUserid
    && sourceAlias.memberId !== null
    && targetAlias?.memberId === sourceAlias.memberId
    && (targetAlias.lifecycleState === "ACTIVE" || targetAlias.lifecycleState === "DELETED");
  const targetPendingSource = targetAlias ? pendingRenameSource(targetAlias) : null;
  const targetPendingFence = targetAlias ? pendingRenameFence(targetAlias) : null;
  if (
    eventIdentity.renamed
    && targetPendingSource !== null
    && targetPendingSource !== eventIdentity.previousUserid
  ) projectionError("callback_member_pending_rename_branch");
  const pendingEdgeAlreadyNewerOrEqual = eventIdentity.renamed
    && targetPendingSource === eventIdentity.previousUserid
    && targetPendingFence !== null
    && compareMemberProjectionFence(targetPendingFence, incoming) >= 0;
  const targetWasNewer = targetAlias
    ? compareMemberProjectionFence(storedFence(targetAlias), incoming) > 0
    : false;
  const pendingLineage = targetAlias
    ? memberIdentityLineage(
        aliases,
        eventIdentity.targetUserid,
        eventIdentity.renamed ? eventIdentity.previousUserid : undefined,
      )
    : [eventIdentity.previousUserid, eventIdentity.targetUserid]
        .filter((userid, index, values) => values.indexOf(userid) === index);
  const resolvedForwardLineage = eventIdentity.renamed && targetAlias
    ? resolvedForwardRenameLineage(aliases, eventIdentity.targetUserid)
    : [eventIdentity.targetUserid];
  const resolvedForwardTarget = resolvedForwardLineage.length > 1;
  const existingLineage = [
    ...pendingLineage,
    ...resolvedForwardLineage.slice(1),
  ];
  if (new Set(existingLineage).size !== existingLineage.length) {
    projectionError("callback_member_identity_lineage_cycle");
  }
  if (existingLineage.length > 8) projectionError("callback_member_identity_lineage_depth");
  if (!eventIdentity.renamed && memberIdentityLineageIsStale(aliases, existingLineage)) {
    return "superseded";
  }
  if (
    eventIdentity.renamed
    && sourceAlias
    && (sourceAlias.lifecycleState === "RENAMED" || sourceAlias.lifecycleState === "DELETED")
    && !alreadyResolvedRename
  ) return "superseded";

  // A later event on the rename source/root can represent UserID reuse and
  // makes an older edge unsafe. A later event on the target is different: it
  // is normally the first post-rename update/delete and must not erase the
  // A->B equivalence evidence.
  const fenceSubjects = new Set([eventIdentity.previousUserid, eventIdentity.targetUserid]);
  const newerAliasBlocks = aliases.some((alias) =>
    fenceSubjects.has(alias.userid)
      && compareMemberProjectionFence(storedFence(alias), incoming) > 0
      && (!eventIdentity.renamed
        || alreadyResolvedRename
        || alias.userid !== eventIdentity.targetUserid));
  if (newerAliasBlocks) return "superseded";

  const currents = await currentCandidates(tx, claim, aliases, identities);
  const terminalTargetUserid = existingLineage[existingLineage.length - 1]
    ?? eventIdentity.targetUserid;
  const targetCurrent = currents.find((row) => row.userid === terminalTargetUserid);
  if (
    eventIdentity.renamed
    && !resolvedForwardTarget
    && targetCurrent
    && currents.some((row) => row.id !== targetCurrent.id)
    && compareMemberProjectionFence(storedFence(targetCurrent), incoming) <= 0
  ) {
    // A target identity that was independently established before this rename
    // is not a target-first delivery. Rebinding it would merge two members on
    // an impossible/ambiguous UserID transition, so quarantine the event.
    projectionError("callback_member_identity_conflict");
  }
  const sourceCurrent = sourceAlias?.memberId === null || sourceAlias === undefined
    ? currents.find((row) => row.userid === eventIdentity.previousUserid)
    : currents.find((row) => row.id === sourceAlias.memberId);
  if (sourceCurrent && currentFenceIsNewer(sourceCurrent, claim)) return "superseded";
  if (!eventIdentity.renamed && currents.some((row) => currentFenceIsNewer(row, claim))) {
    return "superseded";
  }

  if (currents.length > 1 && !eventIdentity.renamed && existingLineage.length === 1) {
    projectionError("callback_member_identity_conflict");
  }
  if (resolvedForwardTarget) {
    const edgePlan = buildMemberRenameEdgePlan(aliases, existingLineage, claim);
    const resolvedEdges = resolvedForwardLineage.slice(0, -1).map((userid) =>
      aliases.find((alias) => alias.userid === userid)
        ?? projectionError("callback_member_seen_fence_missing"));
    if (resolvedEdges.some((alias) => {
      const edge = resolvedRenameFence(alias)
        ?? projectionError("callback_member_resolved_rename_fence_missing");
      return compareMemberProjectionFence(edge, incoming) <= 0;
    })) projectionError("callback_member_resolved_rename_order_conflict");
    if (resolvedEdges.some((alias) => {
      const edge = resolvedRenameFence(alias)
        ?? projectionError("callback_member_resolved_rename_fence_missing");
      return compareMemberProjectionFence(storedFence(alias), edge) > 0;
    })) projectionError("callback_member_resolved_rename_reused");
    if (!targetCurrent) projectionError("callback_member_resolved_target_missing");
    const rootUserid = existingLineage[0]
      ?? projectionError("callback_member_identity_lineage_empty");
    const predecessorActiveAliases = aliases.filter((alias) =>
      alias.lifecycleState === "ACTIVE" && alias.userid !== terminalTargetUserid);
    if (
      predecessorActiveAliases.length > 1
      || predecessorActiveAliases.some(
        (alias) => alias.userid !== rootUserid || alias.memberId === null,
      )
    ) projectionError("callback_member_resolved_active_branch");
    for (const alias of predecessorActiveAliases) {
      if (alias.memberId === null) projectionError("callback_member_resolved_active_branch");
      const rootEdge = edgePlan.find((edge) => edge.sourceUserid === alias.userid)
        ?? projectionError("callback_member_resolved_rename_fence_missing");
      await setAliasState(
        tx,
        claim,
        alias.userid,
        "RENAMED",
        rootEdge.targetUserid,
        alias.memberId,
        now,
        rootEdge.fence,
      );
    }
    const consolidation = await consolidateMemberCurrentComponent(
      tx,
      claim,
      aliases,
      identities,
      existingLineage,
      now,
      true,
    );
    const reconciled = consolidation.current;
    if (
      !reconciled
      || reconciled.userid !== terminalTargetUserid
      || (reconciled.lifecycleState !== "ACTIVE" && reconciled.lifecycleState !== "DELETED")
    ) projectionError("callback_member_resolved_target_invalid");
    await finalizeMemberIdentityLineage(
      tx,
      claim,
      existingLineage,
      reconciled.id,
      reconciled.lifecycleState,
      now,
      edgePlan,
    );
    return "superseded";
  }
  const rootUserid = existingLineage[0] ?? eventIdentity.previousUserid;
  const rootAlias = aliases.find((alias) => alias.userid === rootUserid);
  const linkedCurrent = rootAlias?.memberId !== null && rootAlias?.memberId !== undefined
    ? currents.find((row) => row.id === rootAlias.memberId)
    : currents.find((row) => row.userid === rootUserid) ?? (currents.length === 1 ? currents[0] : undefined);
  const stableMemberId = sourceAlias?.memberId
    ?? sourceCurrent?.id
    ?? linkedCurrent?.id
    ?? targetAlias?.memberId
    ?? currents.find((row) => row.userid === eventIdentity.targetUserid)?.id
    ?? null;
  const installPendingRename = eventIdentity.renamed
    && !alreadyResolvedRename
    && !pendingEdgeAlreadyNewerOrEqual;
  let topologyChanged = false;

  for (const userid of identities) {
    const alias = aliases.find((candidate) => candidate.userid === userid);
    const pendingRenameTarget = installPendingRename && userid === eventIdentity.targetUserid;
    const pendingCanonicalUserid = pendingRenameTarget
      ? eventIdentity.previousUserid
      : userid;
    if (!alias) {
      if (!fenceSubjects.has(userid)) {
        projectionError("callback_member_identity_component_alias_missing");
      }
      const inserted = await tx.insert(workMemberIdentityAlias).values({
        corpId: claim.corpId,
        userid,
        memberId: stableMemberId,
        canonicalUserid: pendingCanonicalUserid,
        lifecycleState: "UNRESOLVED",
        lastEventId: claim.eventId,
        lastEventKey: claim.eventKey,
        lastEventSubjectKeyHash: claim.subjectKeyHash,
        lastEventTime: claim.eventTime,
        lastSequenceRank: claim.sequenceRank,
        linkEventId: pendingRenameTarget ? claim.eventId : null,
        linkEventTime: pendingRenameTarget ? claim.eventTime : 0,
        linkSequenceRank: pendingRenameTarget ? claim.sequenceRank : 0,
        createTime: now,
        updateTime: now,
      }).onConflictDoNothing().returning({ userid: workMemberIdentityAlias.userid });
      if (inserted.length !== 1) projectionError("callback_member_seen_fence_conflict");
      topologyChanged = topologyChanged || pendingRenameTarget;
      continue;
    }
    const newerFence = fenceSubjects.has(userid)
      && compareMemberProjectionFence(incoming, storedFence(alias)) > 0;
    const linkedMemberId = alias.lifecycleState === "UNRESOLVED"
      || pendingRenameTarget
      ? stableMemberId ?? alias.memberId
      : alias.memberId;
    const linkedCanonicalUserid = pendingRenameTarget
      ? eventIdentity.previousUserid
      : alias.canonicalUserid;
    const linkedLifecycleState = pendingRenameTarget ? "UNRESOLVED" as const : alias.lifecycleState;
    const pendingLinkChanged = pendingRenameTarget && (
      alias.linkEventId !== claim.eventId
      || alias.linkEventTime !== claim.eventTime
      || alias.linkSequenceRank !== claim.sequenceRank
    );
    const linkChanged = linkedMemberId !== alias.memberId
      || linkedCanonicalUserid !== alias.canonicalUserid
      || linkedLifecycleState !== alias.lifecycleState
      || pendingLinkChanged;
    topologyChanged = topologyChanged || (pendingRenameTarget && linkChanged);
    if (newerFence || linkChanged) {
      const updated = await tx.update(workMemberIdentityAlias).set({
        memberId: linkedMemberId,
        canonicalUserid: linkedCanonicalUserid,
        lifecycleState: linkedLifecycleState,
        ...(pendingRenameTarget ? {
          linkEventId: claim.eventId,
          linkEventTime: claim.eventTime,
          linkSequenceRank: claim.sequenceRank,
        } : {}),
        ...(newerFence ? {
          lastEventId: claim.eventId,
          lastEventKey: claim.eventKey,
          lastEventSubjectKeyHash: claim.subjectKeyHash,
          lastEventTime: claim.eventTime,
          lastSequenceRank: claim.sequenceRank,
        } : {}),
        updateTime: now,
      }).where(and(
        eq(workMemberIdentityAlias.corpId, claim.corpId),
        eq(workMemberIdentityAlias.userid, userid),
      )).returning({ userid: workMemberIdentityAlias.userid });
      if (updated.length !== 1) projectionError("callback_member_seen_fence_lost");
    }
  }
  if (!topologyChanged && aliases.some(
    (alias) => compareMemberProjectionFence(storedFence(alias), incoming) > 0,
  )) return "superseded";
  if (installPendingRename && targetWasNewer) {
    let reconciledAliases = await lockedAliases(tx, claim, identities);
    const lineage = memberIdentityLineage(
      reconciledAliases,
      eventIdentity.targetUserid,
      eventIdentity.previousUserid,
    );
    if (memberIdentityLineageIsStale(reconciledAliases, lineage)) {
      // The newly observed direct edge is retained as UNRESOLVED evidence, but
      // a stale ancestor means the component may contain a reused identity.
      // Never merge or propagate a tombstone across that quarantine boundary.
      return "superseded";
    }
    if (targetCurrent && compareMemberProjectionFence(storedFence(targetCurrent), incoming) > 0) {
      const consolidation = await consolidateMemberCurrentComponent(
        tx,
        claim,
        reconciledAliases,
        identities,
        lineage,
        now,
        true,
      );
      if (consolidation.merged) {
        reconciledAliases = await lockedAliases(tx, claim, identities);
      }
      const reconciled = consolidation.current;
      if (reconciled && reconciled.userid === eventIdentity.targetUserid) {
        await finalizeMemberIdentityLineage(
          tx,
          claim,
          lineage,
          reconciled.id,
          reconciled.lifecycleState,
          now,
        );
      }
    } else if (targetAlias?.lifecycleState === "DELETED") {
      if (
        targetAlias.lastEventId === null
        || targetAlias.lastEventKey === null
        || targetAlias.lastEventSubjectKeyHash === null
      ) projectionError("callback_member_delete_fence_missing");
      const stableRows = currents.filter((row) => row.userid !== eventIdentity.targetUserid);
      if (stableRows.length > 1) projectionError("callback_member_identity_conflict");
      const stable = sourceCurrent ?? stableRows[0];
      if (stable) {
        if (!lineage.includes(stable.userid)) {
          projectionError("callback_member_delete_identity_conflict");
        }
        await tx.delete(workMemberRelationCurrent).where(and(
          eq(workMemberRelationCurrent.corpId, claim.corpId),
          eq(workMemberRelationCurrent.memberId, stable.id),
        ));
        const updated = await tx.update(workMemberCurrent).set({
          userid: eventIdentity.targetUserid,
          canonicalUserid: eventIdentity.targetUserid,
          lifecycleState: "DELETED",
          enable: 0,
          status: 5,
          relationsComplete: false,
          deletedTime: stable.deletedTime ?? now,
          lastEventId: targetAlias.lastEventId,
          lastEventKey: targetAlias.lastEventKey,
          lastEventSubjectKeyHash: targetAlias.lastEventSubjectKeyHash,
          lastEventTime: targetAlias.lastEventTime,
          lastSequenceRank: targetAlias.lastSequenceRank,
          updateTime: now,
        }).where(and(
          eq(workMemberCurrent.corpId, claim.corpId),
          eq(workMemberCurrent.id, stable.id),
        )).returning();
        if (updated.length !== 1) projectionError("callback_member_current_update_lost");
        await finalizeMemberIdentityLineage(
          tx,
          claim,
          lineage,
          stable.id,
          "DELETED",
          now,
        );
      } else {
        const rootUserid = lineage[0]
          ?? projectionError("callback_member_identity_lineage_empty");
        const rootSeed = await legacySeed(tx, claim.corpId, rootUserid);
        const targetSeed = rootUserid === eventIdentity.targetUserid
          ? rootSeed
          : await legacySeed(tx, claim.corpId, eventIdentity.targetUserid);
        if (rootSeed && targetSeed && rootSeed.id !== targetSeed.id) {
          projectionError("callback_member_legacy_rename_conflict");
        }
        const seed = rootSeed ?? targetSeed;
        if (seed) {
          const existingLinks = await tx.select().from(workMemberCurrent).where(
            eq(workMemberCurrent.legacyMemberId, seed.id),
          ).limit(2);
          if (existingLinks.length) projectionError("callback_member_legacy_link_conflict");
          const tombstone = await insertLegacyMemberTombstone(
            tx,
            claim.corpId,
            eventIdentity.targetUserid,
            seed,
            {
              eventId: targetAlias.lastEventId,
              eventKey: targetAlias.lastEventKey,
              subjectKeyHash: targetAlias.lastEventSubjectKeyHash,
              eventTime: targetAlias.lastEventTime,
              sequenceRank: targetAlias.lastSequenceRank,
            },
            now,
          );
          await finalizeMemberIdentityLineage(
            tx,
            claim,
            lineage,
            tombstone.id,
            "DELETED",
            now,
          );
        } else {
          // Unknown deletes still fail closed. Without a stable current or
          // legacy row there is nothing safe to merge, so retain two self
          // tombstones instead of fabricating a member ID.
          for (const userid of lineage) {
            await setAliasState(tx, claim, userid, "DELETED", userid, null, now);
          }
        }
      }
    }
    // A newer target latest-seen fence always suppresses the older provider
    // read. If it has not applied yet, leave the edge UNRESOLVED for that newer
    // attempt rather than allowing stale data to win.
    return "superseded";
  }
  return "ready";
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right;
}

function sameRelations(left: CurrentRelation[], right: CurrentRelation[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && item.departmentId === candidate.departmentId
      && item.sortOrder === candidate.sortOrder
      && item.isLeaderInDepartment === candidate.isLeaderInDepartment;
  });
}

function sortedRelations(snapshot: EnterpriseWechatMemberSnapshot): CurrentRelation[] {
  return snapshot.departments.map((relation) => ({
    departmentId: relation.departmentId,
    sortOrder: relation.sortOrder,
    isLeaderInDepartment: relation.isLeaderInDepartment,
  })).sort((left, right) => left.departmentId - right.departmentId);
}

function optionalValue<T>(incoming: T | undefined, existing: T | null): T | null {
  return incoming === undefined ? existing : incoming;
}

async function legacySeed(
  tx: DbClient,
  corpId: string,
  userid: string,
): Promise<LegacySeed | null> {
  const candidates = await tx.select({
    id: workMember.id,
    uid: workMember.uid,
    name: workMember.name,
    position: workMember.position,
    mobile: workMember.mobile,
    gender: workMember.gender,
    email: workMember.email,
    bizMail: workMember.bizMail,
    directLeader: workMember.directLeader,
    avatar: workMember.avatar,
    thumbAvatar: workMember.thumbAvatar,
    telephone: workMember.telephone,
    alias: workMember.alias,
    isLeader: workMember.isLeader,
    hideMobile: workMember.hideMobile,
    address: workMember.address,
    openUserid: workMember.openUserid,
    mainDepartment: workMember.mainDepartment,
    qrCode: workMember.qrCode,
    externalPosition: workMember.externalPosition,
    createTime: workMember.createTime,
  }).from(workMember).where(and(
    eq(workMember.corpId, corpId),
    sql`lower(${workMember.userid}) = ${userid}`,
  )).limit(2);
  if (candidates.length > 1) projectionError("callback_member_legacy_identity_ambiguous");
  const candidate = candidates[0];
  if (!candidate) return null;
  const otherRows = await tx.select({
    extattr: workMemberOther.extattr,
    externalProfile: workMemberOther.externalProfile,
  }).from(workMemberOther).where(eq(workMemberOther.memberId, candidate.id)).limit(2);
  if (otherRows.length > 1) projectionError("callback_member_legacy_other_ambiguous");
  return {
    ...candidate,
    extattr: otherRows[0]?.extattr ?? null,
    externalProfile: otherRows[0]?.externalProfile ?? null,
  };
}

interface TombstoneEventFence {
  eventId: number;
  eventKey: string;
  subjectKeyHash: string;
  eventTime: number;
  sequenceRank: number;
}

async function insertLegacyMemberTombstone(
  tx: DbClient,
  corpId: string,
  targetUserid: string,
  seed: LegacySeed,
  fence: TombstoneEventFence,
  now: number,
): Promise<WorkMemberCurrent> {
  const inserted = await tx.insert(workMemberCurrent).values({
    corpId,
    userid: targetUserid,
    canonicalUserid: targetUserid,
    lifecycleState: "DELETED",
    legacyMemberId: seed.id,
    uid: seed.uid,
    name: seed.name,
    position: seed.position,
    mobile: seed.mobile,
    gender: seed.gender,
    email: seed.email,
    bizMail: seed.bizMail,
    directLeader: seed.directLeader,
    avatar: seed.avatar,
    thumbAvatar: seed.thumbAvatar,
    telephone: seed.telephone,
    alias: seed.alias,
    enable: 0,
    isLeader: seed.isLeader,
    hideMobile: seed.hideMobile,
    address: seed.address,
    openUserid: seed.openUserid,
    mainDepartment: seed.mainDepartment > 0 ? seed.mainDepartment : null,
    status: 5,
    qrCode: seed.qrCode,
    externalPosition: seed.externalPosition,
    profileComplete: false,
    relationsComplete: false,
    deletedTime: now,
    lastEventId: fence.eventId,
    lastEventKey: fence.eventKey,
    lastEventSubjectKeyHash: fence.subjectKeyHash,
    lastEventTime: fence.eventTime,
    lastSequenceRank: fence.sequenceRank,
    createTime: seed.createTime > 0 ? seed.createTime : now,
    updateTime: now,
  }).returning();
  const current = inserted[0];
  if (!current || inserted.length !== 1) {
    projectionError("callback_member_current_insert_failed");
  }
  if (seed.extattr !== null || seed.externalProfile !== null) {
    await tx.insert(workMemberOtherCurrent).values({
      corpId,
      memberId: current.id,
      extattr: seed.extattr,
      externalProfile: seed.externalProfile,
      updateTime: now,
    });
  }
  return current;
}

async function currentCandidates(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  aliases: WorkMemberIdentityAlias[],
  identities: string[],
): Promise<WorkMemberCurrent[]> {
  const memberIds = [...new Set(aliases.flatMap((alias) => alias.memberId === null ? [] : [alias.memberId]))];
  const identityCondition = inArray(workMemberCurrent.userid, identities);
  const memberCondition = memberIds.length ? inArray(workMemberCurrent.id, memberIds) : undefined;
  return tx.select().from(workMemberCurrent).where(and(
    eq(workMemberCurrent.corpId, claim.corpId),
    memberCondition ? or(identityCondition, memberCondition) : identityCondition,
  )).orderBy(asc(workMemberCurrent.id)).for("update");
}

function currentFenceIsNewer(current: WorkMemberCurrent, claim: MemberProjectionFenceClaim): boolean {
  return compareMemberProjectionFence(storedFence(current), claimFence(claim)) > 0;
}

interface ConsolidatedMemberCurrent {
  current: WorkMemberCurrent | null;
  merged: boolean;
}

/**
 * Collapse provisional current rows created by a target-first callback into
 * the proved oldest stable member ID. The newest applied row supplies the
 * business snapshot and tombstone, while legacy/local linkage stays attached
 * to the stable row. Any alias or current outside the locked lineage turns the
 * operation into a terminal quarantine instead of a guessed merge.
 */
async function consolidateMemberCurrentComponent(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  aliases: WorkMemberIdentityAlias[],
  identities: string[],
  lineage: string[],
  now: number,
  requireNewestTarget: boolean,
): Promise<ConsolidatedMemberCurrent> {
  const rows = await currentCandidates(tx, claim, aliases, identities);
  if (rows.length === 0) return { current: null, merged: false };
  if (rows.length === 1) {
    let current = rows[0] ?? null;
    if (current && lineage.length > 1) {
      const rootUserid = lineage[0]
        ?? projectionError("callback_member_identity_lineage_empty");
      const targetUserid = lineage[lineage.length - 1]
        ?? projectionError("callback_member_identity_lineage_empty");
      const rootSeed = await legacySeed(tx, claim.corpId, rootUserid);
      const targetSeed = targetUserid === rootUserid
        ? rootSeed
        : await legacySeed(tx, claim.corpId, targetUserid);
      if (rootSeed && targetSeed && rootSeed.id !== targetSeed.id) {
        projectionError("callback_member_legacy_rename_conflict");
      }
      const seed = rootSeed ?? targetSeed;
      if (seed) {
        if (
          (current.legacyMemberId !== null && current.legacyMemberId !== seed.id)
          || (current.uid !== null && current.uid !== seed.uid)
        ) projectionError("callback_member_stable_link_conflict");
        const linkChanged = current.legacyMemberId === null || current.uid === null;
        if (linkChanged) {
          const updated = await tx.update(workMemberCurrent).set({
            legacyMemberId: current.legacyMemberId ?? seed.id,
            uid: current.uid ?? seed.uid,
            updateTime: now,
          }).where(and(
            eq(workMemberCurrent.corpId, claim.corpId),
            eq(workMemberCurrent.id, current.id),
          )).returning();
          if (updated.length !== 1) projectionError("callback_member_legacy_link_update_lost");
          current = updated[0] ?? current;
        }
        if (seed.extattr !== null || seed.externalProfile !== null) {
          await tx.insert(workMemberOtherCurrent).values({
            corpId: claim.corpId,
            memberId: current.id,
            extattr: seed.extattr,
            externalProfile: seed.externalProfile,
            updateTime: now,
          }).onConflictDoNothing();
        }
        return { current, merged: linkChanged };
      }
    }
    return { current, merged: false };
  }
  if (lineage.length <= 1 || rows.some((row) => !lineage.includes(row.userid))) {
    projectionError("callback_member_identity_conflict");
  }

  const rootUserid = lineage[0] ?? projectionError("callback_member_identity_lineage_empty");
  const rootAlias = aliases.find((alias) => alias.userid === rootUserid);
  if (!rootAlias) projectionError("callback_member_seen_fence_missing");
  const stable = (rootAlias.memberId === null
    ? undefined
    : rows.find((row) => row.id === rootAlias.memberId))
    ?? rows.find((row) => row.userid === rootUserid);
  if (!stable) projectionError("callback_member_stable_identity_missing");

  let newest = rows[0] ?? stable;
  for (const row of rows.slice(1)) {
    const comparison = compareMemberProjectionFence(storedFence(row), storedFence(newest));
    if (comparison > 0) newest = row;
    else if (comparison === 0 && row.id !== newest.id) {
      projectionError("callback_member_current_fence_ambiguous");
    }
  }
  const targetUserid = lineage[lineage.length - 1]
    ?? projectionError("callback_member_identity_lineage_empty");
  if (requireNewestTarget && newest.userid !== targetUserid) {
    projectionError("callback_member_target_current_not_newest");
  }

  const legacyIds = new Set(rows.flatMap((row) =>
    row.legacyMemberId === null ? [] : [row.legacyMemberId]));
  const linkedUids = new Set(rows.flatMap((row) => row.uid === null ? [] : [row.uid]));
  if (legacyIds.size > 1 || linkedUids.size > 1) {
    projectionError("callback_member_stable_link_conflict");
  }

  const loserIds = rows.filter((row) => row.id !== stable.id).map((row) => row.id);
  const linkedAliases = await tx.select().from(workMemberIdentityAlias).where(and(
    eq(workMemberIdentityAlias.corpId, claim.corpId),
    inArray(workMemberIdentityAlias.memberId, loserIds),
  )).orderBy(asc(workMemberIdentityAlias.userid)).for("update");
  if (
    linkedAliases.some((alias) => !identities.includes(alias.userid))
    || linkedAliases.some(
      (alias) => alias.lifecycleState === "ACTIVE" && alias.userid !== targetUserid,
    )
    || linkedAliases.filter((alias) => alias.lifecycleState === "ACTIVE").length > 1
  ) projectionError("callback_member_identity_component_branch");

  if (newest.id !== stable.id) {
    const newestOtherRows = await tx.select().from(workMemberOtherCurrent).where(and(
      eq(workMemberOtherCurrent.corpId, claim.corpId),
      eq(workMemberOtherCurrent.memberId, newest.id),
    )).limit(1).for("update");
    const stableOtherRows = await tx.select().from(workMemberOtherCurrent).where(and(
      eq(workMemberOtherCurrent.corpId, claim.corpId),
      eq(workMemberOtherCurrent.memberId, stable.id),
    )).limit(1).for("update");
    const newestOther = newestOtherRows[0];
    const stableOther = stableOtherRows[0];
    const chosenOther = newestOther ?? stableOther;
    if (chosenOther) {
      const mergedExtattr = newestOther?.extattr ?? stableOther?.extattr ?? null;
      const mergedExternalProfile = newestOther?.externalProfile
        ?? stableOther?.externalProfile
        ?? null;
      const mergedOtherUpdateTime = Math.max(
        newestOther?.updateTime ?? 0,
        stableOther?.updateTime ?? 0,
        now,
      );
      await tx.insert(workMemberOtherCurrent).values({
        corpId: claim.corpId,
        memberId: stable.id,
        extattr: mergedExtattr,
        externalProfile: mergedExternalProfile,
        updateTime: mergedOtherUpdateTime,
      }).onConflictDoUpdate({
        target: [workMemberOtherCurrent.corpId, workMemberOtherCurrent.memberId],
        set: {
          extattr: mergedExtattr,
          externalProfile: mergedExternalProfile,
          updateTime: mergedOtherUpdateTime,
        },
      });
    }

    if (newest.relationsComplete || newest.lifecycleState === "DELETED") {
      const newestRelations = await tx.select().from(workMemberRelationCurrent).where(and(
        eq(workMemberRelationCurrent.corpId, claim.corpId),
        eq(workMemberRelationCurrent.memberId, newest.id),
      )).orderBy(asc(workMemberRelationCurrent.departmentId)).for("update");
      await tx.delete(workMemberRelationCurrent).where(and(
        eq(workMemberRelationCurrent.corpId, claim.corpId),
        eq(workMemberRelationCurrent.memberId, stable.id),
      ));
      if (newestRelations.length) {
        await tx.insert(workMemberRelationCurrent).values(newestRelations.map((relation) => ({
          corpId: claim.corpId,
          memberId: stable.id,
          departmentId: relation.departmentId,
          sortOrder: relation.sortOrder,
          isLeaderInDept: relation.isLeaderInDept,
          createTime: relation.createTime,
          updateTime: relation.updateTime,
        })));
      }
    }
  }

  const rebound = await tx.update(workMemberIdentityAlias).set({
    memberId: stable.id,
    updateTime: now,
  }).where(and(
    eq(workMemberIdentityAlias.corpId, claim.corpId),
    inArray(workMemberIdentityAlias.memberId, loserIds),
  )).returning({ userid: workMemberIdentityAlias.userid });
  if (rebound.length !== linkedAliases.length) {
    projectionError("callback_member_alias_rebind_lost");
  }
  const deleted = await tx.delete(workMemberCurrent).where(and(
    eq(workMemberCurrent.corpId, claim.corpId),
    inArray(workMemberCurrent.id, loserIds),
  )).returning({ id: workMemberCurrent.id });
  if (deleted.length !== loserIds.length) projectionError("callback_member_current_merge_lost");

  const { id: _newestId, corpId: _newestCorpId, ...newestValues } = newest;
  const updated = await tx.update(workMemberCurrent).set({
    ...newestValues,
    legacyMemberId: stable.legacyMemberId ?? newest.legacyMemberId,
    uid: stable.uid ?? newest.uid,
    name: newest.name ?? stable.name,
    position: newest.position ?? stable.position,
    mobile: newest.mobile ?? stable.mobile,
    gender: newest.gender ?? stable.gender,
    email: newest.email ?? stable.email,
    bizMail: newest.bizMail ?? stable.bizMail,
    directLeader: newest.directLeader ?? stable.directLeader,
    avatar: newest.avatar ?? stable.avatar,
    thumbAvatar: newest.thumbAvatar ?? stable.thumbAvatar,
    telephone: newest.telephone ?? stable.telephone,
    alias: newest.alias ?? stable.alias,
    hideMobile: newest.hideMobile ?? stable.hideMobile,
    address: newest.address ?? stable.address,
    openUserid: newest.openUserid ?? stable.openUserid,
    mainDepartment: newest.mainDepartment ?? stable.mainDepartment,
    qrCode: newest.qrCode ?? stable.qrCode,
    externalPosition: newest.externalPosition ?? stable.externalPosition,
    createTime: stable.createTime,
    updateTime: Math.max(stable.updateTime, newest.updateTime),
  }).where(and(
    eq(workMemberCurrent.corpId, claim.corpId),
    eq(workMemberCurrent.id, stable.id),
  )).returning();
  if (updated.length !== 1) projectionError("callback_member_current_merge_update_lost");
  return { current: updated[0] ?? null, merged: true };
}

async function finalizeMemberIdentityLineage(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  lineage: string[],
  memberId: number,
  lifecycleState: "ACTIVE" | "DELETED",
  now: number,
  frozenEdgePlan?: MemberRenameEdgePlan[],
): Promise<boolean> {
  const targetUserid = lineage[lineage.length - 1]
    ?? projectionError("callback_member_identity_lineage_empty");
  if (new Set(lineage).size !== lineage.length) {
    projectionError("callback_member_identity_lineage_cycle");
  }
  const rows = await tx.select().from(workMemberIdentityAlias).where(and(
    eq(workMemberIdentityAlias.corpId, claim.corpId),
    inArray(workMemberIdentityAlias.userid, lineage),
  )).orderBy(asc(workMemberIdentityAlias.userid)).for("update");
  if (rows.length !== lineage.length) projectionError("callback_member_seen_fence_missing");
  const edgePlan = frozenEdgePlan ?? buildMemberRenameEdgePlan(rows, lineage, claim);
  if (
    edgePlan.length !== Math.max(0, lineage.length - 1)
    || edgePlan.some((edge, index) =>
      edge.sourceUserid !== lineage[index]
      || edge.targetUserid !== lineage[index + 1])
  ) projectionError("callback_member_resolved_rename_plan_mismatch");
  let changed = false;
  for (const edge of edgePlan) {
    changed = await setAliasState(
      tx,
      claim,
      edge.sourceUserid,
      "RENAMED",
      edge.targetUserid,
      memberId,
      now,
      edge.fence,
    ) || changed;
  }
  changed = await setAliasState(
    tx,
    claim,
    targetUserid,
    lifecycleState,
    targetUserid,
    memberId,
    now,
  ) || changed;
  return changed;
}

async function setAliasState(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  userid: string,
  state: "ACTIVE" | "RENAMED" | "DELETED",
  canonicalUserid: string,
  memberId: number | null,
  now: number,
  renameFence: EventFence | null = null,
): Promise<boolean> {
  if (state === "RENAMED") {
    if (memberId === null || canonicalUserid === userid || renameFence === null) {
      projectionError("callback_member_resolved_rename_invalid");
    }
  } else if (renameFence !== null) {
    projectionError("callback_member_non_rename_edge_fence");
  }
  const linkEventId = renameFence?.eventId ?? null;
  const linkEventTime = renameFence?.eventTime ?? 0;
  const linkSequenceRank = renameFence?.sequenceRank ?? 0;
  const rows = await tx.select().from(workMemberIdentityAlias).where(and(
    eq(workMemberIdentityAlias.corpId, claim.corpId),
    eq(workMemberIdentityAlias.userid, userid),
  )).limit(1).for("update");
  const existing = rows[0];
  if (!existing) projectionError("callback_member_seen_fence_missing");
  const edgeAheadOfLatest = renameFence
    ? compareMemberProjectionFence(renameFence, storedFence(existing)) > 0
    : false;
  const identity = memberProjectionIdentity(claim);
  const canAdvanceLatestToEdge = edgeAheadOfLatest
    && identity.renamed
    && identity.previousUserid === userid
    && sameFence(renameFence ?? claimFence(claim), claimFence(claim));
  if (edgeAheadOfLatest && !canAdvanceLatestToEdge) {
    projectionError("callback_member_resolved_rename_fence_ahead");
  }
  if (
    existing.lifecycleState === state
    && existing.canonicalUserid === canonicalUserid
    && existing.memberId === memberId
    && existing.linkEventId === linkEventId
    && existing.linkEventTime === linkEventTime
    && existing.linkSequenceRank === linkSequenceRank
    && !canAdvanceLatestToEdge
  ) return false;
  const updated = await tx.update(workMemberIdentityAlias).set({
    lifecycleState: state,
    canonicalUserid,
    memberId,
    linkEventId,
    linkEventTime,
    linkSequenceRank,
    ...(canAdvanceLatestToEdge ? {
      lastEventId: claim.eventId,
      lastEventKey: claim.eventKey,
      lastEventSubjectKeyHash: claim.subjectKeyHash,
      lastEventTime: claim.eventTime,
      lastSequenceRank: claim.sequenceRank,
    } : {}),
    updateTime: now,
  }).where(and(
    eq(workMemberIdentityAlias.corpId, claim.corpId),
    eq(workMemberIdentityAlias.userid, userid),
  )).returning({ userid: workMemberIdentityAlias.userid });
  if (updated.length !== 1) projectionError("callback_member_alias_update_lost");
  return true;
}

async function applyAbsent(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  projection: Extract<PreparedMemberProjection, { kind: "absent" }>,
  aliases: WorkMemberIdentityAlias[],
  identities: string[],
  now: number,
): Promise<MemberCurrentProjectionResult> {
  const alias = aliases.find((candidate) => candidate.userid === projection.targetUserid);
  if (!alias) projectionError("callback_member_seen_fence_missing");
  if (alias.lifecycleState === "RENAMED") return "superseded";
  const lineage = memberIdentityLineage(aliases, projection.targetUserid);
  const rootUserid = lineage[0] ?? projection.targetUserid;

  const consolidation = await consolidateMemberCurrentComponent(
    tx,
    claim,
    aliases,
    identities,
    lineage,
    now,
    false,
  );
  let current = consolidation.current;
  if (consolidation.merged) aliases = await lockedAliases(tx, claim, identities);
  const targetSeed = current ? null : await legacySeed(tx, claim.corpId, projection.targetUserid);
  const sourceSeed = !current && rootUserid !== projection.targetUserid
    ? await legacySeed(tx, claim.corpId, rootUserid)
    : targetSeed;
  if (targetSeed && sourceSeed && targetSeed.id !== sourceSeed.id) {
    projectionError("callback_member_legacy_rename_conflict");
  }
  const seed = targetSeed ?? sourceSeed;
  if (!current && seed) {
    const linkedRows = await tx.select().from(workMemberCurrent).where(
      eq(workMemberCurrent.legacyMemberId, seed.id),
    ).limit(2).for("update");
    if (linkedRows.length > 1) projectionError("callback_member_legacy_link_ambiguous");
    if (linkedRows[0]) {
      if (
        linkedRows[0].corpId !== claim.corpId
        || !lineage.includes(linkedRows[0].userid)
      ) projectionError("callback_member_legacy_link_conflict");
      current = linkedRows[0];
    }
  }
  if (!current && seed) {
    const tombstone = await insertLegacyMemberTombstone(
      tx,
      claim.corpId,
      projection.targetUserid,
      seed,
      claim,
      now,
    );
    await finalizeMemberIdentityLineage(
      tx,
      claim,
      lineage,
      tombstone.id,
      "DELETED",
      now,
    );
    return "applied";
  }
  if (!current) {
    for (const userid of lineage.slice(0, -1)) {
      await setAliasState(
        tx,
        claim,
        userid,
        "DELETED",
        userid,
        null,
        now,
      );
    }
    await setAliasState(
      tx,
      claim,
      projection.targetUserid,
      "DELETED",
      projection.targetUserid,
      null,
      now,
    );
    return "applied-noop";
  }
  if (currentFenceIsNewer(current, claim)) return "superseded";
  if (
    !lineage.includes(current.userid)
  ) {
    projectionError("callback_member_delete_identity_conflict");
  }

  const deletedRelations = await tx.delete(workMemberRelationCurrent).where(and(
    eq(workMemberRelationCurrent.corpId, claim.corpId),
    eq(workMemberRelationCurrent.memberId, current.id),
  )).returning({ departmentId: workMemberRelationCurrent.departmentId });
  const businessChanged = current.userid !== projection.targetUserid
    || current.canonicalUserid !== projection.targetUserid
    || current.lifecycleState !== "DELETED"
    || current.enable !== 0
    || current.status !== 5
    || current.deletedTime === null
    || current.relationsComplete
    || deletedRelations.length > 0;
  const updated = await tx.update(workMemberCurrent).set({
    userid: projection.targetUserid,
    canonicalUserid: projection.targetUserid,
    lifecycleState: "DELETED",
    enable: 0,
    status: 5,
    deletedTime: current.deletedTime ?? now,
    relationsComplete: false,
    lastEventId: claim.eventId,
    lastEventKey: claim.eventKey,
    lastEventSubjectKeyHash: claim.subjectKeyHash,
    lastEventTime: claim.eventTime,
    lastSequenceRank: claim.sequenceRank,
    updateTime: businessChanged ? now : current.updateTime,
  }).where(and(
    eq(workMemberCurrent.corpId, claim.corpId),
    eq(workMemberCurrent.id, current.id),
  )).returning({ id: workMemberCurrent.id });
  if (updated.length !== 1) projectionError("callback_member_current_update_lost");
  const aliasChanged = await finalizeMemberIdentityLineage(
    tx,
    claim,
    lineage,
    current.id,
    "DELETED",
    now,
  );
  return businessChanged || aliasChanged ? "applied" : "applied-noop";
}

function snapshotValues(
  snapshot: EnterpriseWechatMemberSnapshot,
  current: WorkMemberCurrent | null,
  seed: LegacySeed | null,
): Omit<WorkMemberCurrent, "id"> {
  const previous: Omit<WorkMemberCurrent, "id"> = current
    ? (({ id: _identity, ...values }) => values)(current)
    : {
        corpId: "",
        userid: "",
        canonicalUserid: "",
        lifecycleState: "ACTIVE" as const,
        legacyMemberId: seed?.id ?? null,
        uid: seed?.uid ?? null,
        name: null,
        position: seed?.position ?? null,
        mobile: seed?.mobile ?? null,
        gender: seed?.gender ?? null,
        email: seed?.email ?? null,
        bizMail: seed?.bizMail ?? null,
        directLeader: seed?.directLeader ?? null,
        avatar: seed?.avatar ?? null,
        thumbAvatar: seed?.thumbAvatar ?? null,
        telephone: seed?.telephone ?? null,
        alias: seed?.alias ?? null,
        enable: null,
        isLeader: null,
        hideMobile: seed?.hideMobile ?? null,
        address: seed?.address ?? null,
        openUserid: seed?.openUserid ?? null,
        mainDepartment: null,
        status: null,
        qrCode: seed?.qrCode ?? null,
        externalPosition: seed?.externalPosition ?? null,
        profileComplete: false,
        relationsComplete: false,
        deletedTime: null,
        lastEventId: null,
        lastEventKey: null,
        lastEventSubjectKeyHash: null,
        lastEventTime: 0,
        lastSequenceRank: 0,
        createTime: seed && seed.createTime > 0 ? seed.createTime : 0,
        updateTime: 0,
      };
  return {
    ...previous,
    name: snapshot.name,
    position: optionalValue(snapshot.position, previous.position),
    mobile: optionalValue(snapshot.mobile, previous.mobile),
    gender: optionalValue(snapshot.gender, previous.gender),
    email: optionalValue(snapshot.email, previous.email),
    bizMail: optionalValue(snapshot.bizMail, previous.bizMail),
    directLeader: optionalValue(snapshot.directLeader, previous.directLeader),
    avatar: optionalValue(snapshot.avatar, previous.avatar),
    thumbAvatar: optionalValue(snapshot.thumbAvatar, previous.thumbAvatar),
    telephone: optionalValue(snapshot.telephone, previous.telephone),
    alias: optionalValue(snapshot.alias, previous.alias),
    enable: snapshot.enable,
    isLeader: snapshot.isLeader,
    hideMobile: optionalValue(snapshot.hideMobile, previous.hideMobile),
    address: optionalValue(snapshot.address, previous.address),
    openUserid: optionalValue(snapshot.openUserid, previous.openUserid),
    mainDepartment: snapshot.mainDepartment,
    status: snapshot.status,
    qrCode: optionalValue(snapshot.qrCode, previous.qrCode),
    externalPosition: optionalValue(snapshot.externalPosition, previous.externalPosition),
    profileComplete: snapshot.profileComplete,
    relationsComplete: true,
    deletedTime: null,
  };
}

const BUSINESS_MEMBER_FIELDS = [
  "userid", "canonicalUserid", "lifecycleState", "legacyMemberId", "uid", "name",
  "position", "mobile", "gender", "email", "bizMail", "directLeader", "avatar",
  "thumbAvatar", "telephone", "alias", "enable", "isLeader", "hideMobile",
  "address", "openUserid", "mainDepartment", "status", "qrCode", "externalPosition",
  "profileComplete", "relationsComplete", "deletedTime",
] as const satisfies readonly (keyof WorkMemberCurrent)[];

function memberBusinessChanged(current: WorkMemberCurrent, next: Omit<WorkMemberCurrent, "id">): boolean {
  return BUSINESS_MEMBER_FIELDS.some((field) => !sameValue(current[field], next[field]));
}

async function applySnapshot(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  projection: Extract<PreparedMemberProjection, { kind: "snapshot" }>,
  aliases: WorkMemberIdentityAlias[],
  identities: string[],
  now: number,
): Promise<MemberCurrentProjectionResult> {
  let targetAlias = aliases.find((candidate) => candidate.userid === projection.targetUserid);
  if (!targetAlias) projectionError("callback_member_seen_fence_missing");
  const lineage = memberIdentityLineage(
    aliases,
    projection.targetUserid,
    projection.renamed ? projection.previousUserid : undefined,
  );
  const effectivePreviousUserid = lineage[0] ?? projection.previousUserid;
  const previousAlias = aliases.find((candidate) => candidate.userid === effectivePreviousUserid);
  if (!previousAlias) projectionError("callback_member_seen_fence_missing");
  if (!projection.renamed && targetAlias.lifecycleState === "RENAMED") return "superseded";

  const consolidation = await consolidateMemberCurrentComponent(
    tx,
    claim,
    aliases,
    identities,
    lineage,
    now,
    false,
  );
  let current = consolidation.current;
  if (consolidation.merged) {
    aliases = await lockedAliases(tx, claim, identities);
    targetAlias = aliases.find((candidate) => candidate.userid === projection.targetUserid);
    if (!targetAlias) projectionError("callback_member_seen_fence_missing");
  }
  let seed: LegacySeed | null = null;
  if (!current) {
    const targetSeed = await legacySeed(tx, claim.corpId, projection.targetUserid);
    const previousSeed = effectivePreviousUserid !== projection.targetUserid
      ? await legacySeed(tx, claim.corpId, effectivePreviousUserid)
      : targetSeed;
    if (targetSeed && previousSeed && targetSeed.id !== previousSeed.id) {
      projectionError("callback_member_legacy_rename_conflict");
    }
    seed = targetSeed ?? previousSeed;
  }
  if (!current && seed) {
    const linkedRows = await tx.select().from(workMemberCurrent).where(
      eq(workMemberCurrent.legacyMemberId, seed.id),
    ).limit(2).for("update");
    if (linkedRows.length > 1) projectionError("callback_member_legacy_link_ambiguous");
    if (linkedRows[0]) {
      if (
        linkedRows[0].corpId !== claim.corpId
        || !identities.includes(linkedRows[0].userid)
      ) projectionError("callback_member_legacy_link_conflict");
      current = linkedRows[0];
      seed = null;
    }
  }
  if (current && currentFenceIsNewer(current, claim)) return "superseded";
  const activeAliases = current
    ? await tx.select().from(workMemberIdentityAlias).where(and(
        eq(workMemberIdentityAlias.corpId, claim.corpId),
        eq(workMemberIdentityAlias.memberId, current.id),
        eq(workMemberIdentityAlias.lifecycleState, "ACTIVE"),
      )).limit(2).for("update")
    : [];
  if (
    activeAliases.length > 1
    || (activeAliases[0] && !lineage.includes(activeAliases[0].userid))
  ) projectionError("callback_member_active_alias_conflict");

  const nextBase = snapshotValues(projection.snapshot, current, seed);
  const next = {
    ...nextBase,
    corpId: claim.corpId,
    userid: projection.targetUserid,
    canonicalUserid: projection.targetUserid,
    lifecycleState: "ACTIVE" as const,
    legacyMemberId: current?.legacyMemberId ?? seed?.id ?? null,
    uid: current?.uid ?? seed?.uid ?? null,
    lastEventId: claim.eventId,
    lastEventKey: claim.eventKey,
    lastEventSubjectKeyHash: claim.subjectKeyHash,
    lastEventTime: claim.eventTime,
    lastSequenceRank: claim.sequenceRank,
    createTime: current?.createTime ?? (seed && seed.createTime > 0 ? seed.createTime : now),
    updateTime: now,
  };

  let memberChanged = true;
  if (!current) {
    const inserted = await tx.insert(workMemberCurrent).values(next).returning({
      id: workMemberCurrent.id,
    });
    if (inserted.length !== 1) projectionError("callback_member_current_insert_failed");
    const insertedId = inserted[0]?.id;
    if (!insertedId) projectionError("callback_member_current_insert_failed");
    const rows = await tx.select().from(workMemberCurrent).where(and(
      eq(workMemberCurrent.corpId, claim.corpId),
      eq(workMemberCurrent.id, insertedId),
    )).limit(1).for("update");
    current = rows[0] ?? null;
    if (!current) projectionError("callback_member_current_insert_failed");
  } else {
    memberChanged = memberBusinessChanged(current, next);
    const updated = await tx.update(workMemberCurrent).set({
      ...next,
      updateTime: memberChanged ? now : current.updateTime,
    }).where(and(
      eq(workMemberCurrent.corpId, claim.corpId),
      eq(workMemberCurrent.id, current.id),
    )).returning({ id: workMemberCurrent.id });
    if (updated.length !== 1) projectionError("callback_member_current_update_lost");
  }

  const memberId = current.id;
  const currentRelationRows = await tx.select({
    departmentId: workMemberRelationCurrent.departmentId,
    sortOrder: workMemberRelationCurrent.sortOrder,
    isLeaderInDepartment: workMemberRelationCurrent.isLeaderInDept,
  }).from(workMemberRelationCurrent).where(and(
    eq(workMemberRelationCurrent.corpId, claim.corpId),
    eq(workMemberRelationCurrent.memberId, memberId),
  )).orderBy(asc(workMemberRelationCurrent.departmentId)).for("update");
  const desiredRelations = sortedRelations(projection.snapshot);
  const relationChanged = !sameRelations(currentRelationRows, desiredRelations);
  if (relationChanged) {
    await tx.delete(workMemberRelationCurrent).where(and(
      eq(workMemberRelationCurrent.corpId, claim.corpId),
      eq(workMemberRelationCurrent.memberId, memberId),
    ));
    await tx.insert(workMemberRelationCurrent).values(desiredRelations.map((relation) => ({
      corpId: claim.corpId,
      memberId,
      departmentId: relation.departmentId,
      sortOrder: relation.sortOrder,
      isLeaderInDept: relation.isLeaderInDepartment,
      createTime: now,
      updateTime: now,
    })));
  }

  const otherRows = await tx.select().from(workMemberOtherCurrent).where(and(
    eq(workMemberOtherCurrent.corpId, claim.corpId),
    eq(workMemberOtherCurrent.memberId, memberId),
  )).limit(1).for("update");
  const other = otherRows[0];
  const nextExtattr = projection.snapshot.extattr === undefined
    ? other?.extattr ?? seed?.extattr ?? null
    : projection.snapshot.extattr;
  const nextExternalProfile = projection.snapshot.externalProfile === undefined
    ? other?.externalProfile ?? seed?.externalProfile ?? null
    : projection.snapshot.externalProfile;
  const otherChanged = (other?.extattr ?? null) !== nextExtattr
    || (other?.externalProfile ?? null) !== nextExternalProfile;
  if (other) {
    if (otherChanged) {
      const updated = await tx.update(workMemberOtherCurrent).set({
        extattr: nextExtattr,
        externalProfile: nextExternalProfile,
        updateTime: now,
      }).where(and(
        eq(workMemberOtherCurrent.corpId, claim.corpId),
        eq(workMemberOtherCurrent.memberId, memberId),
      )).returning({ memberId: workMemberOtherCurrent.memberId });
      if (updated.length !== 1) projectionError("callback_member_other_update_lost");
    }
  } else if (nextExtattr !== null || nextExternalProfile !== null) {
    await tx.insert(workMemberOtherCurrent).values({
      corpId: claim.corpId,
      memberId,
      extattr: nextExtattr,
      externalProfile: nextExternalProfile,
      updateTime: now,
    });
  }

  const aliasChanged = await finalizeMemberIdentityLineage(
    tx,
    claim,
    lineage,
    current.id,
    "ACTIVE",
    now,
  );
  return memberChanged || relationChanged || otherChanged || aliasChanged
    ? "applied"
    : "applied-noop";
}

/** Phase 3: call only inside the already-fenced callback final transaction. */
export async function applyMemberCurrentProjection(
  tx: DbClient,
  claim: MemberProjectionFenceClaim,
  projection: PreparedMemberProjection,
  now: number,
  suppressBusiness = false,
): Promise<MemberCurrentProjectionResult> {
  const identities = await lockMemberProjectionIdentities(tx, claim);
  let aliases = await lockedAliases(tx, claim, identities);
  if (aliases.length !== identities.length) projectionError("callback_member_seen_fence_missing");
  const lineage = memberIdentityLineage(
    aliases,
    projection.targetUserid,
    projection.renamed ? projection.previousUserid : undefined,
  );
  const incoming = claimFence(claim);
  const relevantUserids = new Set([
    projection.targetUserid,
    ...(projection.renamed ? [projection.previousUserid] : []),
  ]);
  const relevantAliasIsNewer = aliases.some((alias) =>
    relevantUserids.has(alias.userid)
      && compareMemberProjectionFence(storedFence(alias), incoming) > 0);
  const staleLineage = memberIdentityLineageIsStale(aliases, lineage);
  const rows = await currentCandidates(tx, claim, aliases, identities);
  const targetCurrent = rows.find((row) => row.userid === projection.targetUserid);
  const targetCurrentIsNewer = targetCurrent
    ? compareMemberProjectionFence(storedFence(targetCurrent), incoming) > 0
    : false;
  if (suppressBusiness || relevantAliasIsNewer || targetCurrentIsNewer || staleLineage) {
    // A target-first applied update/delete is authoritative business state, but
    // an older rename still proves identity continuity. Move that newer state
    // onto the oldest stable ID and resolve aliases without applying the stale
    // provider response. A latest-seen-only target remains UNRESOLVED until its
    // own provider attempt succeeds.
    if (!staleLineage && lineage.length > 1 && targetCurrentIsNewer) {
      const consolidation = await consolidateMemberCurrentComponent(
        tx,
        claim,
        aliases,
        identities,
        lineage,
        now,
        true,
      );
      if (consolidation.merged) aliases = await lockedAliases(tx, claim, identities);
      const reconciled = consolidation.current;
      if (reconciled && reconciled.userid === projection.targetUserid) {
        await finalizeMemberIdentityLineage(
          tx,
          claim,
          lineage,
          reconciled.id,
          reconciled.lifecycleState,
          now,
        );
      }
    }
    return "superseded";
  }
  if (projection.kind === "not_found" || projection.kind === "incomplete") {
    return "refresh-required";
  }
  if (projection.kind === "absent") {
    return applyAbsent(tx, claim, projection, aliases, identities, now);
  }
  return applySnapshot(tx, claim, projection, aliases, identities, now);
}
