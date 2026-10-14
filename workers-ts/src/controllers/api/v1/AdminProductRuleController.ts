import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductRuleService, ruleId } from '@/services/admin/AdminProductRuleService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function context(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  return { service: new AdminProductRuleService(c.get('container')), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}
async function body(c: C, allowEmpty = false): Promise<unknown> {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('商品规格模板写入不接受查询参数');
  const text = await readBoundedUtf8Text(c.req.raw, 64 * 1024);
  if (allowEmpty && text === '') return undefined;
  try { return JSON.parse(text) as unknown; } catch { throw new ValidateException('商品规格模板JSON格式错误'); }
}

export async function list(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor)); }
export async function templates(c: C) { const x = context(c); return jsonOk(c, await x.service.templates(x.query, x.actor)); }
export async function detail(c: C) { const x = context(c); return jsonOk(c, await x.service.detail(ruleId(c.req.param('id')), x.query, x.actor)); }
export async function save(c: C) { const x = context(c); await x.service.save(ruleId(c.req.param('id'), true), await body(c), x.actor); return c.json({ status: 200, msg: '保存成功!' }); }
export async function remove(c: C) { const x = context(c); await x.service.remove(ruleId(c.req.param('id')), x.query, await body(c, true), x.actor); return c.json({ status: 200, msg: '删除成功!' }); }

export async function modernList(c: C) { const x = context(c); return jsonOk(c, await x.service.list(x.query, x.actor, false)); }
export async function modernTemplates(c: C) { const x = context(c); return jsonOk(c, await x.service.templates(x.query, x.actor, false)); }
export async function modernDetail(c: C) { const x = context(c); return jsonOk(c, await x.service.detail(ruleId(c.req.param('id')), x.query, x.actor, false)); }
export async function modernSave(c: C) { const x = context(c); return jsonOk(c, await x.service.save(ruleId(c.req.param('id'), true), await body(c), x.actor, false), '保存成功'); }
export async function modernRemove(c: C) { const x = context(c); await x.service.remove(ruleId(c.req.param('id')), x.query, await body(c, true), x.actor, false); return jsonOk(c, null, '删除成功'); }
