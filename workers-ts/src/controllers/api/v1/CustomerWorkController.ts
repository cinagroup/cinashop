import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { md5 } from '@/utils/jwt';
import { AuthException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { CustomerWorkReadService } from '@/services/customer-work/CustomerWorkReadService';
import type { CustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
export function customerWorkActor(c: C): CustomerWorkActor {
  const account = c.get('user'), uid = c.get('uid');
  if (!c.get('isLogin') || !account || account.uid !== uid || c.get('socketAuthId') !== uid || !c.get('socketAuthVersion')) throw new AuthException('手机订单工作台须通过用户鉴权');
  return { uid, auth_version: md5(account.pwd), expires_at: c.get('socketTokenExp') ?? 0 };
}
function input(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  if (Object.values(c.req.queries()).some(values => values.length !== 1)) throw new ValidateException('工作台查询参数不能重复');
  return { service: new CustomerWorkReadService(c.get('container'), c.env), actor: customerWorkActor(c), query: c.req.query() };
}
export async function context(c: C) { const s = input(c); return jsonOk(c, await s.service.context(s.actor, s.query)); }
export async function overview(c: C) { const s = input(c); return jsonOk(c, await s.service.overview(s.actor, s.query)); }
export async function statistics(c: C) { const s = input(c); return jsonOk(c, await s.service.statistics(s.actor, s.query)); }
export async function trend(c: C) { const s = input(c); return jsonOk(c, await s.service.trend(s.actor, s.query)); }
export async function daily(c: C) { const s = input(c); return jsonOk(c, await s.service.daily(s.actor, s.query)); }
export async function orders(c: C) { const s = input(c); return jsonOk(c, await s.service.orders(s.actor, s.query)); }
export async function orderDetail(c: C) { const s = input(c); return jsonOk(c, await s.service.orderDetail(s.actor, c.req.param('id'), s.query)); }
export async function refunds(c: C) { const s = input(c); return jsonOk(c, await s.service.refunds(s.actor, s.query)); }
export async function refundDetail(c: C) { const s = input(c); return jsonOk(c, await s.service.refundDetail(s.actor, c.req.param('id'), s.query)); }
export async function logistics(c: C) { const s = input(c); return jsonOk(c, await s.service.logistics(s.actor, c.req.param('id'), s.query)); }
