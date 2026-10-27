import { generateNonceStr, rsaSign } from '@/utils/wechat-crypto';
import { ValidateException } from '@/utils/errors';

export type WechatAppPaymentLaunch = { appid:string; partnerid:string; prepayid:string;
  package:'Sign=WXPay'; noncestr:string; timestamp:string; sign:string };

/** APP APIv3 signs the raw prepay ID, not JSAPI's prepay_id= package string.
 * The caller supplies the exact credential snapshot used for the real provider
 * request. No second config lookup may select a different AppID or signing key.
 * https://pay.wechatpay.cn/doc/v3/merchant/4013070351
 */
export async function buildWechatAppPaymentLaunch(privateKeyPem:string,appId:string,merchantId:string,prepayId:unknown):Promise<WechatAppPaymentLaunch>{
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(appId)||!/^\d{1,32}$/.test(merchantId)
    ||typeof prepayId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(prepayId))throw new ValidateException('微信App调起参数无效，请查询原订单状态');
  const timestamp=String(Math.floor(Date.now()/1000)),noncestr=generateNonceStr();
  const sign=await rsaSign(privateKeyPem,`${appId}\n${timestamp}\n${noncestr}\n${prepayId}\n`);
  return{appid:appId,partnerid:merchantId,prepayid:prepayId,package:'Sign=WXPay',noncestr,timestamp,sign};
}
