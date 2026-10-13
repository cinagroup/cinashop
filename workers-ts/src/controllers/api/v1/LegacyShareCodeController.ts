import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { jsonOk } from '@/utils/json';
import { AuthException, ValidateException } from '@/utils/errors';
import { LegacyShareCodeService, parseLegacyShareInput, assertLegacyShareActor, type LegacyShareActor } from '@/services/other/LegacyShareCodeService';
import { enforceLegacyShareBudget } from '@/services/other/LegacyShareBudget';
import { validLegacyShareToken, verifyLegacyShareImageQuery } from '@/services/other/LegacyShareCodeProtocol';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function privateResponse(c: C) { c.header('Cache-Control','private, no-store'); c.header('Pragma','no-cache'); c.header('Referrer-Policy','no-referrer'); }
function service(c: C) { privateResponse(c); return new LegacyShareCodeService(c.get('container'),c.env); }
function actor(c: C): LegacyShareActor {
  const uid = c.get('uid') ?? 0;
  return {uid,authVersion:uid?c.get('socketAuthVersion')??'':'',expiresAt:uid?c.get('socketTokenExp')??0:0};
}
export async function code(c: C) {
  privateResponse(c);
  const input = parseLegacyShareInput(c.req.param('type')??'',c.req.param('id')??'',new URL(c.req.url).searchParams);
  const identity = actor(c); assertLegacyShareActor(identity);
  if ([-1,90,91].includes(input.type) && !identity.uid) throw new AuthException('请登录后读取本人码');
  await enforceLegacyShareBudget(c.env,c.req.header('CF-Connecting-IP'));
  return jsonOk(c,await service(c).code(input,identity,/micromessenger/i.test(c.req.header('User-Agent')??'')));
}
export async function scene(c: C) {
  privateResponse(c);
  if (new URL(c.req.url).searchParams.size || !validLegacyShareToken(c.req.param('token')??'')) throw new ValidateException('分享落地参数错误');
  assertLegacyShareActor(actor(c)); await enforceLegacyShareBudget(c.env,c.req.header('CF-Connecting-IP'));
  return jsonOk(c,await service(c).scene(c.req.param('token')??'',actor(c)));
}
export async function image(c: C) {
  privateResponse(c);
  verifyLegacyShareImageQuery(c.req.param('token')??'',c.req.param('channel')??'',new URL(c.req.url).searchParams,c.env.APP_KEY);
  await enforceLegacyShareBudget(c.env,c.req.header('CF-Connecting-IP'));
  return service(c).image(c.req.param('token')??'',c.req.param('channel')??'',new URL(c.req.url).searchParams);
}
