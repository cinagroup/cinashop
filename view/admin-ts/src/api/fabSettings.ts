import axios from 'axios';
import request, { getData } from '@/utils/request';
import { pcBannerAssetReference, pcBannerPreview } from '@/api/pcBanner';
import { resolveRegisteredPageRoute } from '../../../uniapp-ts/src/config/navigation';

export interface FabButton { source_id: string | null; img: string; url: string }
export interface FabValues { is_show: 0 | 1; index: 1 | 2 | 3 | 4; shifting: number; main_ago_image: string; main_after_image: string; button: FabButton[] }
export interface FabReadButton { source_id: string | null; img: string | null; url: string | null }
export interface FabReadValues { is_show: 0 | 1 | null; index: FabValues['index'] | null; shifting: number | null; main_ago_image: string | null; main_after_image: string | null; button: FabReadButton[] }
export interface FabSnapshot { present: boolean; row: { id: number; status: number; is_show: number; is_del: number } | null; revision: string; values: FabReadValues | null; raw_values: Record<string, unknown> | null; editable: boolean; issues: string[]; image_previews: { main_ago_image: string; main_after_image: string; button: string[] } }
export interface FabWrite { request_id: string; revision: string; values: FabValues }
export interface FabReceipt { operation: 'update'; id: number; request_id: string; payload_hash: string }
export interface FabPending { version: 1; actor: number; id: number | null; input: FabWrite; fingerprint: string; baseline: FabReadButton[] }
export interface FabEditorButton extends Omit<FabButton, 'source_id'> { source_id: string | null; key: string; preview: string; unresolved: boolean; target_label?: string }
export interface FabEditor extends Omit<FabValues, 'is_show' | 'index' | 'button'> { is_show: FabValues['is_show'] | null; index: FabValues['index'] | null; button: FabEditorButton[] }
const fields = ['is_show', 'index', 'shifting', 'main_ago_image', 'main_after_image', 'button'];
const int = (value: unknown, min = 0, max = 2147483647): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('悬浮按钮数据格式错误'); return value as Record<string, unknown>; }
function exact(row: Record<string, unknown>, keys: string[]) { if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw Error('悬浮按钮字段不完整或包含额外字段'); }
function text(value: unknown, max: number, control = true): value is string { return typeof value === 'string' && [...value].length <= max && (!control || !/[\u0000-\u001f\u007f]/u.test(value)) && ![...value].some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; }); }
function trim(value: unknown, label: string, max: number): string { if (!text(value, max)) throw Error(`${label}无效或超过${max}字`); return value.trim(); }
function layers(value: string): string[] | null {
  let source = value; const found: string[] = [];
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(source) || /[\u0000-\u001f\u007f\\]/u.test(source)) return null;
    try {
      if (/^\/(?!\/)/u.test(source)) { if (!/^\/(?!\/)/u.test(new URL(source, 'https://fab.invalid').pathname)) return null; }
      else { const url = new URL(source); if (!/^https?:\/\//iu.test(source) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null; }
    } catch { return null; }
    found.push(source); if (!/%[a-f0-9]{2}/iu.test(source)) return found;
    if (depth === 3) return null; try { source = decodeURIComponent(source); } catch { return null; }
  }
  return found;
}
export function fabLinkSafe(value: unknown): value is string {
  if (!text(value, 2048) || !value || value !== value.trim()) return false;
  const marker = value.indexOf('@APPID=');
  if (marker >= 0) { const path = value.slice(0, marker), appId = value.slice(marker + 7); return value.indexOf('@APPID=', marker + 1) < 0 && /^wx[a-f0-9]{16}$/iu.test(appId) && miniPath(path); }
  if (!layers(value)) return false;
  if (/^https?:\/\//iu.test(value)) return true;
  if (value.includes('#')) return false;
  const split = value.indexOf('?'); return !!resolveRegisteredPageRoute(split < 0 ? value : value.slice(0, split), split < 0 ? '' : value.slice(split + 1));
}
function miniPath(value: string): boolean {
  let layer = value;
  for (let depth = 0; depth <= 3; depth++) {
    const page = layer.split('?', 1)[0];
    if (!layer || depth === 0 && /\s/u.test(layer) || /[\u0000-\u001f\u007f\\]/u.test(layer) || /^[a-z][a-z\d+.-]*:/iu.test(layer) || layer.startsWith('//') || layer.includes('#') || !/^\/?[a-z0-9_.%/-]+$/iu.test(page) || page.split('/').some(part => part === '.' || part === '..')) return false;
    try { const parsed = new URL(layer, 'https://fab.invalid/'); if (parsed.origin !== 'https://fab.invalid' || !/^\/(?!\/)/u.test(parsed.pathname)) return false; } catch { return false; }
    if (!/%[a-f0-9]{2}/iu.test(layer)) return true;
    if (depth === 3) return false; try { layer = decodeURIComponent(layer); } catch { return false; }
  }
  return false;
}
export const fabPreview = pcBannerPreview;
export function normalizeFabValues(value: unknown): FabValues {
  const row = object(value); exact(row, fields);
  if (!flag(row.is_show) || !int(row.index, 1, 4) || !int(row.shifting, 0, 100)) throw Error('显示、样式或纵向位置无效');
  const before = trim(row.main_ago_image, '展开前图片', 255), after = trim(row.main_after_image, '展开后图片', 255);
  if (row.index < 3 && (!pcBannerAssetReference(before) || after !== '') || row.index === 3 && (!pcBannerAssetReference(before) || !pcBannerAssetReference(after)) || row.index === 4 && (before !== '' || after !== '')) throw Error('请按当前样式选择稳定主图，不能保存临时签名地址');
  if (!Array.isArray(row.button) || row.button.length > 5 || row.index >= 3 && row.button.length < 3) throw Error(row.index >= 3 ? '圆弧样式须有3至5个按钮' : '最多设置5个按钮');
  const button = row.button.map((value, index) => { const item = object(value); exact(item, ['source_id', 'img', 'url']);
    if (item.source_id !== null && !digest(item.source_id)) throw Error('请核对原按钮附加设置的保留方式');
    const img = trim(item.img, `按钮${index + 1}图片`, 255), url = trim(item.url, `按钮${index + 1}链接`, 2048);
    if (!pcBannerAssetReference(img)) throw Error(`按钮${index + 1}须选择稳定图片，不能保存签名预览`);
    if (!fabLinkSafe(url)) throw Error(`按钮${index + 1}链接不安全或尚未登记，请选择有效页面、HTTP(S)网页或外部小程序`);
    return { source_id: item.source_id, img, url };
  });
  const existing = button.map(item => item.source_id).filter(value => value !== null); if (new Set(existing).size !== existing.length) throw Error('同一个原按钮附加设置只能保留一次');
  return { is_show: row.is_show, index: row.index as FabValues['index'], shifting: row.shifting, main_ago_image: before, main_after_image: after, button };
}
export function normalizeFabWrite(value: unknown): FabWrite { const row = object(value); exact(row, ['request_id', 'revision', 'values']); if (!uuid(row.request_id) || !digest(row.revision)) throw Error('悬浮按钮请求标识或版本无效'); return { request_id: row.request_id, revision: row.revision, values: normalizeFabValues(row.values) }; }
export function fabCanonical(value: FabWrite) { const input = normalizeFabWrite(value); return { operation: 'update', revision: input.revision, values: input.values }; }
export async function fabFingerprint(value: FabWrite): Promise<string> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fabCanonical(value)))); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function readButtons(value: unknown): FabReadButton[] { if (!Array.isArray(value) || value.length > 100) throw Error('历史按钮数量或结构无效'); const rows = value.map(value => { const item = object(value); exact(item, ['source_id', 'img', 'url']); if (item.source_id !== null && !digest(item.source_id) || item.img !== null && !text(item.img, 10000, false) || item.url !== null && !text(item.url, 10000, false)) throw Error('历史按钮字段不完整'); return item as unknown as FabReadButton; }); const sources = rows.map(row => row.source_id).filter(item => item !== null); if (new Set(sources).size !== sources.length) throw Error('历史按钮来源重复'); return rows; }
export function parseFabSnapshot(value: unknown): FabSnapshot {
  const row = object(value);
  if (new TextEncoder().encode(JSON.stringify(row)).length > 3 * 1024 * 1024 || typeof row.present !== 'boolean' || typeof row.editable !== 'boolean' || !digest(row.revision) || !Array.isArray(row.issues) || row.issues.length > 1000 || row.issues.some(issue => !text(issue, 1000))) throw Error('悬浮按钮响应不完整或超过读取范围');
  if (row.row !== null) { const record = object(row.row); exact(record, ['id', 'status', 'is_show', 'is_del']); if (!int(record.id, 1) || ['status', 'is_show', 'is_del'].some(key => !int(record[key], -2147483648))) throw Error('悬浮配置记录不完整'); }
  if (!row.present && row.row !== null || row.present && row.editable && row.row === null) throw Error('悬浮配置存在状态不一致');
  if (row.values !== null) { const values = object(row.values); exact(values, fields); if (values.is_show !== null && !flag(values.is_show) || values.index !== null && !int(values.index, 1, 4) || values.shifting !== null && !int(values.shifting, 0, 100) || ['main_ago_image', 'main_after_image'].some(key => values[key] !== null && !text(values[key], 10000, false))) throw Error('悬浮配置字段不完整'); readButtons(values.button); }
  if (row.raw_values !== null) exact(object(row.raw_values), fields);
  if (row.editable && row.values === null) throw Error('可编辑悬浮配置缺少字段');
  const previews = object(row.image_previews); exact(previews, ['main_ago_image', 'main_after_image', 'button']); if (!text(previews.main_ago_image, 8192) || !text(previews.main_after_image, 8192) || !Array.isArray(previews.button) || previews.button.length > 100 || previews.button.some(item => !text(item, 8192)) || row.values !== null && previews.button.length !== (row.values as FabReadValues).button.length) throw Error('悬浮图片预览不完整');
  return row as unknown as FabSnapshot;
}
export function parseFabReceipt(value: unknown, requestId: string): FabReceipt { const row = object(value); if (row.operation !== 'update' || !int(row.id, 1) || row.request_id !== requestId || !uuid(row.request_id) || !digest(row.payload_hash)) throw Error('悬浮按钮回执不完整'); return row as unknown as FabReceipt; }
export function assertFabReceipt(value: FabReceipt, pending: FabPending) { if (value.operation !== 'update' || pending.id !== null && value.id !== pending.id || value.request_id !== pending.input.request_id || value.payload_hash !== pending.fingerprint) throw Error('回执与原请求不一致，请继续核对'); }
export function fabPendingKey(actor: number) { if (!int(actor, 1)) throw Error('管理员身份无效'); return `admin_fab_settings_pending:${actor}`; }
export function fabDraftKey(actor: number) { if (!int(actor, 1)) throw Error('管理员身份无效'); return `admin_fab_settings_rejected_draft:${actor}`; }
export async function parseFabPending(raw: string, actor: number): Promise<FabPending> { if (new TextEncoder().encode(raw).length > 524288) throw Error('原请求记录过大'); const row = object(JSON.parse(raw)); exact(row, ['version', 'actor', 'id', 'input', 'fingerprint', 'baseline']); if (row.version !== 1 || row.actor !== actor || !int(actor, 1) || row.id !== null && !int(row.id, 1) || !digest(row.fingerprint)) throw Error('原请求身份或格式无效'); const input = normalizeFabWrite(row.input), baseline = readButtons(row.baseline); if (await fabFingerprint(input) !== row.fingerprint || JSON.stringify(input) !== JSON.stringify(row.input) || input.values.button.some(item => item.source_id !== null && !baseline.some(old => old.source_id === item.source_id))) throw Error('原请求内容或来源与记录不一致'); return { version: 1, actor, id: row.id, input, fingerprint: row.fingerprint, baseline }; }
export const fabReceiptNotFound = (reason: unknown) => axios.isAxiosError(reason) && reason.response?.status === 404;
function proof(reason: unknown, pending: FabPending, status: number, code: string): boolean { if (!axios.isAxiosError(reason) || reason.response?.status !== status) return false; const body = reason.response.data; return !!body && body.status === status && body.data?.code === code && body.data.operation === 'update' && body.data.request_id === pending.input.request_id && body.data.payload_hash === pending.fingerprint; }
export const isFabStale = (reason: unknown, pending: FabPending) => proof(reason, pending, 409, 'FAB_SETTINGS_STALE_VERSION');
export const isFabRejected = (reason: unknown, pending: FabPending) => proof(reason, pending, 400, 'FAB_SETTINGS_REJECTED');
export function fabErrorMessage(reason: unknown): string { const body = axios.isAxiosError(reason) ? reason.response?.data?.msg : undefined; const candidate = body ?? (reason instanceof Error ? reason.message : null); return text(candidate, 512) && candidate ? candidate : '请求失败，请重新核对'; }
export function fabEditor(value: FabReadValues, previews?: FabSnapshot['image_previews']): FabEditor { return { is_show: value.is_show, index: value.index, shifting: value.shifting ?? 0, main_ago_image: value.main_ago_image ?? '', main_after_image: value.main_after_image ?? '', button: value.button.map((item, index) => ({ source_id: item.source_id, img: item.img ?? '', url: item.url ?? '', key: crypto.randomUUID(), unresolved: false, preview: fabPreview(previews?.button[index] ?? '') })) }; }
export function fabEditorValues(editor: FabEditor): FabValues { if (editor.button.some(item => item.unresolved)) throw Error('请先核对原按钮附加设置的保留方式'); return normalizeFabValues({ is_show: editor.is_show, index: editor.index, shifting: editor.shifting, main_ago_image: editor.main_ago_image, main_after_image: editor.main_after_image, button: editor.button.map(item => ({ source_id: item.source_id, img: item.img, url: item.url })) }); }
/** Never guess duplicated/externally changed historical items: their opaque source must be chosen explicitly. */
export function remapFabEditor(editor: FabEditor, baseline: FabReadButton[], fresh: FabReadButton[]): FabEditor {
  const count = (rows: FabReadButton[], row: FabReadButton) => rows.filter(item => item.img === row.img && item.url === row.url).length;
  return { ...editor, button: editor.button.map(item => {
    if (item.source_id === null) return { ...item, unresolved: false };
    if (fresh.some(row => row.source_id === item.source_id)) return { ...item, unresolved: false };
    const original = baseline.find(row => row.source_id === item.source_id), match = original && count(baseline, original) === 1 && count(fresh, original) === 1 ? fresh.find(row => row.img === original.img && row.url === original.url) : undefined;
    return match?.source_id ? { ...item, source_id: match.source_id, unresolved: false } : { ...item, unresolved: true };
  }) };
}
export async function apiFabSettings(signal?: AbortSignal): Promise<FabSnapshot> { return parseFabSnapshot(await getData(request.get('/setting/fab', { signal }))); }
export async function apiSaveFabSettings(value: FabWrite, signal?: AbortSignal): Promise<FabReceipt> { const input = normalizeFabWrite(value); return parseFabReceipt(await getData(request.post('/setting/fab', input, { signal })), input.request_id); }
export async function apiFabReceipt(requestId: string, signal?: AbortSignal): Promise<FabReceipt> { if (!uuid(requestId)) throw Error('悬浮按钮请求标识无效'); return parseFabReceipt(await getData(request.get(`/setting/fab/request/${requestId}`, { signal })), requestId); }

export const fabLinkKinds = ['basic', 'personal', 'distribution', 'marketing', 'product', 'product_category', 'seckill', 'bargain', 'combination', 'news', 'integral', 'presale', 'special'] as const;
export type FabLinkKind = typeof fabLinkKinds[number];
export interface FabLinkCategory { kind: FabLinkKind; name: string; group: string }
export interface FabLinkTarget { id: number; name: string; url: string; kind: FabLinkKind; selectable: boolean; partial: boolean; issues: string[]; image_preview?: string; price?: string; parent_id?: number; has_children?: boolean }
export interface FabLinkQuery { kind: FabLinkKind; search?: string; page: number; limit: number; parent_id?: number }
export interface FabLinkTargets { list: FabLinkTarget[]; count: number; page: number; limit: number; issues: string[] }
function linkIssues(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 1000 && value.every(item => text(item, 1000)); }
export function normalizeFabLinkQuery(value: FabLinkQuery): FabLinkQuery {
  const row = object(value); if (Object.keys(row).some(key => !['kind', 'search', 'page', 'limit', 'parent_id'].includes(key)) || !fabLinkKinds.includes(row.kind as FabLinkKind) || !int(row.page, 1) || !int(row.limit, 1, 100) || (row.page - 1) * row.limit > 10000 || row.parent_id !== undefined && (!int(row.parent_id) || !['product', 'product_category'].includes(row.kind as string) && row.parent_id !== 0)) throw Error('链接分类、筛选或分页无效');
  if (row.search !== undefined && !text(row.search, 8192)) throw Error('链接查询词无效'); const search = typeof row.search === 'string' ? row.search.trim() : ''; if ([...search].length > 100) throw Error('链接查询词不能超过100字'); return { kind: row.kind as FabLinkKind, page: row.page, limit: row.limit, ...(search ? { search } : {}), ...(row.parent_id === undefined ? {} : { parent_id: row.parent_id as number }) };
}
export function parseFabLinkCategories(value: unknown): { list: FabLinkCategory[]; issues: string[] } { const row = object(value); if (!Array.isArray(row.list) || row.list.length !== fabLinkKinds.length || row.list.some(item => !item || !fabLinkKinds.includes(item.kind) || !text(item.name, 255) || !item.name || !text(item.group, 100)) || new Set(row.list.map(item => item.kind)).size !== fabLinkKinds.length || !linkIssues(row.issues)) throw Error('链接分类目录不完整'); return row as unknown as { list: FabLinkCategory[]; issues: string[] }; }
export function parseFabLinkTargets(value: unknown, expected: FabLinkQuery): FabLinkTargets {
  const row = object(value); if (!int(row.count) || row.page !== expected.page || row.limit !== expected.limit || !Array.isArray(row.list) || row.list.length > expected.limit || row.list.length > row.count || !linkIssues(row.issues)) throw Error('链接目标分页或响应不完整');
  for (const item of row.list) { const target = object(item); if (!int(target.id) || !text(target.name, 1000) || !text(target.url, 2048) || target.kind !== expected.kind || typeof target.selectable !== 'boolean' || typeof target.partial !== 'boolean' || !linkIssues(target.issues) || target.selectable && !fabLinkSafe(target.url) || target.image_preview !== undefined && !text(target.image_preview, 8192) || target.price !== undefined && !text(target.price, 100) || target.parent_id !== undefined && !int(target.parent_id) || target.has_children !== undefined && typeof target.has_children !== 'boolean') throw Error('链接目标信息不完整或不可安全导航'); }
  if (new Set(row.list.map(item => `${item.kind}:${item.id}`)).size !== row.list.length) throw Error('链接目标重复'); return row as unknown as FabLinkTargets;
}
export async function apiFabLinkCategories(signal?: AbortSignal) { return parseFabLinkCategories(await getData(request.get('/setting/fab/link-categories', { signal }))); }
export async function apiFabLinkTargets(query: FabLinkQuery, signal?: AbortSignal) { const normalized = normalizeFabLinkQuery(query); return parseFabLinkTargets(await getData(request.get('/setting/fab/link-targets', { params: normalized, signal })), normalized); }

