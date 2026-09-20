import { offlineBrowserKey, offlineUuid, launchOfflineBrowserTicket } from '../../../common/offlineBrowser';
import type { OfflineChannel, OfflineTicket } from '../../../common/offlineCashier';
export function offlineChannel(): OfflineChannel {
  // #ifdef H5
  if (typeof window !== 'undefined') return /MicroMessenger/i.test(window.navigator.userAgent) ? 'wechat' : 'h5';
  // #endif
  // #ifdef MP-WEIXIN
  return 'routine';
  // #endif
  throw Error('当前客户端尚未开放线下收银，请使用H5或微信小程序');
}
export async function offlineKey(): Promise<string> {
  // #ifdef H5
  if (typeof window !== 'undefined') return offlineBrowserKey();
  // #endif
  // #ifdef MP-WEIXIN
  if (typeof uni.getRandomValues === 'function') return new Promise<string>((resolve,reject)=>uni.getRandomValues({length:16,
    success:result=>{try{resolve(offlineUuid(new Uint8Array(result.randomValues)));}catch(e){reject(e);}},
    fail:()=>reject(Error('安全请求标识创建失败，尚未建单'))}));
  // #endif
  throw Error('此环境缺少安全随机数能力，尚未建单');
}
export async function launchOfflineTicket(ticket: OfflineTicket): Promise<void> {
  // #ifdef H5
  if (typeof window !== 'undefined') return launchOfflineBrowserTicket(ticket);
  // #endif
  // #ifdef MP-WEIXIN
  if (ticket.kind !== 'wechat-jsapi') throw Error('原支付入口需要在原H5环境继续，不能改用其他渠道');
  await new Promise<void>((resolve,reject)=>uni.requestPayment({provider:'wxpay',timeStamp:ticket.timeStamp,nonceStr:ticket.nonceStr,
    package:ticket.package,signType:ticket.signType,paySign:ticket.paySign,success:()=>resolve(),
    fail:()=>reject(Error('微信未确认完成，请重新读取原消费'))}));
  return;
  // #endif
  // #ifndef H5 || MP-WEIXIN
  throw Error('当前客户端尚未开放线下收银');
  // #endif
}
