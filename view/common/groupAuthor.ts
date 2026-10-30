/** Mall user-group author. Names remain raw until the server applies a new or changed value. */
export const GROUP_FIELDS = ['group_name'] as const;
export type GroupOperation = 'create' | 'update' | 'delete';
export interface GroupValues { group_name: string }
export type GroupPayload = GroupValues;
export interface GroupRow extends GroupValues { id: number }
export interface GroupCatalog { list: GroupRow[]; count: number; revision: string; write_ready: boolean }
export interface GroupAction { operation_id: string; actor_id: number; operation: GroupOperation; target_id: number; revision: string; payload: Record<string, unknown>; payload_hash: string }
export interface GroupReceipt extends Omit<GroupAction, 'payload'> { state: 'committed' | 'not_applied'; result: { id: number; created: number; updated: number; count: number; revision: string } }
export function groupObject(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('用户分组数据须为对象'); return v as Record<string, unknown>; }
export function groupOnly(v: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw Error('用户分组字段不完整或包含未知字段'); }
export function groupInteger(v: unknown, min = 0, max = 2147483647): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw Error('用户分组整数参数无效'); return v; }
export function groupText(v: unknown, max = 64): string { if (typeof v !== 'string' || [...v].length > max) throw Error('用户分组文本参数无效'); return v; }
export function groupUuid(v: unknown): string { if (typeof v !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)) throw Error('用户分组操作标识须为小写UUIDv4'); return v; }
export function groupHash(v: unknown): string { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw Error('用户分组版本或摘要无效'); return v; }
export function groupOperation(v: unknown): GroupOperation { if (typeof v !== 'string' || !['create', 'update', 'delete'].includes(v)) throw Error('用户分组操作类型无效'); return v as GroupOperation; }
export function groupValues(v: unknown): GroupValues { const r = groupObject(v); groupOnly(r, GROUP_FIELDS); return { group_name: groupText(r.group_name, 4096) }; }
export function newGroupValues(row?: GroupRow): GroupPayload { return { group_name: row?.group_name ?? '' }; }
/** Identical historical names, including whitespace/control characters, can be preserved. */
export function groupName(value: unknown, original?: string): string {
 const raw = groupText(value, 4096); if (original !== undefined && raw === original) return raw;
 const normalized = raw.trim();
 if (!normalized || [...normalized].length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(raw) || /[\uD800-\uDFFF]/u.test(raw)) throw Error('请输入有效分组名称，不可包含控制字符或不完整字符');
 return normalized;
}
export function groupPayload(op: GroupOperation, value: unknown): Record<string, unknown> { const r = groupObject(value); if (op === 'delete') { groupOnly(r, []); return {}; } return { ...groupValues(r) }; }
export function groupAction(value: unknown, actor: number): GroupAction {
 const r = groupObject(value); groupOnly(r, ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload', 'payload_hash']);
 const operation = groupOperation(r.operation), target_id = groupInteger(r.target_id);
 if (r.actor_id !== actor || operation === 'create' && target_id !== 0 || operation !== 'create' && target_id === 0) throw Error('原分组操作归属或目标不一致');
 return { operation_id: groupUuid(r.operation_id), actor_id: groupInteger(r.actor_id, 1), operation, target_id, revision: groupHash(r.revision), payload: groupPayload(operation, r.payload), payload_hash: groupHash(r.payload_hash) };
}
export function groupCanonical(a: Omit<GroupAction, 'payload_hash'>) { return { domain: 'user-group-author-v1', actor_id: a.actor_id, operation_id: a.operation_id, operation: a.operation, target_id: a.target_id, revision: a.revision, payload: groupPayload(a.operation, a.payload) }; }
export async function groupPayloadHash(a: Omit<GroupAction, 'payload_hash'>): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(groupCanonical(a)))); return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join(''); }
export function groupReceipt(value: unknown, a: GroupAction): GroupReceipt {
 const r = groupObject(value); groupOnly(r, ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload_hash', 'state', 'result']);
 for (const k of ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload_hash'] as const) if (r[k] !== a[k]) throw Error('用户分组回执与原操作不一致');
 if (r.state !== 'committed' && r.state !== 'not_applied') throw Error('用户分组操作结果仍未知');
 const x = groupObject(r.result); groupOnly(x, ['id', 'created', 'updated', 'count', 'revision']);
 const result = { id: groupInteger(x.id), created: groupInteger(x.created, 0, 1), updated: groupInteger(x.updated, 0, 1), count: groupInteger(x.count, 0, 20000), revision: groupHash(x.revision) };
 if (r.state === 'not_applied' ? result.id !== a.target_id || result.created !== 0 || result.updated !== 0 || result.count !== 0 || result.revision !== a.revision : a.operation === 'create' ? result.id < 1 || result.created !== 1 || result.updated !== 0 : result.id !== a.target_id || result.created !== 0 || result.updated !== 1) throw Error('用户分组回执终态与原操作矛盾');
 return { operation_id: a.operation_id, actor_id: a.actor_id, operation: a.operation, target_id: a.target_id, revision: a.revision, payload_hash: a.payload_hash, state: r.state, result };
}
export function groupCatalog(value: unknown): GroupCatalog {
 const r = groupObject(value); groupOnly(r, ['list', 'count', 'revision', 'write_ready']);
 if (!Array.isArray(r.list) || r.list.length > 20000 || r.count !== r.list.length || typeof r.write_ready !== 'boolean') throw Error('用户分组完整目录无效');
 const seen = new Set<number>(), list = r.list.map(value => { const x = groupObject(value); groupOnly(x, ['id', 'group_name']); const id = groupInteger(x.id, 1); if (seen.has(id)) throw Error('用户分组目录重复'); seen.add(id); return { id, group_name: groupText(x.group_name) }; });
 return { list, count: list.length, revision: groupHash(r.revision), write_ready: r.write_ready };
}
