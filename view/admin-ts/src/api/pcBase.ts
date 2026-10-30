import request, { getData } from '@/utils/request';
import { PC_BASE_KEYS, isPcBaseConfigKey, normalizePcBaseReplacement, pcBaseImage, pcBaseRequestId, pcBaseRevision,
  type PcBaseSnapshot, type PcBaseReceipt } from '../../../common/pcBase';
import { parsePcBaseIntentSave, type PcBaseIntentSave } from '../../../common/pcBaseIntent';
const base = '/config/pc';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(row => !('value' in row) || !row.enumerable)) throw Error('PC配置响应须为JSON对象');
  return value as Record<string, unknown>;
}
function only(row: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw Error('PC配置响应字段不完整或包含未知字段');
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 2147483647) throw Error('PC配置响应数字无效');
  return value;
}
/** Author references and display tickets are separate contracts. This only
 * accepts an exact server-supplied ticket for the same canonical ID; it never
 * strips a ticket into a new author reference or proves attachment ownership. */
export function checkedPcBasePreview(source: string, value: unknown): string {
  if (typeof value !== 'string' || [...value].length > 8192) throw Error('PC图片预览格式无效');
  pcBaseImage(source);
  if (!value) return '';
  if (/^\/api\/assets\/[1-9]\d*$/u.test(source)) {
    const match = /^(\/api\/assets\/[1-9]\d{0,9})\?expires=([1-9]\d{0,15})&signature=([A-Za-z0-9_-]{43})$/u.exec(value);
    if (!match || match[1] !== source || (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) > Number.MAX_SAFE_INTEGER / 1000)) throw Error('PC图片预览没有匹配原素材');
  } else if (value !== source) throw Error('PC公开图片预览引用不一致');
  return value;
}
export function pcBasePreviewDeadline(value: string): number | null {
  const match = /^\/api\/assets\/[1-9]\d{0,9}\?expires=([1-9]\d{0,15})&signature=[A-Za-z0-9_-]{43}$/u.exec(value);
  return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) <= Number.MAX_SAFE_INTEGER / 1000 ? Number(match[1]) * 1000 : null;
}
export function checkedPcBaseSnapshot(value: unknown): PcBaseSnapshot {
  const row = object(value); only(row, ['settings','fields','revision','runtime_ready','issues','asset_previews']);
  if (!pcBaseRevision(row.revision) || typeof row.runtime_ready !== 'boolean') throw Error('PC配置版本或保存能力响应无效');
  const settings = object(row.settings), fields = object(row.fields), previews = object(row.asset_previews);
  only(settings, PC_BASE_KEYS); only(fields, PC_BASE_KEYS);
  const safe = {} as PcBaseSnapshot['settings'], states = {} as PcBaseSnapshot['fields'];
  for (const key of PC_BASE_KEYS) {
    const field = object(fields[key]); only(field, ['present','parseable','redacted']);
    if (![field.present, field.parseable, field.redacted].every(flag => typeof flag === 'boolean')
      || !field.present && (field.parseable || field.redacted || settings[key] !== null)
      || settings[key] !== null && (!field.present || !field.parseable || field.redacted)) throw Error('PC字段状态与安全投影不一致');
    Object.assign(safe, { [key]: settings[key] === null ? null : normalizePcBaseReplacement(key, settings[key]) });
    Object.assign(states, { [key]: { present: field.present, parseable: field.parseable, redacted: field.redacted } });
  }
  if (!Array.isArray(row.issues) || row.issues.length > 128) throw Error('PC历史配置问题列表无效');
  const issues = row.issues.map(value => {
    const issue = object(value); only(issue, ['key','code','message']);
    if (!isPcBaseConfigKey(issue.key) || !['missing','invalid','duplicate','capacity','metadata'].includes(issue.code as string)
      || typeof issue.message !== 'string' || issue.message.length > 1000) throw Error('PC历史配置问题格式无效');
    return { key: issue.key, code: issue.code, message: issue.message } as PcBaseSnapshot['issues'][number];
  });
  if (Object.keys(previews).length > 5001) throw Error('PC图片预览数量无效');
  const asset_previews: Record<string, string> = {};
  for (const [slot, preview] of Object.entries(previews)) {
    let source: string | null = null;
    if (slot === 'pc_logo') source = safe.pc_logo;
    else {
      const match = /^filing_list\.(0|[1-9]\d{0,3})\.icon$/u.exec(slot);
      if (match && safe.filing_list && Number(match[1]) < safe.filing_list.length) source = safe.filing_list[Number(match[1])].icon;
    }
    if (source === null) throw Error('PC图片预览槽位没有匹配安全字段');
    asset_previews[slot] = checkedPcBasePreview(source, preview);
  }
  return { settings: safe, fields: states, revision: row.revision, runtime_ready: row.runtime_ready, issues, asset_previews };
}
export function checkedPcBaseReceipt(value: unknown, id: string, actor: number): PcBaseReceipt {
  const row = object(value); only(row, ['request_id','actor_id','state','revision','created_at','replayed','cache_status']);
  if (!pcBaseRequestId(id) || row.request_id !== id || integer(row.actor_id, 1) !== actor || !pcBaseRevision(row.revision)
    || row.state !== 'committed' && row.state !== 'not_applied' || typeof row.replayed !== 'boolean'
    || !['cleared','pending','not_required'].includes(row.cache_status as string)
    || row.state === 'not_applied' && row.cache_status !== 'not_required'
    || typeof row.created_at !== 'number' || !Number.isSafeInteger(row.created_at) || row.created_at <= 0) throw Error('PC配置回执身份或终态无效');
  return row as unknown as PcBaseReceipt;
}
function operationId(id: string) { if (!pcBaseRequestId(id)) throw Error('PC配置请求标识无效'); return id; }
export const apiPcBase = (signal?: AbortSignal) => getData<unknown>(request.get(base, { signal })).then(checkedPcBaseSnapshot);
export const apiSavePcBase = (input: PcBaseIntentSave, signal?: AbortSignal) => getData<unknown>(request.post(base, parsePcBaseIntentSave(input), { signal }));
export const apiPcBaseReceipt = (id: string, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/operations/${operationId(id)}`, { signal }));
export const apiResolvePcBase = (id: string, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/operations/${operationId(id)}/resolve`, { confirmed: true }, { signal }));

function text(value: unknown, max: number) { if (typeof value !== "string" || value.length > max) throw Error("PC图库响应文本无效"); return value; }
export interface PcBaseCategory { id: number; pid: number; name: string }
export interface PcBaseImage { att_id: number; pid: number; real_name: string; reference: string; preview: string }
export function checkedPcBaseCategories(value: unknown): PcBaseCategory[] {
  const row = object(value); only(row, ['list']); if (!Array.isArray(row.list) || row.list.length > 5000) throw Error('图库分类不完整');
  const seen = new Set<number>(); return row.list.map(value => { const item = object(value); only(item, ['id', 'pid', 'name']); const id = integer(item.id, 1); if (seen.has(id)) throw Error('图库分类重复'); seen.add(id); return { id, pid: integer(item.pid), name: text(item.name, 255) }; });
}
export function checkedPcBaseImages(value: unknown, query: { page: number; limit: number; pid: number }) {
  const row = object(value); only(row, ['list', 'count', 'page', 'limit']); const count = integer(row.count);
  if (count > 5000 || row.page !== query.page || row.limit !== query.limit || !Array.isArray(row.list) || row.list.length !== Math.max(0, Math.min(query.limit, count - (query.page - 1) * query.limit))) throw Error('图库分页目录不完整');
  const ids = new Set<number>(); const list = row.list.map(value => { const item = object(value); only(item, ['att_id', 'pid', 'real_name', 'reference', 'preview']); const id = integer(item.att_id, 1), pid = integer(item.pid);
    if (ids.has(id) || pid !== query.pid || item.reference !== `/api/assets/${id}`) throw Error('图库稳定引用身份无效'); ids.add(id);
    const preview = checkedPcBasePreview(item.reference as string, item.preview); if (!preview.startsWith(item.reference + '?') || !preview) throw Error('图库签名预览与稳定引用不一致');
    return { att_id: id, pid, real_name: text(item.real_name, 255), reference: item.reference as string, preview };
  }); return { list, count };
}
export const apiPcBaseAttachmentCategories = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-categories`, { signal }));
export const apiPcBaseAttachmentOptions = (params: { page: number; limit: number; pid: number; name: string }, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-options`, { params, signal }));
