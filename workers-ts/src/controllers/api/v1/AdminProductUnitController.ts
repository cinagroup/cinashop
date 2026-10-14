import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { jsonOk } from '@/utils/json';
import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { AdminProductUnitService, unitId } from '@/services/admin/AdminProductUnitService';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { service: new AdminProductUnitService(c.get('container')), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
async function body(c: C, id: number) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('单位写入不接受查询参数');
  const text = await readBoundedUtf8Text(c.req.raw, 4096);
  let value: unknown; try { value = JSON.parse(text); } catch { throw new ValidateException('单位提交JSON格式错误'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('单位提交格式错误');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['name', 'sort', 'id', 'type', 'relation_id', 'status', 'is_del', 'add_time'].includes(key))) throw new ValidateException('单位提交包含未知字段');
  if (row.id !== undefined && unitId(row.id, true) !== id) throw new ValidateException('单位正文ID必须与路径一致');
  if (row.type !== undefined && row.type !== 0 || row.relation_id !== undefined && row.relation_id !== 0 || row.is_del !== undefined && row.is_del !== 0) throw new ValidateException('单位不属于有效平台目录');
  if (row.status !== undefined && row.status !== 0 && row.status !== 1) throw new ValidateException('单位状态错误');
  return { name: row.name, sort: row.sort };
}
export async function all(c: C) { const x = context(c); return jsonOk(c, await x.service.all(x.query, x.actor)); }
export async function list(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor)); }
export async function detail(c: C) { const x = context(c); return jsonOk(c, await x.service.detail(unitId(c.req.param('id')), x.query, x.actor)); }
export async function createForm(c: C) { const x = context(c); return jsonOk(c, await x.service.form(0, x.query, x.actor)); }
export async function editForm(c: C) { const x = context(c); return jsonOk(c, await x.service.form(unitId(c.req.param('id')), x.query, x.actor)); }
export async function create(c: C) { const x = context(c); return jsonOk(c, await x.service.save(0, await body(c, 0), x.actor), '保存成功'); }
export async function update(c: C) { const x = context(c), id = unitId(c.req.param('id')); return jsonOk(c, await x.service.save(id, await body(c, id), x.actor), '修改成功'); }
export async function remove(c: C) { const x = context(c); await x.service.remove(unitId(c.req.param('id')), x.query, x.actor); return jsonOk(c, null, '删除成功'); }
