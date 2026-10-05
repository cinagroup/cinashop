import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminIntegralBatchService } from '@/services/admin/AdminIntegralBatchService';
import { readBoundedJsonObject } from '@/utils/request-body';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminIntegralBatchService(c.get('container'), c.env.APP_KEY);
function noQuery(c: C) { if (new URL(c.req.url).searchParams.size) throw new ValidateException('此操作不接受查询参数'); }
function privateResponse(c: C) { c.header('Cache-Control', 'private, no-store'); }
function actor(c: C) { const value = c.get('adminInfo'); if (!value) throw new ValidateException('管理员身份不存在'); return { id: value.id }; }
export async function products(c: C) { privateResponse(c); return jsonOk(c, await service(c).candidates(new URL(c.req.url).searchParams)); }
export async function product(c: C) { privateResponse(c); noQuery(c); return jsonOk(c, await service(c).source(c.req.param('productId'))); }
export async function receipt(c: C) {
  privateResponse(c); noQuery(c);
  try { return jsonOk(c, await service(c).receipt(c.req.param('requestId'), actor(c))); }
  catch (error) {
    // An absent actor-owned receipt is a read-only recovery signal. Preserve
    // the body contract and make the actual HTTP result unambiguous as well.
    if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404);
    throw error;
  }
}
export async function create(c: C) {
  privateResponse(c); noQuery(c);
  return jsonOk(c, await service(c).create(await readBoundedJsonObject(c.req.raw, 768000), actor(c)), '批量添加成功');
}
