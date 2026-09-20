import { offlineUuid, type OfflineTicket } from './offlineCashier';
export { offlineUuid } from './offlineCashier';
export async function offlineBrowserKey(): Promise<string> {
  if (!globalThis.crypto?.getRandomValues) throw Error('此环境缺少安全随机数能力，尚未建单');
  return offlineUuid(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}
/** Serialize journal+submission across same-origin tabs; unavailable locks fail
 * closed for new writes, while readonly recovery remains available. */
export async function offlineBrowserExclusive(uid: number, work:()=>Promise<void>): Promise<void> {
  if (!navigator.locks?.request) throw Error('此浏览器缺少安全多标签协调能力，请换用支持的浏览器；原消费仍可读取');
  await navigator.locks.request(`cinashop-offline-${uid}`, {mode:'exclusive',ifAvailable:true}, async lock=>{
    if(!lock)throw Error('另一页面正在操作原消费，请稍后重新读取；本页未发送付款请求');
    await work();
  });
}
declare global {
  interface Window {
    WeixinJSBridge?: { invoke(name: string, config: Record<string,string>, callback: (result: { err_msg?: string }) => void): void };
  }
}
/** Caller must freshly validate the ticket and owner before reaching this adapter. */
export async function launchOfflineBrowserTicket(ticket: OfflineTicket): Promise<void> {
  if (ticket.kind !== 'wechat-jsapi') { window.location.assign(ticket.url); return; }
  const bridge = window.WeixinJSBridge;
  if (!bridge || typeof bridge.invoke !== 'function') throw Error('请在原微信环境中打开；不会重新发起支付');
  const { kind: _kind, ...config } = ticket;
  await new Promise<void>((resolve,reject) => bridge.invoke('getBrandWCPayRequest',config,result => {
    if (result.err_msg === 'get_brand_wcpay_request:ok') resolve();
    else reject(Error('微信未确认完成；请重新读取原消费，不要另建单'));
  }));
  // SDK success is not payment evidence. The controller next reads the server.
}
