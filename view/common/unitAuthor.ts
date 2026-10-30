/** Platform product-unit author draft: name and sort only; not a status or product writer. */
export const UNIT_FIELDS = ['name', 'sort'] as const;
export type UnitOperation = 'create' | 'update' | 'delete';
export interface UnitValues { name: string; sort: number }
export type UnitPayload = UnitValues;
export interface UnitRow extends UnitValues { id: number; type: number; relation_id: number; status: number; is_del: number; add_time: number }
export interface UnitCatalog { list: UnitRow[]; count: number; revision: string; write_ready: boolean; can_create: boolean }
export interface UnitAction { operation_id: string; actor_id: number; operation: UnitOperation; target_id: number; revision: string; payload: Record<string, unknown>; payload_hash: string }
export interface UnitReceipt extends Omit<UnitAction, 'payload'> { state: 'committed' | 'not_applied'; result: { id: number; created: number; updated: number; count: number; revision: string } }
export function unitObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品单位数据须为对象'); return value as Record<string, unknown>; }
export function unitOnly(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw Error('商品单位字段不完整或包含未知字段'); }
export function unitInteger(value: unknown, min = 0, max = 2147483647): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw Error('商品单位整数参数无效'); return value; }
export function unitText(value: unknown, max = 50): string { if (typeof value !== 'string' || [...value].length > max) throw Error('商品单位文本参数无效'); return value; }
export function unitUuid(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw Error('商品单位操作标识须为小写UUIDv4'); return value; }
export function unitHash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('商品单位版本或摘要无效'); return value; }
export function unitOperation(value: unknown): UnitOperation { if (typeof value !== 'string' || !['create', 'update', 'delete'].includes(value)) throw Error('商品单位操作类型无效'); return value as UnitOperation; }
/** Payload parsing preserves signed historical sorts and raw names; mutation rules are separate. */
export function unitValues(value: unknown): UnitValues { const row = unitObject(value); unitOnly(row, UNIT_FIELDS); return { name: unitText(row.name, 4096), sort: unitInteger(row.sort, -32768, 32767) }; }
export function newUnitValues(row?: UnitRow): UnitPayload { return { name: row?.name ?? '', sort: row?.sort ?? 0 }; }
export function unitName(value: unknown, original?: string): string {
 const raw = unitText(value, 4096); if (original !== undefined && raw === original) return raw;
 const normalized = raw.trim();
 if (!normalized || [...normalized].length > 15 || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(raw)) throw Error('请输入15个字符以内的有效单位名称，不可包含控制字符或不完整字符');
 return normalized;
}
export function unitSort(value: unknown, original?: number): number { const sort = unitInteger(value, -32768, 32767); if (original !== undefined && sort === original) return sort; return unitInteger(sort, 0, 32767); }
export function unitPayload(operation: UnitOperation, value: unknown): Record<string, unknown> { const row = unitObject(value); if (operation === 'delete') { unitOnly(row, []); return {}; } return { ...unitValues(row) }; }
export function unitAction(value: unknown, actor: number): UnitAction {
 const row = unitObject(value); unitOnly(row, ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload', 'payload_hash']); const operation = unitOperation(row.operation), target_id = unitInteger(row.target_id);
 if (row.actor_id !== actor || operation === 'create' && target_id !== 0 || operation !== 'create' && target_id === 0) throw Error('原商品单位操作归属或目标不一致');
 return { operation_id: unitUuid(row.operation_id), actor_id: unitInteger(row.actor_id, 1), operation, target_id, revision: unitHash(row.revision), payload: unitPayload(operation, row.payload), payload_hash: unitHash(row.payload_hash) };
}
export function unitCanonical(action: Omit<UnitAction, 'payload_hash'>) { return { domain: 'product-unit-author-v1', actor_id: action.actor_id, operation_id: action.operation_id, operation: action.operation, target_id: action.target_id, revision: action.revision, payload: unitPayload(action.operation, action.payload) }; }
export async function unitPayloadHash(action: Omit<UnitAction, 'payload_hash'>): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(unitCanonical(action)))); return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''); }
export function unitReceipt(value: unknown, action: UnitAction): UnitReceipt {
 const row = unitObject(value); unitOnly(row, ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload_hash', 'state', 'result']);
 for (const key of ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload_hash'] as const) if (row[key] !== action[key]) throw Error('商品单位回执与原操作不一致');
 if (row.state !== 'committed' && row.state !== 'not_applied') throw Error('商品单位操作结果仍未知');
 const result = unitObject(row.result); unitOnly(result, ['id', 'created', 'updated', 'count', 'revision']);
 const checked = { id: unitInteger(result.id), created: unitInteger(result.created, 0, 1), updated: unitInteger(result.updated, 0, 1), count: unitInteger(result.count, 0, 20000), revision: unitHash(result.revision) };
 if (row.state === 'not_applied' ? checked.id !== action.target_id || checked.created !== 0 || checked.updated !== 0 || checked.count !== 0 || checked.revision !== action.revision : action.operation === 'create' ? checked.id < 1 || checked.created !== 1 || checked.updated !== 0 : checked.id !== action.target_id || checked.created !== 0 || checked.updated !== 1) throw Error('商品单位回执终态与原操作矛盾');
 return { operation_id: action.operation_id, actor_id: action.actor_id, operation: action.operation, target_id: action.target_id, revision: action.revision, payload_hash: action.payload_hash, state: row.state, result: checked };
}
export function unitCatalog(value: unknown): UnitCatalog {
 const row = unitObject(value); unitOnly(row, ['list', 'count', 'revision', 'write_ready', 'can_create']);
 if (!Array.isArray(row.list) || row.list.length > 20000 || row.count !== row.list.length || typeof row.write_ready !== 'boolean' || typeof row.can_create !== 'boolean') throw Error('商品单位完整目录无效');
 const ids = new Set<number>(), list = row.list.map(value => {
  const item = unitObject(value); unitOnly(item, ['id', 'type', 'relation_id', 'name', 'sort', 'status', 'is_del', 'add_time']); const id = unitInteger(item.id, 1);
  if (ids.has(id) || item.type !== 0 || item.relation_id !== 0 || item.status !== 1 || item.is_del !== 0) throw Error('商品单位目录重复或不属于当前平台有效目录'); ids.add(id);
  return { id, type: 0, relation_id: 0, name: unitText(item.name, 50), sort: unitInteger(item.sort, -32768, 32767), status: 1, is_del: 0, add_time: unitInteger(item.add_time, -2147483648) };
 });
 return { list, count: list.length, revision: unitHash(row.revision), write_ready: row.write_ready, can_create: row.can_create };
}
