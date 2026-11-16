import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { authMiddleware } from '@/middleware/auth';
import { PublicProductEstimateService } from '@/services/product/PublicProductEstimateService';
import { ValidateException } from '@/utils/errors';
import { jsonFail, jsonOk } from '@/utils/json';
import { validPublicEstimateSku } from '../../../../../view/common/publicProductEstimate';

type Bindings = { Bindings: Env; Variables: AppVariables };
type C = Context<Bindings>;
function headers(c: C) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
}
/** Preserve legacy optional auth. Opt-in requests cannot turn a stale session
 * into a guest estimate or mutate an invalid token bucket while reading. */
export const activityAuth: MiddlewareHandler<Bindings> = async (c, next) => {
  if (!new URL(c.req.url).searchParams.has('view')) return authMiddleware({ force: false })(c, next);
  headers(c);
  const tokenPresent = c.req.header('Authorization') !== undefined || c.req.header('Authori-zation') !== undefined
    || c.req.header('Sec-WebSocket-Protocol') !== undefined;
  return authMiddleware({ force: tokenPresent, readOnly: true })(c, next);
};

export async function productEstimate(c: C) {
  headers(c);
  try {
    const url = new URL(c.req.url), query = url.searchParams, rawId = c.req.param('id');
    if (url.pathname.includes('%') || !rawId || !/^[1-9]\d{0,9}$/u.test(rawId) || Number(rawId) > 2_147_483_647
      || query.get('view') !== 'uni_product_estimate_v1'
      || [...query.keys()].some(key => !['view', 'unique'].includes(key) || query.getAll(key).length !== 1))
      throw new ValidateException('商品单件预估参数无效');
    const unique = query.get('unique');
    if (unique !== null && !validPublicEstimateSku(unique)) throw new ValidateException('商品规格参数无效');
    const uid = c.get('uid') ?? 0, actor = uid > 0
      ? { uid, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 } : undefined;
    const service = new PublicProductEstimateService(c.get('container'), actor, async () => {
      if (!actor) return;
      await authMiddleware({ force: true, readOnly: true })(c, async () => {});
      if (c.get('uid') !== actor.uid || c.get('socketAuthVersion') !== actor.authVersion || c.get('socketTokenExp') !== actor.expiresAt)
        throw new ValidateException('登录状态已变化，请重新读取预估');
    });
    return jsonOk(c, await service.estimate(Number(rawId), unique ?? undefined));
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}
