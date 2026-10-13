import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AuthException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseCartComputationInput } from '@/services/order/CartComputationInput';
import { CartComputationService } from '@/services/order/CartComputationService';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
/** Strong customer JWT middleware is mounted by the shared route. No order key or reservation. */
export async function cartCompute(c: C) {
  c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Pragma', 'no-cache');
  const uid = c.get('uid'), account = c.get('user'), expiresAt = c.get('socketTokenExp');
  if (!c.get('isLogin') || !account || account.uid !== uid || c.get('socketAuthId') !== uid
    || !expiresAt || !Number.isSafeInteger(expiresAt)) throw new AuthException('请重新登录后读取购物车预算');
  if (new URL(c.req.url).searchParams.size) throw new ValidateException('购物车预算不接受查询参数');
  const contentType = c.req.header('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ValidateException('购物车预算请提交JSON');
  const text = await readBoundedUtf8Text(c.req.raw, 4096);
  let body: unknown;
  try { body = JSON.parse(text) as unknown; } catch { throw new ValidateException('购物车预算JSON格式错误'); }
  return jsonOk(c, await new CartComputationService(c.get('container')).compute(
    { uid, passwordVersion: account.pwd, expiresAt }, parseCartComputationInput(body)));
}
