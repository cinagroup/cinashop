import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import {
  workClientCurrent,
  workClientFollowCurrent,
  workClientFollowProjectionFence,
  workClientFollowTagCurrent,
  workClientProjectionFence,
  type WorkClientCurrent,
} from "@/models/schema";
import {
  clientProjectionIdentity,
  EnterpriseWechatClientProjectionError,
  type ClientProjectionClaim,
  type EnterpriseWechatClientFollowSnapshot,
  type PreparedClientProjection,
} from "@/services/work/EnterpriseWechatClientProjection";
import {
  compareMemberProjectionFence,
} from "@/services/work/EnterpriseWechatMemberCurrentService";

export type ClientProjectionApplyResult =
  | "applied"
  | "applied-noop"
  | "refresh-required"
  | "superseded";

interface ProjectionFence {
  eventTime: number;
  sequenceRank: number;
  eventId: number;
}

const WRITE_BATCH_SIZE = 200;

function projectionError(code: string, terminal = true): never {
  throw new EnterpriseWechatClientProjectionError(code, terminal);
}

function incomingFence(claim: ClientProjectionClaim): ProjectionFence {
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

function exactFence(
  row: {
    lastEventId: number | null;
    lastEventKey: string | null;
    lastEventSubjectKeyHash: string | null;
    lastEventTime: number;
    lastSequenceRank: number;
  },
  claim: ClientProjectionClaim,
): boolean {
  return row.lastEventId === claim.eventId
    && row.lastEventKey === claim.eventKey
    && row.lastEventSubjectKeyHash === claim.subjectKeyHash
    && row.lastEventTime === claim.eventTime
    && row.lastSequenceRank === claim.sequenceRank;
}

function sameStoredFence(
  left: {
    lastEventId: number | null;
    lastEventKey: string | null;
    lastEventSubjectKeyHash: string | null;
    lastEventTime: number;
    lastSequenceRank: number;
  },
  right: {
    lastEventId: number | null;
    lastEventKey: string | null;
    lastEventSubjectKeyHash: string | null;
    lastEventTime: number;
    lastSequenceRank: number;
  },
): boolean {
  return left.lastEventId === right.lastEventId
    && left.lastEventKey === right.lastEventKey
    && left.lastEventSubjectKeyHash === right.lastEventSubjectKeyHash
    && left.lastEventTime === right.lastEventTime
    && left.lastSequenceRank === right.lastSequenceRank;
}

function appliedEvent(claim: ClientProjectionClaim) {
  return {
    lastEventId: claim.eventId,
    lastEventKey: claim.eventKey,
    lastEventSubjectKeyHash: claim.subjectKeyHash,
    lastEventTime: claim.eventTime,
    lastSequenceRank: claim.sequenceRank,
  };
}

function chunks<T>(values: T[], size = WRITE_BATCH_SIZE): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

export async function lockClientProjectionIdentity(
  tx: DbClient,
  corpId: string,
  externalUserid: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`work-client:${corpId}:${externalUserid}`}, 0)
  )`);
}

async function ensureClientIdentity(
  tx: DbClient,
  claim: ClientProjectionClaim,
  externalUserid: string,
  now: number,
): Promise<number> {
  await tx.insert(workClientCurrent).values({
    corpId: claim.corpId,
    externalUserid,
    lifecycleState: "UNRESOLVED",
    profileComplete: false,
    providerSnapshotComplete: false,
    createTime: now,
    updateTime: now,
  }).onConflictDoNothing();
  const rows = await tx.select({ id: workClientCurrent.id }).from(workClientCurrent).where(and(
    eq(workClientCurrent.corpId, claim.corpId),
    eq(workClientCurrent.externalUserid, externalUserid),
  )).limit(2).for("update");
  if (rows.length !== 1) projectionError("callback_client_identity_ambiguous");
  return rows[0].id;
}

/**
 * Phase 1 latest-seen fence. This short transaction commits before provider
 * I/O. Parked add/edit events therefore suppress an older late response while
 * leaving the current business projection visibly unresolved.
 */
export async function recordClientProjectionSeen(
  tx: DbClient,
  claim: ClientProjectionClaim,
  now: number,
): Promise<"ready" | "superseded"> {
  const { externalUserid, userid } = clientProjectionIdentity(claim);
  await lockClientProjectionIdentity(tx, claim.corpId, externalUserid);
  const clientId = await ensureClientIdentity(tx, claim, externalUserid, now);

  // Direct callback authority is relationship-scoped. A newer callback for B
  // must never suppress an older-but-unseen callback for A.
  const directRows = await tx.select().from(workClientFollowProjectionFence).where(and(
    eq(workClientFollowProjectionFence.corpId, claim.corpId),
    eq(workClientFollowProjectionFence.clientId, clientId),
    eq(workClientFollowProjectionFence.userid, userid),
  )).limit(1).for("update");
  const direct = directRows[0];
  if (direct) {
    const comparison = compareMemberProjectionFence(rowFence(direct), incomingFence(claim));
    if (comparison > 0) return "superseded";
    if (comparison === 0) {
      if (!exactFence(direct, claim)) projectionError("callback_client_direct_fence_conflict");
    } else {
      const updated = await tx.update(workClientFollowProjectionFence).set({
        ...appliedEvent(claim),
        updateTime: now,
      }).where(and(
        eq(workClientFollowProjectionFence.corpId, claim.corpId),
        eq(workClientFollowProjectionFence.clientId, clientId),
        eq(workClientFollowProjectionFence.userid, userid),
        eq(workClientFollowProjectionFence.lastEventId, direct.lastEventId),
      )).returning({ userid: workClientFollowProjectionFence.userid });
      if (updated.length !== 1) projectionError("callback_client_direct_fence_lost");
    }
  } else {
    const inserted = await tx.insert(workClientFollowProjectionFence).values({
      corpId: claim.corpId,
      clientId,
      userid,
      ...appliedEvent(claim),
      createTime: now,
      updateTime: now,
    }).onConflictDoNothing().returning({ userid: workClientFollowProjectionFence.userid });
    if (inserted.length !== 1) projectionError("callback_client_direct_fence_conflict");
  }

  // Only provider-backed add/edit events compete for the client-wide profile
  // snapshot slot. Deletes are direct relationship facts, not profile writes.
  if (claim.changeType !== "add_external_contact" && claim.changeType !== "edit_external_contact") {
    return "ready";
  }
  const profileRows = await tx.select().from(workClientProjectionFence).where(and(
    eq(workClientProjectionFence.corpId, claim.corpId),
    eq(workClientProjectionFence.externalUserid, externalUserid),
  )).limit(1).for("update");
  const profile = profileRows[0];
  if (profile) {
    const comparison = compareMemberProjectionFence(rowFence(profile), incomingFence(claim));
    if (comparison < 0) {
      const updated = await tx.update(workClientProjectionFence).set({
        ...appliedEvent(claim),
        updateTime: now,
      }).where(and(
        eq(workClientProjectionFence.corpId, claim.corpId),
        eq(workClientProjectionFence.externalUserid, externalUserid),
        eq(workClientProjectionFence.lastEventId, profile.lastEventId),
      )).returning({ externalUserid: workClientProjectionFence.externalUserid });
      if (updated.length !== 1) projectionError("callback_client_seen_fence_lost");
      claim.clientProfileFenceEventIdAtFetch = claim.eventId;
    } else if (comparison === 0 && !exactFence(profile, claim)) {
      projectionError("callback_client_seen_fence_conflict");
    } else {
      claim.clientProfileFenceEventIdAtFetch = profile.lastEventId;
    }
  } else {
    const inserted = await tx.insert(workClientProjectionFence).values({
      corpId: claim.corpId,
      externalUserid,
      ...appliedEvent(claim),
      createTime: now,
      updateTime: now,
    }).onConflictDoNothing().returning({ externalUserid: workClientProjectionFence.externalUserid });
    if (inserted.length !== 1) projectionError("callback_client_seen_fence_conflict");
    claim.clientProfileFenceEventIdAtFetch = claim.eventId;
  }
  return "ready";
}

function assertCurrentNotAhead(
  current: WorkClientCurrent,
  claim: ClientProjectionClaim,
): void {
  const comparison = compareMemberProjectionFence(rowFence(current), incomingFence(claim));
  if (comparison > 0) projectionError("callback_client_current_ahead_of_seen_fence");
  if (comparison === 0 && !exactFence(current, claim)) {
    projectionError("callback_client_current_fence_conflict");
  }
}

async function replaceFollowTags(
  tx: DbClient,
  claim: ClientProjectionClaim,
  clientId: number,
  follows: EnterpriseWechatClientFollowSnapshot[],
  now: number,
): Promise<void> {
  for (const useridBatch of chunks(follows.map((follow) => follow.userid))) {
    await tx.delete(workClientFollowTagCurrent).where(and(
      eq(workClientFollowTagCurrent.corpId, claim.corpId),
      eq(workClientFollowTagCurrent.clientId, clientId),
      inArray(workClientFollowTagCurrent.userid, useridBatch),
    ));
  }
  const tagRows = follows.flatMap((follow) => follow.tags.map((tag) => ({
    corpId: claim.corpId,
    clientId,
    userid: follow.userid,
    tagKeyHash: tag.tagKeyHash,
    tagId: tag.tagId,
    groupName: tag.groupName,
    tagName: tag.tagName,
    type: tag.type,
    sortOrder: tag.sortOrder,
    createTime: now,
    updateTime: now,
  })));
  for (const tagBatch of chunks(tagRows)) {
    const inserted = await tx.insert(workClientFollowTagCurrent).values(tagBatch).returning({
      tagKeyHash: workClientFollowTagCurrent.tagKeyHash,
    });
    if (inserted.length !== tagBatch.length) {
      projectionError("callback_client_tag_replace_lost");
    }
  }
}

async function upsertActiveFollows(
  tx: DbClient,
  claim: ClientProjectionClaim,
  clientId: number,
  follows: EnterpriseWechatClientFollowSnapshot[],
  sourceKind: "DIRECT" | "SNAPSHOT",
  now: number,
): Promise<void> {
  const event = appliedEvent(claim);
  const values = follows.map((follow) => ({
    corpId: claim.corpId,
    clientId,
    userid: follow.userid,
    lifecycleState: "ACTIVE" as const,
    sourceKind,
    profileComplete: true,
    tagsComplete: true,
    remark: follow.remark,
    description: follow.description,
    followCreatedTime: follow.followCreatedTime,
    remarkCorpName: follow.remarkCorpName,
    remarkMobiles: JSON.stringify(follow.remarkMobiles),
    addWay: follow.addWay,
    operUserid: follow.operUserid,
    state: follow.state,
    ...event,
    createTime: now,
    updateTime: now,
    deletedTime: null,
  }));
  for (const followBatch of chunks(values)) {
    const rows = await tx.insert(workClientFollowCurrent).values(followBatch).onConflictDoUpdate({
      target: [
        workClientFollowCurrent.corpId,
        workClientFollowCurrent.clientId,
        workClientFollowCurrent.userid,
      ],
      set: {
        lifecycleState: "ACTIVE",
        sourceKind,
        profileComplete: true,
        tagsComplete: true,
        remark: sql`excluded.remark`,
        description: sql`excluded.description`,
        followCreatedTime: sql`excluded.follow_created_time`,
        remarkCorpName: sql`excluded.remark_corp_name`,
        remarkMobiles: sql`excluded.remark_mobiles`,
        addWay: sql`excluded.add_way`,
        operUserid: sql`excluded.oper_userid`,
        state: sql`excluded.state`,
        lastEventId: claim.eventId,
        lastEventKey: claim.eventKey,
        lastEventSubjectKeyHash: claim.subjectKeyHash,
        lastEventTime: claim.eventTime,
        lastSequenceRank: claim.sequenceRank,
        updateTime: now,
        deletedTime: null,
      },
    }).returning({ userid: workClientFollowCurrent.userid });
    if (rows.length !== followBatch.length) {
      projectionError("callback_client_follow_upsert_lost");
    }
  }
}

async function refreshActiveFollowsPreservingDirectFence(
  tx: DbClient,
  claim: ClientProjectionClaim,
  clientId: number,
  follows: EnterpriseWechatClientFollowSnapshot[],
  now: number,
): Promise<void> {
  for (const followBatch of chunks(follows)) {
    const values = sql.join(followBatch.map((follow) => sql`(
      ${follow.userid}::varchar,
      ${follow.remark}::varchar,
      ${follow.description}::varchar,
      ${follow.followCreatedTime}::integer,
      ${follow.remarkCorpName}::varchar,
      ${JSON.stringify(follow.remarkMobiles)}::text,
      ${follow.addWay}::integer,
      ${follow.operUserid}::varchar,
      ${follow.state}::varchar
    )`), sql`, `);
    const result = await tx.execute(sql`
      UPDATE work_client_follow_current AS current_row
      SET
        profile_complete = true,
        tags_complete = true,
        remark = snapshot.remark,
        description = snapshot.description,
        follow_created_time = snapshot.follow_created_time,
        remark_corp_name = snapshot.remark_corp_name,
        remark_mobiles = snapshot.remark_mobiles,
        add_way = snapshot.add_way,
        oper_userid = snapshot.oper_userid,
        state = snapshot.state,
        update_time = ${now}
      FROM (VALUES ${values}) AS snapshot(
        userid, remark, description, follow_created_time, remark_corp_name,
        remark_mobiles, add_way, oper_userid, state
      )
      WHERE current_row.corp_id = ${claim.corpId}
        AND current_row.client_id = ${clientId}
        AND current_row.userid = snapshot.userid
        AND current_row.lifecycle_state = 'ACTIVE'
      RETURNING current_row.userid
    `);
    if (result.length !== followBatch.length) {
      projectionError("callback_client_follow_refresh_lost");
    }
  }
}

async function applyClientSnapshot(
  tx: DbClient,
  claim: ClientProjectionClaim,
  current: WorkClientCurrent,
  prepared: Extract<PreparedClientProjection, { kind: "snapshot" }>,
  fullProfileApply: boolean,
  directFences: Map<string, {
    lastEventId: number;
    lastEventKey: string;
    lastEventSubjectKeyHash: string;
    lastEventTime: number;
    lastSequenceRank: number;
  }>,
  now: number,
): Promise<ClientProjectionApplyResult> {
  if (fullProfileApply) {
    assertCurrentNotAhead(current, claim);
    if (exactFence(current, claim)) return "applied-noop";
  }
  const snapshot = prepared.snapshot;
  if (snapshot.externalUserid !== current.externalUserid) {
    projectionError("callback_client_snapshot_identity_mismatch");
  }

  const existing = await tx.select().from(workClientFollowCurrent).where(and(
    eq(workClientFollowCurrent.corpId, claim.corpId),
    eq(workClientFollowCurrent.clientId, current.id),
  )).orderBy(asc(workClientFollowCurrent.userid)).for("update");
  const existingByUserid = new Map(existing.map((follow) => [follow.userid, follow]));
  const provenanceWrites: EnterpriseWechatClientFollowSnapshot[] = [];
  const directFenceRefreshes: EnterpriseWechatClientFollowSnapshot[] = [];
  for (const follow of snapshot.follows) {
    const stored = existingByUserid.get(follow.userid);
    if (follow.userid !== prepared.callbackUserid && !fullProfileApply) continue;
    // A snapshot triggered by employee B may refresh employee A only while A
    // remains active. It must not revive A's callback-authoritative tombstone.
    if (stored?.lifecycleState === "DELETED" && follow.userid !== prepared.callbackUserid) {
      continue;
    }
    if (follow.userid === prepared.callbackUserid) {
      provenanceWrites.push(follow);
      continue;
    }
    const direct = directFences.get(follow.userid);
    if (!direct) {
      // No direct callback has ever been seen for this employee. A fully
      // exhausted provider response may introduce or refresh the ACTIVE edge,
      // and its provenance is this snapshot event.
      provenanceWrites.push(follow);
      continue;
    }
    // A non-target edge with direct authority is refreshable only when that
    // authority has already been applied exactly and is strictly older in
    // wall-clock time. Preserve its direct event tuple during the refresh.
    if (
      !stored
      || stored.lifecycleState !== "ACTIVE"
      || !sameStoredFence(stored, direct)
      || direct.lastEventTime >= claim.eventTime
    ) continue;
    directFenceRefreshes.push(follow);
  }
  if (!provenanceWrites.some((follow) => follow.userid === prepared.callbackUserid)) {
    projectionError("callback_client_callback_follow_missing", false);
  }

  const targetWrites = provenanceWrites.filter(
    (follow) => follow.userid === prepared.callbackUserid,
  );
  const snapshotWrites = provenanceWrites.filter(
    (follow) => follow.userid !== prepared.callbackUserid,
  );
  await upsertActiveFollows(tx, claim, current.id, targetWrites, "DIRECT", now);
  await upsertActiveFollows(tx, claim, current.id, snapshotWrites, "SNAPSHOT", now);
  await refreshActiveFollowsPreservingDirectFence(
    tx,
    claim,
    current.id,
    directFenceRefreshes,
    now,
  );
  await replaceFollowTags(
    tx,
    claim,
    current.id,
    [...provenanceWrites, ...directFenceRefreshes],
    now,
  );

  const activeRows = await tx.select({ userid: workClientFollowCurrent.userid })
    .from(workClientFollowCurrent)
    .where(and(
      eq(workClientFollowCurrent.corpId, claim.corpId),
      eq(workClientFollowCurrent.clientId, current.id),
      eq(workClientFollowCurrent.lifecycleState, "ACTIVE"),
    )).limit(1);
  if (activeRows.length !== 1) projectionError("callback_client_active_follow_missing");

  const clientValues = fullProfileApply
    ? {
        lifecycleState: "ACTIVE" as const,
        profileComplete: true,
        providerSnapshotComplete: true,
        name: snapshot.name,
        avatar: snapshot.avatar,
        type: snapshot.type,
        gender: snapshot.gender,
        unionid: snapshot.unionid,
        position: snapshot.position,
        corpName: snapshot.corpName,
        corpFullName: snapshot.corpFullName,
        externalProfile: snapshot.externalProfile,
        ...appliedEvent(claim),
        updateTime: now,
        inactiveTime: null,
      }
    : current.profileComplete && current.providerSnapshotComplete
      ? {
          lifecycleState: "ACTIVE" as const,
          updateTime: now,
          inactiveTime: null,
        }
      : { updateTime: now };
  const updated = await tx.update(workClientCurrent).set(clientValues).where(and(
    eq(workClientCurrent.corpId, claim.corpId),
    eq(workClientCurrent.id, current.id),
  )).returning({ id: workClientCurrent.id });
  if (updated.length !== 1) projectionError("callback_client_snapshot_update_lost");
  return "applied";
}

async function applyClientFollowDelete(
  tx: DbClient,
  claim: ClientProjectionClaim,
  current: WorkClientCurrent,
  userid: string,
  now: number,
): Promise<ClientProjectionApplyResult> {
  const existing = (await tx.select().from(workClientFollowCurrent).where(and(
    eq(workClientFollowCurrent.corpId, claim.corpId),
    eq(workClientFollowCurrent.clientId, current.id),
    eq(workClientFollowCurrent.userid, userid),
  )).limit(1).for("update"))[0];
  if (existing && exactFence(existing, claim)) return "applied-noop";
  const alreadyDeleted = existing?.lifecycleState === "DELETED";

  if (existing) {
    const updated = await tx.update(workClientFollowCurrent).set({
      lifecycleState: "DELETED",
      sourceKind: "DIRECT",
      tagsComplete: false,
      ...appliedEvent(claim),
      updateTime: now,
      deletedTime: existing.deletedTime ?? now,
    }).where(and(
      eq(workClientFollowCurrent.corpId, claim.corpId),
      eq(workClientFollowCurrent.clientId, current.id),
      eq(workClientFollowCurrent.userid, userid),
    )).returning({ userid: workClientFollowCurrent.userid });
    if (updated.length !== 1) projectionError("callback_client_follow_delete_lost");
  } else {
    const inserted = await tx.insert(workClientFollowCurrent).values({
      corpId: claim.corpId,
      clientId: current.id,
      userid,
      lifecycleState: "DELETED",
      sourceKind: "DIRECT",
      profileComplete: false,
      tagsComplete: false,
      ...appliedEvent(claim),
      createTime: now,
      updateTime: now,
      deletedTime: now,
    }).onConflictDoNothing().returning({ userid: workClientFollowCurrent.userid });
    if (inserted.length !== 1) projectionError("callback_client_follow_delete_conflict");
  }
  await tx.delete(workClientFollowTagCurrent).where(and(
    eq(workClientFollowTagCurrent.corpId, claim.corpId),
    eq(workClientFollowTagCurrent.clientId, current.id),
    eq(workClientFollowTagCurrent.userid, userid),
  ));

  const active = await tx.select({ userid: workClientFollowCurrent.userid })
    .from(workClientFollowCurrent)
    .where(and(
      eq(workClientFollowCurrent.corpId, claim.corpId),
      eq(workClientFollowCurrent.clientId, current.id),
      eq(workClientFollowCurrent.lifecycleState, "ACTIVE"),
    )).limit(1);
  const lifecycleState = current.profileComplete && current.providerSnapshotComplete
    ? active.length > 0 ? "ACTIVE" as const : "INACTIVE" as const
    : "UNRESOLVED" as const;
  const updatedClient = await tx.update(workClientCurrent).set({
    lifecycleState,
    updateTime: now,
    inactiveTime: lifecycleState === "INACTIVE" ? current.inactiveTime ?? now : null,
  }).where(and(
    eq(workClientCurrent.corpId, claim.corpId),
    eq(workClientCurrent.id, current.id),
  )).returning({ id: workClientCurrent.id });
  if (updatedClient.length !== 1) projectionError("callback_client_delete_state_lost");
  return alreadyDeleted ? "applied-noop" : "applied";
}

/** Phase 3: exact latest-seen recheck and one atomic current-state apply. */
export async function applyClientCurrentProjection(
  tx: DbClient,
  claim: ClientProjectionClaim,
  prepared: PreparedClientProjection,
  now: number,
): Promise<ClientProjectionApplyResult> {
  const identity = clientProjectionIdentity(claim);
  if (prepared.externalUserid !== identity.externalUserid) {
    projectionError("callback_client_projection_identity_mismatch");
  }
  await lockClientProjectionIdentity(tx, claim.corpId, identity.externalUserid);
  const current = (await tx.select().from(workClientCurrent).where(and(
    eq(workClientCurrent.corpId, claim.corpId),
    eq(workClientCurrent.externalUserid, identity.externalUserid),
  )).limit(1).for("update"))[0];
  if (!current) projectionError("callback_client_current_missing");
  const directRows = await tx.select().from(workClientFollowProjectionFence).where(and(
    eq(workClientFollowProjectionFence.corpId, claim.corpId),
    eq(workClientFollowProjectionFence.clientId, current.id),
    eq(workClientFollowProjectionFence.userid, identity.userid),
  )).limit(1).for("update");
  const direct = directRows[0];
  if (!direct) projectionError("callback_client_direct_fence_missing");
  const directComparison = compareMemberProjectionFence(rowFence(direct), incomingFence(claim));
  if (directComparison > 0) return "superseded";
  if (directComparison < 0 || !exactFence(direct, claim)) {
    projectionError("callback_client_direct_fence_conflict");
  }
  if (prepared.kind === "not_found" || prepared.kind === "incomplete") {
    return "refresh-required";
  }
  if (prepared.kind === "absent") {
    if (prepared.userid !== identity.userid) {
      projectionError("callback_client_follow_identity_mismatch");
    }
    return applyClientFollowDelete(tx, claim, current, prepared.userid, now);
  }
  if (prepared.callbackUserid !== identity.userid) {
    projectionError("callback_client_follow_identity_mismatch");
  }
  const profileRows = await tx.select().from(workClientProjectionFence).where(and(
    eq(workClientProjectionFence.corpId, claim.corpId),
    eq(workClientProjectionFence.externalUserid, identity.externalUserid),
  )).limit(1).for("update");
  const profile = profileRows[0];
  if (!profile) projectionError("callback_client_seen_fence_missing");
  if (claim.clientProfileFenceEventIdAtFetch === undefined) {
    projectionError("callback_client_fetch_fence_missing");
  }
  if (profile.lastEventId !== claim.clientProfileFenceEventIdAtFetch) {
    // A provider response that crossed a newer profile phase-1 fence may be
    // stale even when this relationship's direct event remains applicable.
    // Retry so the response is fetched after the newer fence is observable.
    projectionError("callback_client_snapshot_drift", false);
  }
  const profileComparison = compareMemberProjectionFence(rowFence(profile), incomingFence(claim));
  if (profileComparison < 0) projectionError("callback_client_seen_fence_conflict");
  if (profileComparison === 0 && !exactFence(profile, claim)) {
    projectionError("callback_client_seen_fence_conflict");
  }
  const fullProfileApply = profileComparison === 0;
  const allDirectRows = fullProfileApply
    ? await tx.select().from(workClientFollowProjectionFence).where(and(
        eq(workClientFollowProjectionFence.corpId, claim.corpId),
        eq(workClientFollowProjectionFence.clientId, current.id),
      )).orderBy(asc(workClientFollowProjectionFence.userid)).for("update")
    : directRows;
  const directFences = new Map(allDirectRows.map((row) => [row.userid, row]));
  return applyClientSnapshot(
    tx,
    claim,
    current,
    prepared,
    fullProfileApply,
    directFences,
    now,
  );
}

export async function auditClientProjectionRows(
  tx: DbClient,
  corpId: string,
  externalUserids: string[],
) {
  const identities = [...new Set(externalUserids)].sort();
  if (identities.length === 0) {
    return { clients: [], fences: [], directFences: [], follows: [], tags: [] };
  }
  const clients = await tx.select().from(workClientCurrent).where(and(
    eq(workClientCurrent.corpId, corpId),
    inArray(workClientCurrent.externalUserid, identities),
  )).orderBy(asc(workClientCurrent.externalUserid));
  const fences = await tx.select().from(workClientProjectionFence).where(and(
    eq(workClientProjectionFence.corpId, corpId),
    inArray(workClientProjectionFence.externalUserid, identities),
  )).orderBy(asc(workClientProjectionFence.externalUserid));
  const clientIds = clients.map((client) => client.id);
  if (clientIds.length === 0) {
    return { clients, fences, directFences: [], follows: [], tags: [] };
  }
  const directFences = await tx.select().from(workClientFollowProjectionFence).where(and(
    eq(workClientFollowProjectionFence.corpId, corpId),
    inArray(workClientFollowProjectionFence.clientId, clientIds),
  )).orderBy(
    asc(workClientFollowProjectionFence.clientId),
    asc(workClientFollowProjectionFence.userid),
  );
  const follows = await tx.select().from(workClientFollowCurrent).where(and(
    eq(workClientFollowCurrent.corpId, corpId),
    inArray(workClientFollowCurrent.clientId, clientIds),
  )).orderBy(asc(workClientFollowCurrent.clientId), asc(workClientFollowCurrent.userid));
  const tags = await tx.select().from(workClientFollowTagCurrent).where(and(
    eq(workClientFollowTagCurrent.corpId, corpId),
    inArray(workClientFollowTagCurrent.clientId, clientIds),
  )).orderBy(
    asc(workClientFollowTagCurrent.clientId),
    asc(workClientFollowTagCurrent.userid),
    asc(workClientFollowTagCurrent.sortOrder),
  );
  return { clients, fences, directFences, follows, tags };
}
