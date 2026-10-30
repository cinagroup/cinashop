/** PREPARATION ONLY: pure, server-side planning. No SQL, TX, authorization,
 * CAS, hash construction, provider call, receipt or display is implemented.
 * A future authorized service must build this handle from one fresh locked
 * DB snapshot, use the plan in that same TX, then release the handle finally.
 */
import {
  PC_BASE_KEYS, PC_BASE_MAX_BODY_BYTES, pcBaseRevision, serializePcBaseReplacement,
  type PcBaseKey,
} from '../../../../view/common/pcBase';
import { parsePcBaseIntentSave } from '../../../../view/common/pcBaseIntent';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';

/** Pure bounded text parser. The future HTTP adapter must additionally use
 * the bounded UTF-8 body reader before passing text here. This is no route. */
export function parsePcBaseIntentRequestText(text: string) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > PC_BASE_MAX_BODY_BYTES) throw Error('PC配置意图超过256KiB');
  let value: unknown;
  try { value = parseLevelActivationJson(text); }
  catch { throw Error('PC配置意图JSON格式无效、字段重复或层级过深'); }
  return parsePcBaseIntentSave(value);
}

declare const planningSnapshotBrand: unique symbol;
export type PcBasePlanningSnapshot = {
  readonly revision: string;
  readonly [planningSnapshotBrand]: true;
};
type StoredSnapshot = { readonly revision: string; readonly raw: Readonly<Record<PcBaseKey, string | null>> };
// Stored bytes remain server-local and are never returned in a plan/DTO.
const snapshots = new WeakMap<object, StoredSnapshot>();

/** SERVER INPUT ONLY. This constructor does not establish DB provenance:
 * never pass request JSON, browser raw_values or a KV entry to it. The service
 * must compute the revision over the same complete raw rows and metadata,
 * including missing/duplicate winners and xmin, while holding its TX fence.
 * null means the field has no row; preserving it must not insert a default.
 */
export function createPcBasePlanningSnapshot(revision: string, raw: Record<PcBaseKey, string | null>): PcBasePlanningSnapshot {
  if (!pcBaseRevision(revision) || !raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw Error('PC服务端快照无效');
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== PC_BASE_KEYS.length || keys.some(key => typeof key !== 'string' || !(PC_BASE_KEYS as readonly string[]).includes(key))) {
    throw Error('PC服务端快照须包含完整13字段');
  }
  const copy = {} as Record<PcBaseKey, string | null>;
  for (const key of PC_BASE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable
      || descriptor.value !== null && typeof descriptor.value !== 'string') throw Error('PC服务端原值快照无效');
    // No parse/stringify, URL validation, trimming or coercion on kept bytes.
    copy[key] = descriptor.value;
  }
  const handle = Object.freeze({ revision }) as PcBasePlanningSnapshot;
  snapshots.set(handle, { revision, raw: Object.freeze(copy) });
  return handle;
}
/** Required in the future service's transaction finally block. This handle
 * lifetime guard cannot itself prove that a caller opened a real transaction.
 */
export function releasePcBasePlanningSnapshot(handle: PcBasePlanningSnapshot): void {
  snapshots.delete(handle);
}
export type PcBaseIntentPlan = {
  readonly request_id: string;
  readonly revision: string;
  readonly kept: ReadonlyArray<Readonly<{ key: PcBaseKey; existed: boolean }>>;
  readonly writes: ReadonlyArray<Readonly<{ key: PcBaseKey; serialized_value: string }>>;
};
export function planPcBaseIntentSave(input: unknown, handle: PcBasePlanningSnapshot): PcBaseIntentPlan {
  const intent = parsePcBaseIntentSave(input);
  const snapshot = handle && typeof handle === 'object' ? snapshots.get(handle) : undefined;
  if (!snapshot) throw Error('PC服务端快照不存在或已失效');
  if (intent.revision !== snapshot.revision) throw Error('PC配置版本已变化，请重新读取');
  const kept: Array<Readonly<{ key: PcBaseKey; existed: boolean }>> = [];
  const writes: Array<Readonly<{ key: PcBaseKey; serialized_value: string }>> = [];
  for (const key of PC_BASE_KEYS) {
    const field = intent.fields[key];
    if (field.action === 'keep') {
      // No write for keep: exact stored bytes, NULL absence, metadata and
      // historical duplicate rows remain the future service's CAS subject.
      kept.push(Object.freeze({ key, existed: snapshot.raw[key] !== null }));
    } else writes.push(Object.freeze({ key, serialized_value: serializePcBaseReplacement(key, field.value) }));
  }
  // Does not return a merged value map: kept bytes are NOT newly validated
  // values and MUST NOT be passed to a public projector as rendering grants.
  return Object.freeze({ request_id: intent.request_id, revision: snapshot.revision,
    kept: Object.freeze(kept), writes: Object.freeze(writes) });
}
