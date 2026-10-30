import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminBargainRecordsService } from '@/services/admin/AdminBargainRecordsService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminBargainRecordsService(c.get('container'));
const query = (c: C) => new URL(c.req.url).searchParams;
function headers(c: C) { c.header('Cache-Control', 'private, no-store'); }
export async function records(c: C) { headers(c); return jsonOk(c, await service(c).records(query(c))); }
export async function helpers(c: C) { headers(c); return jsonOk(c, await service(c).helpers(c.req.param('recordId'), query(c))); }
export async function head(c: C) {
  headers(c); if (query(c).size) throw new ValidateException('统计卡不接受查询参数');
  return jsonOk(c, await service(c).head(c.req.param('id')));
}
export async function activityRecords(c: C) { headers(c); return jsonOk(c, await service(c).records(query(c), c.req.param('id'))); }
export async function activityHelpers(c: C) { headers(c); return jsonOk(c, await service(c).helpers(c.req.param('recordId'), query(c), c.req.param('id'))); }
export async function orders(c: C) { headers(c); return jsonOk(c, await service(c).orders(c.req.param('id'), query(c))); }

/** Preserve the five original URLs and shipped date/name controls. Unknown or
 * duplicate aliases fail closed instead of disappearing from the query. */
function legacyQuery(c: C, kind: 'global' | 'records' | 'orders' | 'helpers') {
  const raw = query(c), translated = new URLSearchParams();
  const allowed = kind === 'global' ? ['page','limit','status','data'] : kind === 'helpers' ? ['page','limit'] : kind === 'orders' ? ['page','limit','status','real_name'] : ['page','limit','real_name'];
  for (const [key, value] of raw) {
    if (!allowed.includes(key) || raw.getAll(key).length !== 1) throw new ValidateException(`旧版查询参数不支持或重复：${key}`);
    if (key === 'real_name') translated.set('keyword', value);
    else if (key === 'data') {
      if (!value) continue;
      const match = /^(\d{4})\/(\d{2})\/(\d{2})\s*-\s*(\d{4})\/(\d{2})\/(\d{2})$/u.exec(value);
      if (!match) throw new ValidateException('旧版日期须为 YYYY/MM/DD - YYYY/MM/DD');
      translated.set('start_day', match.slice(1,4).join('-')); translated.set('end_day', match.slice(4,7).join('-'));
    } else translated.set(key, value);
  }
  return translated;
}
function chinaTime(value: number | string | null) {
  if (value === null || value === 0) return '';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0,19).replace('T',' ');
}
function legacyRows<T extends { list: Array<{ add_time: number; stop_time: string | null; image_preview: string; avatar_preview: string; deleted_user: boolean }> }>(result: T) {
  return { ...result, list: result.list.map(row => ({ ...row, image: row.image_preview, avatar: row.avatar_preview,
    delete_time: row.deleted_user ? 1 : null, add_time: chinaTime(row.add_time), datatime: chinaTime(row.stop_time) })) };
}
export async function legacyRecords(c: C) { headers(c); return jsonOk(c, legacyRows(await service(c).records(legacyQuery(c,'global')))); }
export async function legacyActivityRecords(c: C) { headers(c); return jsonOk(c, legacyRows(await service(c).records(legacyQuery(c,'records'), c.req.param('id')))); }
export async function legacyHelpers(c: C) {
  headers(c); const result = await service(c).helpers(c.req.param('id'), legacyQuery(c,'helpers'));
  return jsonOk(c, { ...result, list: result.list.map(row => ({ ...row, avatar: row.avatar_preview, delete_time: row.deleted_user ? 1 : null, add_time: chinaTime(row.add_time) })) });
}
export async function legacyOrders(c: C) { headers(c); return jsonOk(c, await service(c).orders(c.req.param('id'), legacyQuery(c,'orders'))); }
