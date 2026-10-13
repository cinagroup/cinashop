import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AuthException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { DivisionStaffService } from '@/services/division/DivisionStaffService';
import { DivisionStaffInviteService } from '@/services/division/DivisionStaffInviteService';
import { divisionStaffJson, divisionStaffQuery, parseDivisionStaffInvite, parseDivisionStaffList,
  parseDivisionStaffPercent, parseDivisionStaffRemove, staffInteger, type DivisionStaffActor } from '@/services/division/DivisionStaffInput';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function actor(c: C): DivisionStaffActor {
  c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Pragma', 'no-cache'); c.header('Referrer-Policy', 'no-referrer');
  const uid = c.get('uid'), user = c.get('user'), expiresAt = c.get('socketTokenExp');
  if (!c.get('isLogin') || !user || user.uid !== uid || c.get('socketAuthId') !== uid
    || !expiresAt || !Number.isSafeInteger(expiresAt)) throw new AuthException('请重新登录后管理员工');
  return { uid, passwordVersion: user.pwd, expiresAt };
}
function noQuery(c: C) {
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('员工写操作不接受查询参数');
}
async function body(c: C, empty = false): Promise<unknown> {
  const text = await readBoundedUtf8Text(c.req.raw, 2048);
  if (!text.trim() && empty) return {};
  if (c.req.header('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ValidateException('员工管理请提交JSON');
  return divisionStaffJson(text);
}
export async function staffList(c: C) {
  const owner = actor(c), input = parseDivisionStaffList(divisionStaffQuery(c.req.url));
  return jsonOk(c, await new DivisionStaffService(c.get('container')).list(owner, input));
}
export async function staffPercent(c: C) {
  const owner = actor(c); noQuery(c);
  const input = parseDivisionStaffPercent(await body(c));
  await new DivisionStaffService(c.get('container')).percent(owner, input.uid, input.percent, input.revision);
  return jsonOk(c, null, '设置成功');
}
/** GET compatibility preserves the real legacy write; DELETE is the modern UI. */
export async function delStaff(c: C) {
  // Hono may dispatch raw HEAD as GET before matching method-specific routes.
  if (c.req.method === 'HEAD') return c.json({ status: 405, msg: '员工解绑不支持此方法', data: null }, 405);
  const owner = actor(c); noQuery(c);
  const uid = staffInteger(c.req.param('uid'), '员工UID');
  const input = parseDivisionStaffRemove(c.req.method === 'GET' ? {} : await body(c, true));
  await new DivisionStaffService(c.get('container')).remove(owner, uid, input.revision);
  return jsonOk(c, null, '删除成功');
}
export async function agentSpread(c: C) {
  const owner = actor(c); noQuery(c);
  await new DivisionStaffService(c.get('container')).bind(owner, parseDivisionStaffInvite(await body(c)));
  return jsonOk(c, null, '绑定成功');
}
export async function bindInfo(c: C) {
  const owner = actor(c);
  return jsonOk(c, await new DivisionStaffService(c.get('container')).preview(owner, parseDivisionStaffInvite(divisionStaffQuery(c.req.url))));
}
export async function agentSpreadCode(c: C) {
  const owner = actor(c); noQuery(c);
  return jsonOk(c, await new DivisionStaffInviteService(c.get('container'), c.env).create(owner, c.req.url));
}
export async function agentSpreadCodeImage(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Pragma', 'no-cache'); c.header('Referrer-Policy', 'no-referrer');
  return new DivisionStaffInviteService(c.get('container'), c.env).render(c.req.param('uid') ?? '', new URL(c.req.url).searchParams);
}
