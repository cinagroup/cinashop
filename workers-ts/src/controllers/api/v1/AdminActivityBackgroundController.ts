import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminActivityBackgroundService } from '@/services/admin/AdminActivityBackgroundService';
import { readBoundedJsonObject } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Operation = 'create' | 'update' | 'status' | 'delete';
const service = (c: C) => new AdminActivityBackgroundService(c.get('container'));
function privateNoStore(c: C): void { c.header('Cache-Control', 'private, no-store, max-age=0'); }
function noQuery(c: C): void {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数');
}
export async function list(c: C) { privateNoStore(c); return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams)); }
export async function products(c: C) { privateNoStore(c); return jsonOk(c, await service(c).choices('products', new URL(c.req.url).searchParams)); }
export async function brands(c: C) { privateNoStore(c); return jsonOk(c, await service(c).choices('brands', new URL(c.req.url).searchParams)); }
export async function labels(c: C) { privateNoStore(c); return jsonOk(c, await service(c).choices('labels', new URL(c.req.url).searchParams)); }
export async function detail(c: C) { privateNoStore(c); noQuery(c); return jsonOk(c, await service(c).detail(c.req.param('id'))); }
async function write(c: C, operation: Operation) {
  privateNoStore(c); noQuery(c);
  const actor = c.get('adminInfo');
  if (!actor) throw new ValidateException('管理员身份不存在');
  const body = await readBoundedJsonObject(c.req.raw, 768_000);
  return jsonOk(c, await service(c).mutate(operation, c.req.param('id'), body, { id: actor.id }), '操作成功');
}
export const create = (c: C) => write(c, 'create');
export const update = (c: C) => write(c, 'update');
export const status = (c: C) => write(c, 'status');
export const remove = (c: C) => write(c, 'delete');
