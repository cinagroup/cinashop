import {generateKeyPairSync,verify} from 'node:crypto';
import {beforeAll,afterEach,describe,it,expect,vi} from 'vitest';
import type {Env} from '@/env';
import type {Container} from '@/lib/di';
import {WechatPayService} from '@/services/wechat/WechatPayService';
import {buildWechatAppPaymentLaunch,type WechatAppPaymentLaunch} from '@/services/payment/WechatPaymentLaunch';

/** Unit provider-I/O boundary only: generated temporary RSA keys and a synthetic
 * prepay identifier. No route, native transaction, merchant account, provider
 * response verification or real financial settlement is claimed here. */
describe('membership explicit WeChat invocation parameters and unchanged legacy clients',()=>{
 let privateKey:string,publicKey:string,otherPrivate:string,otherPublic:string;
 beforeAll(()=>{const pair=()=>generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});const a=pair(),b=pair();privateKey=a.privateKey;publicKey=a.publicKey;otherPrivate=b.privateKey;otherPublic=b.publicKey;});
 afterEach(()=>vi.restoreAllMocks());
 const valid=(signature:string,message:string,key=publicKey)=>verify('RSA-SHA256',Buffer.from(message),key,Buffer.from(signature,'base64'));
 const appMessage=(value:WechatAppPaymentLaunch)=>`${value.appid}\n${value.timestamp}\n${value.noncestr}\n${value.prepayid}\n`;
 function fixture(type:'app'|'jsapi',modern:boolean){
  const config:Record<string,string>={pay_weixin_open:'1',wechat_appid:'wx-member-wechat',routine_appId:'wx-member-routine',wechat_app_appid:'wx-member-native',pay_weixin_mchid:'1900000109',pay_weixin_serial_no:'AB12CD34',site_url:'https://member.example.invalid'};
  const env={WECHAT_MCH_PRIVATE_KEY:privateKey,WECHAT_API_V3_KEY:'x'.repeat(32),WECHAT_PLATFORM_PUBLIC_KEY:publicKey,CONFIG_KV:{get:async(key:string)=>config[key.slice(4)]??'',put:vi.fn(),delete:vi.fn()}} as unknown as Env;
  const service=new WechatPayService({} as Container,env),boundary=vi.spyOn(service as unknown as {callApi:(...args:unknown[])=>Promise<Record<string,unknown>>},'callApi').mockResolvedValue({prepay_id:'owned-member-prepay-1'});
  const run=()=>service.createOrder({profile:type==='app'?'app':'wechat',type,outTradeNo:'hy-owned-member-order',description:'owned member purchase',amount:9.90,...(type==='jsapi'?{openid:'owned-member-openid'}:{}),...(modern?{includeInvocationParameters:true}:{})});
  return{config,env,boundary,run};
 }
 it('builds all seven App SDK fields and verifies the exact raw-prepay four-line RSA message with an independent verifier',async()=>{
  const value=await buildWechatAppPaymentLaunch(privateKey,'wx-member-native','1900000109','owned-member-prepay-1');expect(Object.keys(value).sort()).toEqual(['appid','noncestr','package','partnerid','prepayid','sign','timestamp']);expect(value).toMatchObject({appid:'wx-member-native',partnerid:'1900000109',prepayid:'owned-member-prepay-1',package:'Sign=WXPay'});expect(value.noncestr).toMatch(/^[a-z0-9]{32}$/u);expect(value.timestamp).toMatch(/^\d{10}$/u);expect(Buffer.from(value.sign,'base64')).toHaveLength(256);expect(valid(value.sign,appMessage(value))).toBe(true);expect(valid(value.sign,appMessage(value),otherPublic)).toBe(false);expect(valid(value.sign,`${value.appid}\n${value.timestamp}\n${value.noncestr}\nprepay_id=${value.prepayid}\n`)).toBe(false);
 });
 it.each(['appid','timestamp','noncestr','prepayid'] as const)('rejects tampering of the App signed field %s under independent public-key verification',async field=>{const value=await buildWechatAppPaymentLaunch(privateKey,'wx-member-native','1900000109','owned-member-prepay-1');expect(valid(value.sign,appMessage({...value,[field]:value[field]+'x'}))).toBe(false);});
 it.each([undefined,'','bad\nprepay','x'.repeat(65),42])('rejects malformed provider prepay value %s before signing a client ticket',async value=>{await expect(buildWechatAppPaymentLaunch(privateKey,'wx-member-native','1900000109',value)).rejects.toThrow('App调起参数无效');});
 it('preserves the legacy App raw prepay result when explicit invocation parameters are absent',async()=>{const f=fixture('app',false);expect(await f.run()).toEqual({prepay_id:'owned-member-prepay-1'});expect(f.boundary).toHaveBeenCalledTimes(1);expect(f.boundary.mock.calls[0]!.slice(0,2)).toEqual(['POST','/v3/pay/transactions/app']);});
 it('preserves legacy JSAPI fields and signature without appId for old shared-service callers',async()=>{const f=fixture('jsapi',false),value=await f.run();expect(Object.keys(value).sort()).toEqual(['nonceStr','package','paySign','prepay_id','signType','timeStamp']);expect(value.signType).toBe('RSA');expect(valid(String(value.paySign),`wx-member-wechat\n${value.timeStamp}\n${value.nonceStr}\n${value.package}\n`)).toBe(true);});
 it('adds the actual down-order appId to explicit JSAPI output and retains its genuine package-based signature',async()=>{const f=fixture('jsapi',true),value=await f.run();expect(value.appId).toBe('wx-member-wechat');expect(value.package).toBe('prepay_id=owned-member-prepay-1');expect(valid(String(value.paySign),`${value.appId}\n${value.timeStamp}\n${value.nonceStr}\n${value.package}\n`)).toBe(true);expect(f.boundary.mock.calls[0]![2]).toMatchObject({appid:'wx-member-wechat',mchid:'1900000109',payer:{openid:'owned-member-openid'},amount:{total:990,currency:'CNY'}});});
 it('produces complete App orderInfo from the actual selected App profile and the provider prepay ID',async()=>{const f=fixture('app',true),value=await f.run() as WechatAppPaymentLaunch;expect(value.appid).toBe('wx-member-native');expect(value.partnerid).toBe('1900000109');expect(valid(value.sign,appMessage(value))).toBe(true);expect(f.boundary.mock.calls[0]![2]).toMatchObject({appid:value.appid,mchid:value.partnerid,amount:{total:990,currency:'CNY'}});});
 it('uses the original provider credential snapshot even when public configuration and runtime signing key rotate during I/O',async()=>{const f=fixture('app',true);f.boundary.mockImplementationOnce(async()=>{f.config.wechat_app_appid='wx-replaced-native';f.config.pay_weixin_mchid='1900000299';f.env.WECHAT_MCH_PRIVATE_KEY=otherPrivate;return{prepay_id:'owned-member-prepay-original'};});const value=await f.run() as WechatAppPaymentLaunch;expect(value.appid).toBe('wx-member-native');expect(value.partnerid).toBe('1900000109');expect(value.prepayid).toBe('owned-member-prepay-original');expect(valid(value.sign,appMessage(value))).toBe(true);expect(valid(value.sign,appMessage(value),otherPublic)).toBe(false);});
});
