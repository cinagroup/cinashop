/** Recoverable platform product-assurance author. Status is a separate action;
 * the underlying catalog has no soft-delete field. */
export const ENSURE_FIELDS = ['name', 'image', 'desc', 'sort'] as const;
export type EnsureOperation = 'create' | 'update' | 'status' | 'delete';
export interface EnsureValues { name: string; image: string; desc: string; sort: number }
export type EnsurePayload = EnsureValues;
export interface EnsureRow extends EnsureValues { id: number; type: number; relation_id: number; status: number; add_time: number; product_count: number; image_preview: string }
export interface EnsureCatalog { list: EnsureRow[]; count: number; revision: string; write_ready: boolean; can_create: boolean }
export interface EnsureAction { operation_id: string; actor_id: number; operation: EnsureOperation; target_id: number; revision: string; payload: Record<string, unknown>; payload_hash: string }
export interface EnsureReceipt extends Omit<EnsureAction, 'payload'> { state: 'committed' | 'not_applied'; result: { id: number; created: number; updated: number; count: number; revision: string } }
export function ensureObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品保障数据须为对象'); return value as Record<string, unknown>; }
export function ensureOnly(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw Error('商品保障字段不完整或包含未知字段'); }
export function ensureInteger(value: unknown, min = 0, max = 2147483647): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw Error('商品保障整数参数无效'); return value; }
export function ensureText(value: unknown, max = 255): string { if (typeof value !== 'string' || [...value].length > max) throw Error('商品保障文本参数无效'); return value; }
export function ensureUuid(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw Error('商品保障操作标识须为小写UUIDv4'); return value; }
export function ensureHash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('商品保障版本或摘要无效'); return value; }
export function ensureOperation(value: unknown): EnsureOperation { if (typeof value !== 'string' || !['create', 'update', 'status', 'delete'].includes(value)) throw Error('商品保障操作类型无效'); return value as EnsureOperation; }
/** Parsing retains raw input for the canonical hash; per-field mutation rules
 * apply separately against the exact stored original. */
export function ensureValues(value: unknown): EnsureValues { const row = ensureObject(value); ensureOnly(row, ENSURE_FIELDS); return { name: ensureText(row.name, 4096), image: ensureText(row.image, 4096), desc: ensureText(row.desc, 4096), sort: ensureInteger(row.sort, -2147483648) }; }
export function newEnsureValues(row?: EnsureRow): EnsureValues { return { name: row?.name ?? '', image: row?.image ?? '', desc: row?.desc ?? '', sort: row?.sort ?? 0 }; }
function authoredText(value: unknown, original: string | undefined, max: number, label: string): string {
 const raw = ensureText(value, 4096); if (original !== undefined && raw === original) return ensureText(raw, 255);
 const normalized = raw.trim();
 if (!normalized || [...normalized].length > max || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(raw)) throw Error(`请输入${max}个字符以内的有效${label}，不可包含控制字符或不完整字符`);
 return normalized;
}
export function ensureName(value: unknown, original?: string): string { return authoredText(value, original, 100, '保障条款'); }
export function ensureDescription(value: unknown, original?: string): string {
 const raw = ensureText(value, 4096); if (original !== undefined && raw === original) return ensureText(raw, 255);
 const normalized = raw.trim();
 if (!normalized || [...normalized].length > 255 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(raw)) throw Error('请输入255个字符以内的有效内容描述');
 return normalized;
}
export function ensureSort(value: unknown, original?: number): number { const sort = ensureInteger(value, -2147483648); if (original !== undefined && sort === original) return sort; return ensureInteger(sort); }
export function ensureImage(value: unknown, original?: string): string {
 const raw = ensureText(value, 4096); if (original !== undefined && raw === original) return ensureText(raw, 255);
 const match = /^\/api\/assets\/([1-9]\d*)$/u.exec(raw);
 if (!match || Number(match[1]) > 2147483647 || !Number.isSafeInteger(Number(match[1]))) throw Error('请选择当前图库中的稳定图片，不能保存预览票据或外部新地址');
 return raw;
}
export function ensurePayload(operation: EnsureOperation, value: unknown): Record<string, unknown> {
 const row = ensureObject(value);
 if (operation === 'delete') { ensureOnly(row, []); return {}; }
 if (operation === 'status') { ensureOnly(row, ['status']); return { status: ensureInteger(row.status, 0, 1) }; }
 return { ...ensureValues(row) };
}
export function ensureAction(value: unknown, actor: number): EnsureAction {
 const row = ensureObject(value); ensureOnly(row, ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload', 'payload_hash']); const operation = ensureOperation(row.operation), target_id = ensureInteger(row.target_id);
 if (row.actor_id !== actor || operation === 'create' && target_id !== 0 || operation !== 'create' && target_id === 0) throw Error('原商品保障操作归属或目标不一致');
 return { operation_id: ensureUuid(row.operation_id), actor_id: ensureInteger(row.actor_id, 1), operation, target_id, revision: ensureHash(row.revision), payload: ensurePayload(operation, row.payload), payload_hash: ensureHash(row.payload_hash) };
}
export function ensureCanonical(action: Omit<EnsureAction, 'payload_hash'>) { return { domain: 'product-ensure-author-v1', actor_id: action.actor_id, operation_id: action.operation_id, operation: action.operation, target_id: action.target_id, revision: action.revision, payload: ensurePayload(action.operation, action.payload) }; }
export async function ensurePayloadHash(action: Omit<EnsureAction, 'payload_hash'>): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ensureCanonical(action)))); return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''); }
export function ensureReceipt(value: unknown, action: EnsureAction): EnsureReceipt {
 const row = ensureObject(value); ensureOnly(row, ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload_hash', 'state', 'result']);
 for (const key of ['operation_id', 'actor_id', 'operation', 'target_id', 'revision', 'payload_hash'] as const) if (row[key] !== action[key]) throw Error('商品保障回执与原操作不一致');
 if (row.state !== 'committed' && row.state !== 'not_applied') throw Error('商品保障操作结果仍未知');
 const result = ensureObject(row.result); ensureOnly(result, ['id', 'created', 'updated', 'count', 'revision']);
 const checked = { id: ensureInteger(result.id), created: ensureInteger(result.created, 0, 1), updated: ensureInteger(result.updated, 0, 1), count: ensureInteger(result.count, 0, 20000), revision: ensureHash(result.revision) };
 if (row.state === 'not_applied' ? checked.id !== action.target_id || checked.created !== 0 || checked.updated !== 0 || checked.count !== 0 || checked.revision !== action.revision : action.operation === 'create' ? checked.id < 1 || checked.created !== 1 || checked.updated !== 0 : checked.id !== action.target_id || checked.created !== 0 || checked.updated !== 1) throw Error('商品保障回执终态与原操作矛盾');
 return { operation_id: action.operation_id, actor_id: action.actor_id, operation: action.operation, target_id: action.target_id, revision: action.revision, payload_hash: action.payload_hash, state: row.state, result: checked };
}
export function ensurePreview(value: unknown): string {
 const raw = ensureText(value, 4096); if (!raw) return raw;
 if (/[\s\u0000-\u001f\u007f-\u009f\\]/u.test(raw)) throw Error('商品保障预览地址无效');
 if (/^\/(?!\/)/u.test(raw)) return raw;
 try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password && url.hostname) return raw; } catch { /* No unsafe display URL. */ }
 throw Error('商品保障预览地址无效');
}
export function ensureCatalog(value: unknown): EnsureCatalog {
 const row = ensureObject(value); ensureOnly(row, ['list', 'count', 'revision', 'write_ready', 'can_create']);
 if (!Array.isArray(row.list) || row.list.length > 20000 || row.count !== row.list.length || typeof row.write_ready !== 'boolean' || typeof row.can_create !== 'boolean') throw Error('商品保障完整目录无效');
 const ids = new Set<number>(), list = row.list.map(value => {
  const item = ensureObject(value); ensureOnly(item, ['id', 'type', 'relation_id', 'name', 'image', 'desc', 'sort', 'status', 'add_time', 'product_count', 'image_preview']); const id = ensureInteger(item.id, 1);
  if (ids.has(id) || item.type !== 0 || item.relation_id !== 0) throw Error('商品保障目录重复或不属于当前平台'); ids.add(id);
  return { id, type: 0, relation_id: 0, name: ensureText(item.name), image: ensureText(item.image), desc: ensureText(item.desc), sort: ensureInteger(item.sort, -2147483648), status: ensureInteger(item.status, -32768, 32767), add_time: ensureInteger(item.add_time, -2147483648), product_count: ensureInteger(item.product_count), image_preview: ensurePreview(item.image_preview) };
 });
 if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16 * 1024 * 1024) throw Error('商品保障目录超过完整读取容量');
 return { list, count: list.length, revision: ensureHash(row.revision), write_ready: row.write_ready, can_create: row.can_create };
}
