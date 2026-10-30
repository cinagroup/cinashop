import type { Context } from 'hono';
import type { Env, AppVariables } from '@/env';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { CustomerCashierCapabilities } from '@/services/customer-work/CustomerCashierCapabilities';
import { customerWorkActor } from './CustomerWorkController';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
export async function cashierCapabilities(c: C) {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache');
  if (new URL(c.req.url).search || c.req.header('Idempotency-Key') !== undefined
    || c.req.raw.body !== null || !['', '0'].includes(c.req.header('Content-Length') ?? '')
    || c.req.header('Transfer-Encoding') !== undefined) throw new ValidateException('次卡收银能力不接受查询、请求体或写入编号');
  const context = c.get('cashierCapabilityContext');
  if (!context) throw new HttpApiException('次卡收银能力必须使用独立运行入口', 503, 503);
  return jsonOk(c, await new CustomerCashierCapabilities(c.get('container'), context).read(customerWorkActor(c)));
}
