import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminCombinationService } from '@/services/admin/AdminCombinationService';
import { readBoundedJsonObject } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Operation = 'create' | 'update' | 'status' | 'delete';
const service = (c: C) => new AdminCombinationService(c.get('container'), c.env.APP_KEY);
function noQuery(c: C) { if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数'); }
function privateResponse(c: C) { c.header('Cache-Control', 'private, no-store'); }
export async function list(c: C) { privateResponse(c); return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams)); }
export async function options(c: C) { privateResponse(c); noQuery(c); return jsonOk(c, await service(c).options()); }
export async function products(c: C) { privateResponse(c); return jsonOk(c, await service(c).candidates(new URL(c.req.url).searchParams)); }
export async function product(c: C) { privateResponse(c); noQuery(c); return jsonOk(c, await service(c).source(c.req.param('productId'))); }
export async function detail(c: C) { privateResponse(c); noQuery(c); return jsonOk(c, await service(c).detail(c.req.param('id'))); }
async function write(c: C, operation: Operation) {
  privateResponse(c); noQuery(c);
  const actor = c.get('adminInfo'); if (!actor) throw new ValidateException('管理员身份不存在');
  return jsonOk(c, await service(c).mutate(operation, c.req.param('id'), await readBoundedJsonObject(c.req.raw, 768000), { id: actor.id }), '操作成功');
}
export const create = (c: C) => write(c, 'create');
export const update = (c: C) => write(c, 'update');
export const status = (c: C) => write(c, 'status');
export const remove = (c: C) => write(c, 'delete');
