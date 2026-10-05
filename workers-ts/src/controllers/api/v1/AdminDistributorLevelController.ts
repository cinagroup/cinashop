import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminDistributorLevelService } from '@/services/admin/AdminDistributorLevelService';
import { DistributorLevelRejected, DistributorLevelStaleVersion, parseDistributorQuery, readDistributorBody, type DistributorOperation, type DistributorResource } from '@/services/admin/AdminDistributorLevelInput';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminDistributorLevelService(c.get('container'), c.env);
function privateResponse(c: C, query = false) {
  c.header('Cache-Control', 'private, no-store');
  if (!query && new URL(c.req.url).searchParams.size) throw new ValidateException('此分销操作不接受查询参数');
}
function actor(c: C) {
  const admin = c.get('adminInfo'); if (!admin) throw new ValidateException('管理员身份不存在');
  return { id: admin.id };
}
async function read(c: C, action: () => Promise<unknown>) {
  try { return jsonOk(c, await action()); }
  catch (error) { if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404); throw error; }
}
export async function levelsList(c: C) { privateResponse(c, true); return read(c, () => service(c).levelsList(parseDistributorQuery(new URL(c.req.url).searchParams))); }
export async function levelsDetail(c: C) { privateResponse(c); return read(c, () => service(c).levelsDetail(c.req.param('id'))); }
export async function tasksList(c: C) { privateResponse(c, true); return read(c, () => service(c).tasksList(parseDistributorQuery(new URL(c.req.url).searchParams, true))); }
export async function legacyTasksList(c: C) {
  privateResponse(c, true); const query = new URL(c.req.url).searchParams;
  if (query.has('id')) {
    if (query.getAll('id').length !== 1 || query.has('level_id')) throw new ValidateException('任务所属等级参数重复');
    query.set('level_id', query.get('id')!); query.delete('id');
  }
  return read(c, () => service(c).tasksList(parseDistributorQuery(query, true)));
}
export async function tasksDetail(c: C) { privateResponse(c); return read(c, () => service(c).tasksDetail(c.req.param('id'))); }
export async function tasksParents(c: C) { privateResponse(c, true); return read(c, () => service(c).tasksParents(parseDistributorQuery(new URL(c.req.url).searchParams))); }
async function getReceipt(c: C, resource: DistributorResource) { privateResponse(c); return read(c, () => service(c).receipt(resource, c.req.param('requestId'), actor(c))); }
export const levelsReceipt = (c: C) => getReceipt(c, 'level');
export const tasksReceipt = (c: C) => getReceipt(c, 'task');
async function write(c: C, operation: DistributorOperation) {
  privateResponse(c);
  try {
    const body = await readDistributorBody(c.req.raw), routeStatus = c.req.param('status');
    if (operation.endsWith(':status') && routeStatus !== undefined && (!/^[01]$/.test(routeStatus) || (body as Record<string, unknown>)?.status !== Number(routeStatus))) throw new ValidateException('路径状态须与版本化请求状态一致');
    return jsonOk(c, await service(c).mutate(operation, c.req.param('id'), body, actor(c)), '分销操作成功');
  }
  catch (error) {
    if (error instanceof DistributorLevelRejected) return c.json({ status: 400, msg: error.message,
      data: { code: 'DISTRIBUTOR_LEVEL_REJECTED', operation: error.operation, request_id: error.request_id, payload_hash: error.payload_hash } }, 400);
    if (error instanceof DistributorLevelStaleVersion) return c.json({ status: 409, msg: error.message,
      data: { code: 'DISTRIBUTOR_LEVEL_STALE_VERSION', operation: error.operation, request_id: error.request_id, payload_hash: error.payload_hash } }, 409);
    if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404);
    throw error;
  }
}
export const levelsCreate = (c: C) => write(c, 'level:create');
export const levelsUpdate = (c: C) => write(c, 'level:update');
export const levelsStatus = (c: C) => write(c, 'level:status');
export const legacyLevelsStatus = levelsStatus;
export const levelsDelete = (c: C) => write(c, 'level:delete');
export const tasksCreate = (c: C) => write(c, 'task:create');
export const tasksUpdate = (c: C) => write(c, 'task:update');
export const tasksStatus = (c: C) => write(c, 'task:status');
export const tasksDelete = (c: C) => write(c, 'task:delete');
// Existing form URLs now return the same versioned DTO; mutations still require
// the canonical JSON body and never infer revision/UUID from route parameters.
export async function levelsCreateForm(c: C) { privateResponse(c); return read(c, async () => { const list = await service(c).levelsList(new URLSearchParams()); return { revision: list.revision, config: list.config, issues: list.issues }; }); }
export async function tasksCreateForm(c: C) { privateResponse(c, true); return read(c, async () => {
  const query = parseDistributorQuery(new URL(c.req.url).searchParams, true), list = await service(c).tasksList(query);
  return { parent: list.parent, revision: list.revision, task_types: list.task_types, issues: list.issues };
}); }
