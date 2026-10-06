import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminCityDeliveryRecordService } from '@/services/admin/AdminCityDeliveryRecordService';
import { cityDeliveryQueryKeys } from '@/services/admin/AdminCityDeliveryRecordInput';
import { NotFoundException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function params(c: C) { c.header('Cache-Control', 'private, no-store'); return new URL(c.req.url).searchParams; }
const service = (c: C) => new AdminCityDeliveryRecordService(c.get('container'));
export async function records(c: C) { return jsonOk(c, await service(c).records(params(c))); }
export async function stores(c: C) { return jsonOk(c, await service(c).stores(params(c))); }
export async function detail(c: C) {
  cityDeliveryQueryKeys(params(c), []);
  try { return jsonOk(c, await service(c).detail(c.req.param('id') ?? '')); }
  catch (error) { if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404); throw error; }
}
