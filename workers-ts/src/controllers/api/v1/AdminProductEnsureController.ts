import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductEnsureService, ensureId } from '@/services/admin/AdminProductEnsureService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { service: new AdminProductEnsureService(c.get('container')), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
async function body(c: C): Promise<unknown> {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('商品保障服务写入不接受查询参数');
  const text = await readBoundedUtf8Text(c.req.raw, 64 * 1024);
  try { return JSON.parse(text) as unknown; } catch { throw new ValidateException('商品保障服务JSON格式错误'); }
}

export async function all(c: C) { const x = context(c); return jsonOk(c, await x.service.all(x.query, x.actor)); }
export async function list(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor)); }
export async function detail(c: C) { const x = context(c); return jsonOk(c, await x.service.detail(ensureId(c.req.param('id')), x.query, x.actor)); }
export async function createForm(c: C) { const x = context(c); return jsonOk(c, await x.service.createForm(x.query, x.actor)); }
export async function editForm(c: C) { const x = context(c); return jsonOk(c, await x.service.editForm(ensureId(c.req.param('id')), x.query, x.actor)); }
export async function create(c: C) { const x = context(c); await x.service.create(await body(c), x.actor); return jsonOk(c, [], '添加保障服务成功!'); }
export async function update(c: C) { const x = context(c); await x.service.update(ensureId(c.req.param('id')), await body(c), x.actor); return jsonOk(c, [], '修改成功!'); }
export async function setStatus(c: C) { const x = context(c); await x.service.setStatus(ensureId(c.req.param('id')), c.req.param('is_show') ?? c.req.param('status'), x.query, x.actor); return jsonOk(c, [], '设置成功'); }
export async function remove(c: C) { const x = context(c); await x.service.remove(ensureId(c.req.param('id')), x.query, x.actor); return jsonOk(c, [], '删除成功!'); }

export async function modernAll(c: C) { const x = context(c); return jsonOk(c, await x.service.all(x.query, x.actor, false)); }
export async function modernList(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor, false)); }
export const modernDetail = detail;
export const modernCreateForm = createForm;
export const modernEditForm = editForm;
export async function modernCreate(c: C) { const x = context(c); return jsonOk(c, await x.service.create(await body(c), x.actor, false), '添加成功'); }
export async function modernUpdate(c: C) { const x = context(c); return jsonOk(c, await x.service.update(ensureId(c.req.param('id')), await body(c), x.actor, false), '修改成功'); }
export async function modernSetStatus(c: C) { const x = context(c); await x.service.setStatus(ensureId(c.req.param('id')), c.req.param('is_show') ?? c.req.param('status'), x.query, x.actor, false); return jsonOk(c, null, '设置成功'); }
export async function modernRemove(c: C) { const x = context(c); await x.service.remove(ensureId(c.req.param('id')), x.query, x.actor, false); return jsonOk(c, null, '删除成功'); }
