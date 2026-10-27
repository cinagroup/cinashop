import type {MemberPayment} from '@/api/memberHome';
import {memberPlatform,memberPurchaseChannel} from '@/api/memberHome';

function field(value:unknown,max=8192):string{if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))throw Error('支付参数不完整，请查看原订单状态');return value;}
function redirect(value:unknown,provider:'weixin'|'alipay'):string{const raw=field(value,12000);let u:URL;try{u=new URL(raw);}catch{throw Error('支付地址无效，请查看原订单状态');}const hosts=provider==='weixin'?['wx.tenpay.com']:['openapi.alipay.com','openapi-sandbox.dl.alipaydev.com'];if(u.protocol!=='https:'||u.username||u.password||u.port||!hosts.includes(u.hostname))throw Error('支付地址无效，请查看原订单状态');return u.href;}
function nativePayment(options:Omit<UniApp.RequestPaymentOptions,'success'|'fail'|'complete'>):Promise<void>{
 return new Promise<void>((resolve,reject)=>{let settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};const timer=setTimeout(()=>finish(Error('微信支付结果尚未确认，请查看原订单状态')),30_000);try{uni.requestPayment({...options,success:()=>finish(),fail:()=>finish(Error('微信未确认完成，请查看原订单状态'))});}catch{finish(Error('微信支付结果尚未确认，请查看原订单状态'));}});
}
/** SDK completion is followed by a fresh server receipt; it never marks paid. */
export async function launchMemberPayment(result:MemberPayment,current:()=>boolean):Promise<void>{
 if(!current())return;
 if(result.paid)return;
 const platform=memberPlatform(),channel=memberPurchaseChannel();
 if(result.payType==='alipay'){
  // #ifdef H5
  if(typeof window!=='undefined'&&platform==='h5'){const url=redirect(result.url,'alipay');if(current())window.location.assign(url);return;}
  // #endif
  throw Error('请在原支付宝支付环境继续处理订单');
 }
 if(result.payType!=='weixin'||!result.config)throw Error('支付结果暂未确认，请查看原订单状态');
 const c=result.config;
 // #ifdef H5
 if(platform==='h5'&&typeof window!=='undefined'){
  if(channel==='weixinh5'){const url=redirect(c.h5_url,'weixin');if(current())window.location.assign(url);return;}
  const ticket={appId:field(c.appId,128),timeStamp:field(c.timeStamp,32),nonceStr:field(c.nonceStr,128),package:field(c.package,512),signType:field(c.signType,32),paySign:field(c.paySign)};
  const bridge=window.WeixinJSBridge;if(!bridge||typeof bridge.invoke!=='function')throw Error('请在原微信环境继续处理订单');
  await new Promise<void>((resolve,reject)=>{let done=false;const timer=setTimeout(()=>{if(!done){done=true;reject(Error('微信支付结果尚未确认，请查看原订单状态'));}},30_000);bridge.invoke('getBrandWCPayRequest',ticket,response=>{if(done)return;done=true;clearTimeout(timer);if(!current())return resolve();response.err_msg==='get_brand_wcpay_request:ok'?resolve():reject(Error('微信未确认完成，请查看原订单状态'));});});return;
 }
 // #endif
 // #ifdef APP-PLUS
 const orderInfo={appid:field(c.appid,128),partnerid:field(c.partnerid,128),prepayid:field(c.prepayid,512),package:field(c.package,128),noncestr:field(c.noncestr,128),timestamp:field(c.timestamp,32),sign:field(c.sign)};
 if(orderInfo.package!=='Sign=WXPay')throw Error('App支付参数无效，请查看原订单状态');
 await nativePayment({provider:'wxpay',orderInfo});return;
 // #endif
 // #ifdef MP-WEIXIN
 const signType=field(c.signType,32);if(!['MD5','HMAC-SHA256','RSA'].includes(signType))throw Error('支付签名参数无效');
 await nativePayment({provider:'wxpay',timeStamp:field(c.timeStamp,32),nonceStr:field(c.nonceStr,128),package:field(c.package,512),signType,paySign:field(c.paySign)});return;
 // #endif
 throw Error('请在原支付环境继续处理会员订单');
}
