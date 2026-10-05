import type { Context, Next } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AuthException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { extractToken } from '@/middleware/auth';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { jsonOk } from '@/utils/json';
import { DeliveryOrderWriteoffService } from '@/services/store/DeliveryOrderWriteoffService';
import { DeliveryOrderOperationRequest, type DeliveryOperationContext } from '@/services/store/DeliveryOrderOperationRequest';
import { deliveryActor } from '@/services/store/DeliveryPrincipalScope';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function privateResponse(c: C) { c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache'); }
export async function privateDeliveryResponse(c: C, next: Next) { privateResponse(c); await next(); }
export function deliveryAuthenticatedActor(c: C) {
  const account = c.get('user'), uid = c.get('uid');
  const token = extractToken(c), version = c.get('socketAuthVersion');
  // authMiddleware has already verified JWT, current DB password and exact
  // active Redis bucket. Repeat strict version/token identity, including only
  // its existing legacy raw-password-hash compatibility contract.
  const validVersion = account && (version === md5(account.pwd) || Boolean(c.env.UPSTASH_REDIS_URL && c.env.UPSTASH_REDIS_TOKEN && token && c.get('socketTokenKey') === md5(token) && version === account.pwd));
  if (!c.get('isLogin') || !account || account.uid !== uid || c.get('socketAuthId') !== uid || !validVersion) throw new AuthException('配送会话未通过用户鉴权');
  return deliveryActor({ uid, authVersion: md5(account.pwd), expiresAt: c.get('socketTokenExp') ?? 0 });
}
export function deliveryOperationContext(c: C): DeliveryOperationContext { return { actor: deliveryAuthenticatedActor(c), request_key: c.req.header('Idempotency-Key') ?? '' }; }
async function body(c: C): Promise<unknown> {
  if (new URL(c.req.url).search || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type') ?? '') || !['', 'identity'].includes((c.req.header('Content-Encoding') ?? '').toLowerCase())) throw new ValidateException('配送操作只接受无查询参数的UTF-8 JSON');
  const raw = await readBoundedUtf8Text(c.req.raw, 262144); let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ValidateException('配送操作JSON无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('配送操作内容格式错误'); return value;
}
const service = (c: C) => new DeliveryOrderWriteoffService(c.get('container'), c.env);
export async function info(c: C) { privateResponse(c); return jsonOk(c, await service(c).info(deliveryAuthenticatedActor(c), await body(c))); }
export async function execute(c: C) { privateResponse(c); return jsonOk(c, await service(c).execute(deliveryOperationContext(c), await body(c))); }
export async function records(c: C) { privateResponse(c); return jsonOk(c, await service(c).records(deliveryAuthenticatedActor(c), c.req.query())); }
export async function outcome(c: C) {
  privateResponse(c); if (new URL(c.req.url).search) throw new ValidateException('原配送回执查询不接受其它参数');
  return jsonOk(c, { receipt: await new DeliveryOrderOperationRequest(c.get('container')).getOutcome(deliveryAuthenticatedActor(c), c.req.param('requestKey')) });
}
export async function abandon(c: C) { privateResponse(c); return jsonOk(c, { receipt: await new DeliveryOrderOperationRequest(c.get('container')).abandon(deliveryOperationContext(c), await body(c)) }); }
