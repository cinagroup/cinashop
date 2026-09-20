import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { quoteOfflineOrder } from '@/services/order/OfflineOrderQuoteService';
import { admitOfflineOrder } from '@/services/order/OfflineOrderAdmissionService';
import { payOfflineOrderBalance } from '@/services/order/OfflineOrderBalanceService';
import { dispatchOfflineOrderPayment } from '@/services/order/OfflineOrderPaymentDispatchService';
import { readOfflineOrder } from '@/services/order/OfflineOrderReadService';
import { readOfflinePaymentMethods } from '@/services/order/OfflineOrderPaymentMethods';
import { listOfflineOrders } from '@/services/order/OfflineOrderHistoryService';
import { ApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';

export async function checkPrice(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  const body = await readBoundedJsonObject(c.req.raw, 1024);
  if (Object.keys(body).some(key => key !== 'pay_price')) {
    throw new ValidateException('报价仅接受消费金额');
  }
  return jsonOk(c, await quoteOfflineOrder(c.get('container').db, c.get('uid'), body.pay_price));
}

type OfflineContext = Context<{ Bindings: Env; Variables: AppVariables }>;
/** Missing candidate installation/ACL is an unavailable service, never runtime DDL.
 * This is NOT a substitute for the separate controlled catalog/ACL installation gate.
 */
async function available<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof ApiException) throw error;
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && ['42P01', '42703', '42883', '42501'].includes(String(cause.code))) {
        throw new ServiceUnavailableException('线下收银服务尚未就绪，请稍后重试原请求');
      }
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
function only(body: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(body).some(key => !fields.includes(key))) throw new ValidateException('线下收银请求包含不支持的字段');
}
export async function create(c: OfflineContext) {
  const body = await readBoundedJsonObject(c.req.raw, 1024);
  only(body, ['money', 'expected_pay_price', 'from', 'request_key']);
  if (typeof body.money !== 'string' || typeof body.expected_pay_price !== 'string'
    || typeof body.from !== 'string' || typeof body.request_key !== 'string') throw new ValidateException('请提交完整的消费确认信息及请求标识');
  const { money, expected_pay_price: expectedPayPrice, from, request_key: requestKey } = body;
  const result = await available(() => admitOfflineOrder(c.get('container'), { uid: c.get('uid'), money, expectedPayPrice,
    from, requestKey, orderNo: 'xx' + crypto.randomUUID().replaceAll('-', '').slice(0, 30) }));
  // Admission/replay only. It is not a financially verified paid-status endpoint.
  return jsonOk(c, { order_id: result.order_id, pay_price: result.pay_price, replayed: result.replayed });
}
export async function pay(c: OfflineContext) {
  const body = await readBoundedJsonObject(c.req.raw, 1024);
  only(body, ['order_id', 'pay_type', 'return_client']);
  if (body.return_client !== undefined && body.return_client !== 'pc' && body.return_client !== 'h5') throw new ValidateException('线下支付返回客户端无效');
  if (typeof body.order_id !== 'string' || !/^xx[0-9a-f]{30}$/.test(body.order_id)
    || (body.pay_type !== 'yue' && body.pay_type !== 'weixin' && body.pay_type !== 'alipay')) throw new ValidateException('线下消费订单或支付方式无效');
  const orderNo = body.order_id, payType = body.pay_type, returnClient = body.return_client, container = c.get('container'), uid = c.get('uid');
  return jsonOk(c, await available(async () => {
    const result = payType === 'yue' ? await payOfflineOrderBalance(container, { uid, orderNo })
      : await dispatchOfflineOrderPayment(container, c.env, { uid, orderNo, provider: payType === 'weixin' ? 'wechat' : 'alipay',
        // Direct edge ingress value (same-zone Worker forwarding must be trusted
        // at deployment). Never use client JSON, x-forwarded-for or a fake fallback.
        clientIp: c.req.header('CF-Connecting-IPv6') ?? c.req.header('CF-Connecting-IP') ?? '', returnClient });
    return { ...await readOfflineOrder(container, uid, orderNo), replayed: result.replayed };
  }));
}
export async function detail(c: OfflineContext) {
  if (new URL(c.req.url).search) throw new ValidateException('线下消费详情不接受查询覆盖');
  return jsonOk(c, await available(() => readOfflineOrder(c.get('container'), c.get('uid'), c.req.param('orderId') ?? '')));
}
export async function payTypes(c: OfflineContext) {
  const url = new URL(c.req.url), ids = url.searchParams.getAll('order_id'), clients = url.searchParams.getAll('return_client');
  const returnClient = clients[0];
  if (clients.length > 1 || (returnClient !== undefined && returnClient !== 'pc' && returnClient !== 'h5')) throw new ValidateException('线下支付返回客户端无效');
  if (url.search.length > 128 || [...url.searchParams.keys()].some(key => !['order_id','return_client'].includes(key)) || ids.length > 1
    || (ids.length && !/^xx[0-9a-f]{30}$/.test(ids[0]))) throw new ValidateException('支付方式查询只接受原订单号');
  return jsonOk(c, await available(() => readOfflinePaymentMethods(c.get('container'), c.env, c.get('uid'), ids[0], returnClient)));
}
export async function history(c: OfflineContext) {
  const url = new URL(c.req.url), keys = [...url.searchParams.keys()];
  if (url.search.length > 160 || keys.some(k => !['order_id', 'cursor'].includes(k)) || new Set(keys).size !== keys.length) {
    throw new ValidateException('消费记录查询只接受原订单号或分页游标');
  }
  const input = Object.fromEntries(url.searchParams);
  return jsonOk(c, await available(() => listOfflineOrders(c.get('container'), c.get('uid'), input)));
}
