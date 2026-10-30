import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { WechatAppAuthService } from '@/services/wechat/WechatAppAuthService';
import { parseNativeAppAuthState, parseNativeAppAuthComplete, parseNativeAppAuthPhone, readNativeAppAuthBody } from '@/services/wechat/NativeAppAuthInput';
import { clientIp } from '@/controllers/api/v1/UserBehaviorController';
import { ValidateException } from '@/utils/errors';
import { jsonOk, jsonFail } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function service(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  return new WechatAppAuthService(c.get('container'), c.env);
}
export async function state(c: C) {
  const auth = service(c);
  try {
    parseNativeAppAuthState(await readNativeAppAuthBody(c.req.raw));
    return jsonOk(c, await auth.createState(clientIp(c)));
  } catch (error) { if (error instanceof ValidateException) return jsonFail(c, error.message); throw error; }
}
export async function complete(c: C) {
  const auth = service(c);
  try { return jsonOk(c, await auth.login(parseNativeAppAuthComplete(await readNativeAppAuthBody(c.req.raw)), clientIp(c))); }
  catch (error) { if (error instanceof ValidateException) return jsonFail(c, error.message); throw error; }
}
export async function phone(c: C) {
  const auth = service(c);
  try { return jsonOk(c, await auth.completePhone(parseNativeAppAuthPhone(await readNativeAppAuthBody(c.req.raw)), clientIp(c))); }
  catch (error) { if (error instanceof ValidateException) return jsonFail(c, error.message); throw error; }
}
