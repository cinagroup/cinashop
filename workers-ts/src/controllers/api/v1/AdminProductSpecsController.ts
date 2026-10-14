import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductSpecsService, legacySpecsTime, specsId } from '@/services/admin/AdminProductSpecsService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function context(c: C) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  return { service: new AdminProductSpecsService(c.get('container')), query: new URL(c.req.url).searchParams,
    actor: { id: c.get('adminId') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } };
}

async function body(c: C): Promise<unknown> {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('商品参数模板写入不接受查询参数');
  const text = await readBoundedUtf8Text(c.req.raw, 64 * 1024);
  try { return JSON.parse(text) as unknown; } catch { throw new ValidateException('商品参数模板JSON格式错误'); }
}

export async function all(c: C) {
  const x = context(c), rows = await x.service.all(x.query, x.actor);
  return jsonOk(c, rows.map(row => ({ ...row, specs: row.specs.map(spec => ({ ...spec, add_time: legacySpecsTime(spec.add_time) })) })));
}

export async function list(c: C) {
  const x = context(c);
  return jsonOk(c, await x.service.list(x.query, x.actor));
}

export async function detail(c: C) {
  const x = context(c);
  return jsonOk(c, await x.service.detail(specsId(c.req.param('id')), x.query, x.actor));
}

export async function save(c: C) {
  const x = context(c), id = specsId(c.req.param('id'), true);
  await x.service.save(id, await body(c), x.actor);
  return jsonOk(c, [], id ? '编辑成功' : '保存成功');
}

export async function remove(c: C) {
  const x = context(c);
  await x.service.remove(specsId(c.req.param('id')), x.query, x.actor);
  return jsonOk(c, [], '删除成功');
}

export async function modernAll(c: C) {
  const x = context(c);
  return jsonOk(c, await x.service.all(x.query, x.actor));
}

export async function modernList(c: C) {
  const x = context(c);
  return jsonOk(c, await x.service.list(x.query, x.actor, false));
}

export async function modernDetail(c: C) {
  const x = context(c);
  return jsonOk(c, await x.service.detail(specsId(c.req.param('id')), x.query, x.actor, false));
}

export async function modernSave(c: C) {
  const x = context(c);
  return jsonOk(c, await x.service.save(specsId(c.req.param('id'), true), await body(c), x.actor), '保存成功');
}

export async function modernRemove(c: C) {
  const x = context(c);
  await x.service.remove(specsId(c.req.param('id')), x.query, x.actor);
  return jsonOk(c, null, '删除成功');
}
