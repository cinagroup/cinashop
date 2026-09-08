/** Durable identity of the participation actually consumed by this order.
 * Activity IDs and participation IDs are separate namespaces, never aliases here.
 */
export interface BargainOrderParticipation {
  version: 1;
  participantId: number;
  activityId: number;
  uid: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

/** Only a wholly absent field on EVERY valid cart snapshot permits legacy lookup.
 * Corrupt, unsupported or inconsistent new snapshots must not fall back to a guess.
 */
export function readBargainOrderParticipation(
  cartInfos: ReadonlyArray<{ cartInfo: string | null }>, uid: number, activityId: number,
): BargainOrderParticipation | null {
  const invalid = () => new Error("砍价订单参与快照无效或不一致，无法安全恢复资源");
  if (!cartInfos.length) throw invalid();
  let identity: BargainOrderParticipation | null = null;
  let missing = 0;
  for (const cart of cartInfos) {
    let snapshot: unknown;
    try { snapshot = JSON.parse(cart.cartInfo ?? ""); } catch { throw invalid(); }
    if (!object(snapshot)) throw invalid();
    if (!Object.prototype.hasOwnProperty.call(snapshot, "bargainParticipation")) {
      missing++;
      continue;
    }
    const value = snapshot.bargainParticipation;
    if (!object(value) || value.version !== 1 || !positiveId(value.participantId) ||
        !positiveId(value.activityId) || !positiveId(value.uid) || value.uid !== uid || value.activityId !== activityId) {
      throw invalid();
    }
    if (identity && identity.participantId !== value.participantId) throw invalid();
    identity = { version: 1, participantId: value.participantId, activityId: value.activityId, uid: value.uid };
  }
  if (identity && missing) throw invalid();
  return identity;
}
