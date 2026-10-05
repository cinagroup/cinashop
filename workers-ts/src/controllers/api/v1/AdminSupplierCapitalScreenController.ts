import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminSupplierCapitalScreenService, type CapitalRemarkActor } from '@/services/admin/AdminSupplierCapitalScreenService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function noStore(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
}

function service(c: C) { return new AdminSupplierCapitalScreenService(c.get('container')); }

function actor(c: C): CapitalRemarkActor {
  const admin = c.get('adminInfo');
  if (!admin) throw new ValidateException('管理员身份不存在');
  return { id: admin.id, name: admin.realName || admin.account,
    ip: (c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0] ?? '')
      .trim().slice(0, 45) };
}

export async function suppliers(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).suppliers(new URL(c.req.url).searchParams));
}

export async function list(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
}

export async function exportCapital(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).export(new URL(c.req.url).searchParams));
}

export async function remark(c: C) {
  noStore(c);
  const raw = c.req.param('id') ?? '';
  if (!/^[1-9]\d*$/.test(raw)) throw new ValidateException('流水 ID 无效');
  const body = await readBoundedJsonObject(c.req.raw, 2 * 1024);
  return jsonOk(c, await service(c).remark(Number(raw), body, actor(c)), '备注成功');
}
