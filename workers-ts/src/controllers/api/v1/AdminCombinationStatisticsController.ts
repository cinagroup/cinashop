import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminCombinationStatisticsService } from '@/services/admin/AdminCombinationStatisticsService';
import { AdminCombinationExportService } from '@/services/admin/AdminCombinationExportService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminCombinationStatisticsService(c.get('container'));
const query = (c: C) => new URL(c.req.url).searchParams;
function headers(c: C) { c.header('Cache-Control', 'private, no-store'); }
function noQuery(c: C) { if (query(c).size) throw new ValidateException('统计卡不接受列表查询参数'); }

export async function exportManifest(c: C) {
  headers(c);
  return jsonOk(c, await new AdminCombinationExportService(c.get('container')).manifest(query(c)));
}
export async function globalHead(c: C) { headers(c); noQuery(c); return jsonOk(c, await service(c).globalHead()); }
export async function groups(c: C) { headers(c); return jsonOk(c, await service(c).groups(query(c))); }
export async function members(c: C) { headers(c); return jsonOk(c, await service(c).members(c.req.param('groupId'), query(c))); }
export async function head(c: C) { headers(c); noQuery(c); return jsonOk(c, await service(c).head(c.req.param('id'))); }
export async function activityGroups(c: C) { headers(c); return jsonOk(c, await service(c).groups(query(c), c.req.param('id'))); }
export async function activityMembers(c: C) {
  headers(c);
  return jsonOk(c, await service(c).members(c.req.param('groupId'), query(c), c.req.param('id')));
}
export async function orders(c: C) { headers(c); return jsonOk(c, await service(c).orders(c.req.param('id'), query(c))); }
