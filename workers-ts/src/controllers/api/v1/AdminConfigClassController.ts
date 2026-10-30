import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { AdminConfigClassService } from '@/services/admin/AdminConfigClassService';
import { ConfigClassNotApplied, configClassInteger, type ConfigClassOperation } from '@/services/admin/AdminConfigClassInput';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { service: new AdminConfigClassService(c.get('container')), actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 }, query: new URL(c.req.url).searchParams };
}
async function body(c: C) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('配置分类写入不接受查询参数');
  if (!c.req.raw.body) return {};
  try { return JSON.parse(await readBoundedUtf8Text(c.req.raw, 64 * 1024)); } catch (error) { if (error instanceof ValidateException) throw error; throw new ValidateException('配置分类正文不是有效JSON'); }
}
export async function catalog(c: C) { const x = context(c); return jsonOk(c, await x.service.catalog(x.query, x.actor)); }
export async function list(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor)); }
export async function detail(c: C) { const x = context(c); return jsonOk(c, await x.service.detail(c.req.param('id'), x.query, x.actor)); }
export async function createForm(c: C) { const x = context(c); return jsonOk(c, await x.service.form(0, x.query, x.actor)); }
export async function editForm(c: C) { const x = context(c); return jsonOk(c, await x.service.form(c.req.param('id'), x.query, x.actor)); }
export async function receipt(c: C) { const x = context(c); return jsonOk(c, await x.service.receipt(c.req.param('requestId'), x.query, x.actor)); }
async function write(c: C, operation: ConfigClassOperation) {
  const x = context(c), input = await body(c);
  let result;
  try { result = await x.service.mutate(operation, operation === 'create' ? 0 : configClassInteger(c.req.param('id'), '配置分类ID'), input, x.actor, operation === 'status' ? c.req.param('status') : undefined); }
  catch (error) { if (error instanceof ConfigClassNotApplied) return c.json({ status: error.httpStatus, msg: error.message, data: error.proof }, error.httpStatus); throw error; }
  // Existing REST callers without an intent retain their original data shapes.
  const modern = !!input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'request_id');
  return jsonOk(c, modern ? result : operation === 'create' || operation === 'update' ? { id: result.id } : null, operation === 'create' ? '添加配置分类成功' : operation === 'delete' ? '删除成功' : operation === 'status' ? '设置成功' : '修改成功');
}
export const create = (c: C) => write(c, 'create');
export const update = (c: C) => write(c, 'update');
export const remove = (c: C) => write(c, 'delete');
export const setStatus = (c: C) => write(c, 'status');
