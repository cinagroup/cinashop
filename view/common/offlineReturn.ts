/** Navigation context only. Neither a return URL nor provider query parameters
 * authorize payment or prove collection. Pages drops all unneeded parameters. */
export type OfflineReturnClient = 'pc' | 'h5';
export const offlineReturnPath = '/offline-payment-return';
const orderPattern = /^xx[0-9a-f]{30}$/;
const validOrder = (value: unknown): value is string => typeof value === 'string' && value.length === 32 && orderPattern.test(value);
export function offlineReturnOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 180 || !/^https:\/\/[a-z0-9.-]+$/.test(value)) throw Error('线下支付返回站点未配置');
  const url = new URL(value);
  if (url.origin !== value || !/\.[a-z]{2,63}$/.test(url.hostname)
    || url.hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw Error('线下支付返回站点无效');
  return url.origin;
}
export function offlineReturnUrl(origin: string, orderId: string): string {
  if (!validOrder(orderId)) throw Error('线下消费订单链接无效');
  const value = `${offlineReturnOrigin(origin)}${offlineReturnPath}?orderId=${orderId}`;
  if (value.length > 256) throw Error('线下支付返回地址过长');
  return value;
}
export function isOfflineReturnUrl(value: string, orderId: string): boolean {
  try { const url = new URL(value); return value === offlineReturnUrl(url.origin, orderId); }
  catch { return false; }
}
/** Old tickets may omit navigation context; never rewrite their signed bytes.
 * Any supplied context must be unique and refer to the original order. */
export function validOfflineTicketReturn(url: URL, field: 'return_url' | 'redirect_url', orderId: string): boolean {
  const values = url.searchParams.getAll(field);
  return values.length === 0 || (values.length === 1 && isOfflineReturnUrl(values[0], orderId));
}
export function offlineReturnResponse(request: Request, client: OfflineReturnClient): Response {
  const headers = { 'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff',
    'Content-Type':'text/plain; charset=utf-8', 'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'" };
  if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{...headers,Allow:'GET, HEAD'}});
  try {
    const url = new URL(request.url), ids = url.searchParams.getAll('orderId'), merchantIds = url.searchParams.getAll('out_trade_no');
    if (!['pc','h5'].includes(client) || url.pathname !== offlineReturnPath || url.search.length > 8192 || ids.length !== 1 || !validOrder(ids[0])
      || merchantIds.length > 1 || (merchantIds.length === 1 && merchantIds[0] !== ids[0])) throw Error('invalid return');
    // Relative, fixed same-origin destination. Never propagate success, amounts,
    // identities, signature material, redirect targets or other provider fields.
    const path = client === 'pc' ? '/user/offline-result' : '/#/pages/annex/offline_result/index';
    return new Response(null,{status:303,headers:{...headers,Location:`${path}?orderId=${ids[0]}`}});
  } catch {
    return new Response(request.method==='HEAD'?null:'无法识别原消费，请从收银入口查找并核对；本次返回不代表付款成功。',{status:400,headers});
  }
}
