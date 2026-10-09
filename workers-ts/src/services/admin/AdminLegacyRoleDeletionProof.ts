import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemRole } from '@/models/schema';
import { adminAuthorityOperation, type AdminLegacyDeletedRoleEvidence } from '@/models/schema/adminAuthorityOperation';
import { assertAdminLegacyRoleOperationReady, inspectAdminAuthorityOperation } from '@/migrations/adminAuthorityOperation';
import { HttpApiException, ServiceUnavailableException } from '@/utils/errors';

export type AdminLegacyRoleDeletedSnapshot = AdminLegacyDeletedRoleEvidence;
export interface AdminLegacyRoleReferenceHistory {
  roles: Array<typeof systemRole.$inferSelect>;
  deleted: Map<number, AdminLegacyRoleDeletedSnapshot>;
}
const conflict = () => new HttpApiException('角色缺失或删除耐久证据不完整，请核对管理员身份', 409, 409);
const id = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw conflict();
  return v as Record<string, unknown>;
}
function exactKeys(v: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(v).length !== fields.length || fields.some(f => !Object.hasOwn(v, f))) throw conflict();
}
/** Preserve the complete raw snapshot; never normalize away unknown tokens. */
export function parseAdminLegacyRoleDeletedSnapshot(value: unknown): AdminLegacyRoleDeletedSnapshot {
  const v = record(value);
  exactKeys(v, ['id','type','relation_id','role_name','rules','level','status']);
  if (!id(v.id) || (v.type !== 0 && v.type !== 1) || v.relation_id !== 0
    || typeof v.level !== 'number' || !Number.isInteger(v.level) || v.level < 1 || v.level > 10
    || (v.status !== 0 && v.status !== 1)
    || typeof v.role_name !== 'string' || [...v.role_name].length > 32 || controls.test(v.role_name)
    || typeof v.rules !== 'string' || v.rules.length > 16384 || controls.test(v.rules)) throw conflict();
  const rawTokens = v.rules.trim() === '' ? [] : v.rules.split(',').map(t => t.trim());
  const tokens = [...new Set(rawTokens)];
  if (rawTokens.some(t => !t) || tokens.length > 2048 || tokens.some(t => /^\d+$/.test(t)
    && (!/^[1-9]\d*$/.test(t) || t.length > 10 || !id(Number(t))))) throw conflict();
  return { id: v.id, type: v.type, relation_id: 0, role_name: v.role_name,
    rules: v.rules, level: v.level, status: v.status };
}
/** Only Admin-controlled decision/read transactions may call this: App has no
 * receipt SELECT grant. A row which still exists can never be reclassified as
 * deleted; an absent ID alone is never sufficient evidence. */
export async function loadAdminLegacyRoleDeletionProofs(tx: DbClient,
  requestedIds: readonly number[]): Promise<Map<number, AdminLegacyRoleDeletedSnapshot>> {
  const ids = [...new Set(requestedIds)].sort((a,b) => a-b), proofs = new Map<number, AdminLegacyRoleDeletedSnapshot>();
  if (!ids.length) return proofs;
  if (ids.length > 128 || ids.some(v => !id(v))) throw conflict();
  const existing = await tx.select({ id: systemRole.id }).from(systemRole).where(inArray(systemRole.id, ids)).limit(ids.length);
  if (existing.length) throw conflict();
  try { await assertAdminLegacyRoleOperationReady(tx); }
  catch (error) {
    // A valid older addon has no hard-delete evidence. Existing consumers must
    // retain their ordinary missing-reference conflict, without requiring v3
    // to reject an unknown ID. Drifted/v3-incomplete catalogs still report 503.
    if (error instanceof ServiceUnavailableException
      && (await inspectAdminAuthorityOperation(tx,undefined,'v1')
        || await inspectAdminAuthorityOperation(tx,undefined,'legacy-admin-v2'))) throw conflict();
    throw error;
  }
  // The fixed kind/state/realm plus immutable v3 receipt are the provenance.
  // Bounded ID strings avoid any cast of untrusted JSON into an SQL integer.
  const rows = await tx.select().from(adminAuthorityOperation).where(and(
    eq(adminAuthorityOperation.operation, 'legacy-role-delete'), eq(adminAuthorityOperation.state, 'committed'),
    eq(adminAuthorityOperation.adminType, 1), eq(adminAuthorityOperation.relationId, 0),
    sql`${adminAuthorityOperation.result}->>'id' IN (${sql.join(ids.map(value => sql`${String(value)}`), sql`,`)})`,
  )).orderBy(asc(adminAuthorityOperation.operationId)).limit(1001);
  if (rows.length > 1000) throw conflict();
  for (const row of rows) {
    const raw = record(row.result);
    if (!id(raw.id) || !ids.includes(raw.id)) continue;
    exactKeys(raw, ['id','deleted','deleted_role']);
    if (raw.deleted !== true || !id(row.actorId) || !id(row.createdAt)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.operationId)
      || !/^[a-f0-9]{64}$/.test(row.requestHash) || !/^[a-f0-9]{64}$/.test(row.revision)) throw conflict();
    const snapshot = parseAdminLegacyRoleDeletedSnapshot(raw.deleted_role);
    if (snapshot.id !== raw.id || proofs.has(snapshot.id)) throw conflict();
    proofs.set(snapshot.id, snapshot);
  }
  return proofs;
}

/** Complete persisted IDs are classified before active-role permission
 * resolution. Known inactive roles and proven hard-deleted roles grant nothing.
 * Unknown, foreign or malformed references remain a conflict. */
export async function loadAdminLegacyRoleReferenceHistory(tx: DbClient,
  requestedIds: readonly number[], level: number, strictExistingLevel = false): Promise<AdminLegacyRoleReferenceHistory> {
  const ids = [...new Set(requestedIds)].sort((a,b) => a-b);
  if (ids.length > 128 || ids.some(value => !id(value)) || !Number.isInteger(level) || level < 0 || level > 10) throw conflict();
  const roles = ids.length ? await tx.select().from(systemRole).where(inArray(systemRole.id, ids)).orderBy(asc(systemRole.id)) : [];
  for (const role of roles) {
    if ((role.type !== 0 && role.type !== 1) || role.relationId !== 0
      || !Number.isInteger(role.level) || role.level < 0 || role.level > 10
      || strictExistingLevel && role.level !== level || ![-1,0,1].includes(role.status)
      || typeof role.roleName !== 'string' || [...role.roleName].length > 32 || controls.test(role.roleName)
      || typeof role.rules !== 'string' || role.rules.length > 16384 || controls.test(role.rules)) throw conflict();
    const rawTokens=role.rules.trim() === '' ? [] : role.rules.split(',').map(value=>value.trim());
    const tokens=[...new Set(rawTokens)];
    if (rawTokens.some(value=>!value) || tokens.length > 2048 || tokens.some(value=>/^\d+$/.test(value)
      && (!/^[1-9]\d*$/.test(value) || value.length > 10 || !id(Number(value))))) throw conflict();
  }
  const existing=new Set(roles.map(role=>role.id)), missing=ids.filter(value=>!existing.has(value));
  const deleted=await loadAdminLegacyRoleDeletionProofs(tx,missing);
  if (deleted.size !== missing.length || [...deleted.values()].some(role=>role.level !== level)) throw conflict();
  return { roles, deleted };
}
