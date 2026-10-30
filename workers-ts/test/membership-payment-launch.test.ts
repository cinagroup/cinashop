import {generateKeyPairSync,verify} from 'node:crypto';
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {Env} from '@/env';
import type {Container} from '@/lib/di';
import {WechatPayService} from '@/services/wechat/WechatPayService';
import {buildWechatAppPaymentLaunch,type WechatAppPaymentLaunch} from '@/services/payment/WechatPaymentLaunch';
import type {PaymentPublicScope} from '@/services/payment/PaymentPublicRuntimeConfig';

const authority=vi.hoisted(()=>({publicConfig:vi.fn(),read:vi.fn(),initiate:vi.fn(),confirm:vi.fn(),provider:vi.fn(),query:vi.fn(),refund:vi.fn()}));
vi.mock('@/services/payment/PaymentPublicRuntimeConfig',async importOriginal=>({
 ...await importOriginal<typeof import('@/services/payment/PaymentPublicRuntimeConfig')>(),readPaymentPublicConfig:authority.publicConfig,
}));
vi.mock('@/services/payment/NativeAppPaymentAuthority',()=>({
 readNativeAppPaymentAccount:authority.read,recordNativeAppPaymentInitiation:authority.initiate,
 confirmNativeAppPaymentInitiation:authority.confirm,recordNativeAppProviderEvidence:authority.provider,
 assertNativeAppQueryAccount:authority.query,assertNativeAppRefundAccount:authority.refund,
}));

/** Launch-unit boundary only: actual generated RSA signatures, with explicit
 * fixed public-configuration/account-authority mocks and synthetic POST/GET
 * provider responses. SQL selection, account/registry persistence and signed
 * HTTP response verification are covered by native-app-payment-transport and
 * restricted Native App authority suites, not this fixture. No SDK, route,
 * provider connection or financial settlement is claimed here. */
describe('membership explicit WeChat invocation parameters and unchanged legacy clients',()=>{
 let privateKey:string,publicKey:string,otherPrivate:string,otherPublic:string;
 beforeAll(()=>{const pair=()=>generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});const a=pair(),b=pair();privateKey=a.privateKey;publicKey=a.publicKey;otherPrivate=b.privateKey;otherPublic=b.publicKey;});
 beforeEach(()=>{for(const fn of Object.values(authority))fn.mockReset();});
 afterEach(()=>vi.restoreAllMocks());
 const valid=(signature:string,message:string,key=publicKey)=>verify('RSA-SHA256',Buffer.from(message),key,Buffer.from(signature,'base64'));
 const appMessage=(value:WechatAppPaymentLaunch)=>`${value.appid}\n${value.timestamp}\n${value.noncestr}\n${value.prepayid}\n`;
 function fixture(type:'app'|'jsapi',modern:boolean){
  const config:Record<string,string>={pay_weixin_open:'1',wechat_appid:'wx-member-wechat',routine_appId:'wx-member-routine',wechat_app_appid:'wx-member-native',pay_weixin_mchid:'1900000109',pay_weixin_serial_no:'AB12CD34',site_url:'https://member.example.invalid'};
  const env={WECHAT_MCH_PRIVATE_KEY:privateKey,WECHAT_API_V3_KEY:'x'.repeat(32),WECHAT_PLATFORM_PUBLIC_KEY:publicKey,CONFIG_KV:{get:vi.fn(async()=>JSON.stringify('stale-foreign-config')),put:vi.fn(),delete:vi.fn()}} as unknown as Env;
  const transaction=vi.fn(()=>{throw Error('Launch-unit fixture cannot access SQL');}),container={db:{transaction}} as unknown as Container;
  const stamp='a'.repeat(64),original={appId:config.wechat_app_appid!,merchantId:config.pay_weixin_mchid!};
  authority.publicConfig.mockImplementation(async(selected:Container,scope:PaymentPublicScope)=>{
   expect(selected).toBe(container);expect(scope).toBe(type==='app'?'merchant':'official');
   const names=['pay_weixin_mchid','pay_weixin_serial_no','site_url',...(scope==='official'?['wechat_appid','pay_weixin_open']:[])];
   return Object.freeze({scope,stamp:'b'.repeat(64),values:Object.freeze(Object.fromEntries(names.map(key=>[key,config[key]!]))) });
  });
  authority.read.mockResolvedValue({...original,stamp});
  authority.initiate.mockImplementation(async(_container:unknown,_env:unknown,input:unknown)=>input);
  authority.confirm.mockResolvedValue(undefined);
  const service=new WechatPayService(container,env),boundary=vi.spyOn(service as unknown as {callApi:(...args:unknown[])=>Promise<Record<string,unknown>>},'callApi').mockImplementation(async(method,path)=>{
   if(method==='POST'&&path===`/v3/pay/transactions/${type}`)return{prepay_id:'owned-member-prepay-1'};
   if(method==='GET'&&path==='/v3/pay/transactions/out-trade-no/hy-owned-member-order?mchid=1900000109')return{
    appid:original.appId,mchid:original.merchantId,out_trade_no:'hy-owned-member-order',trade_type:'APP',trade_state:'NOTPAY',amount:{total:990,currency:'CNY'},
   };
   throw Error('Unexpected launch-unit provider request');
  });
  const run=async(expectedPrepay='owned-member-prepay-1')=>{
   const result=await service.createOrder({profile:type==='app'?'app':'wechat',type,outTradeNo:'hy-owned-member-order',description:'owned member purchase',amount:9.90,attach:'member',...(type==='jsapi'?{openid:'owned-member-openid'}:{}),...(modern?{includeInvocationParameters:true}:{})});
   expect(authority.publicConfig).toHaveBeenCalledTimes(1);expect(authority.publicConfig).toHaveBeenCalledWith(container,type==='app'?'merchant':'official');
   expect(transaction).not.toHaveBeenCalled();expect(env.CONFIG_KV.get).not.toHaveBeenCalled();expect(env.CONFIG_KV.put).not.toHaveBeenCalled();expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
   if(type==='app'){
    expect(authority.read).toHaveBeenCalledExactlyOnceWith(container,env);
    const selection={...original,profile:'app',orderNo:'hy-owned-member-order',amountCents:990,orderDomain:'membership',currency:'CNY',configStamp:stamp};
    expect(authority.initiate).toHaveBeenCalledExactlyOnceWith(container,env,selection);
    expect(authority.confirm).toHaveBeenCalledExactlyOnceWith(container,env,selection,{...original,orderNo:'hy-owned-member-order',amountCents:990,currency:'CNY',tradeType:'APP',prepayId:expectedPrepay});
    expect(boundary).toHaveBeenCalledTimes(2);expect(boundary.mock.calls[0]!.slice(0,2)).toEqual(['POST','/v3/pay/transactions/app']);
    expect(boundary.mock.calls[0]![2]).toMatchObject({appid:original.appId,mchid:original.merchantId,attach:'member',amount:{total:990,currency:'CNY'}});
    expect(boundary.mock.calls[1]!.slice(0,3)).toEqual(['GET','/v3/pay/transactions/out-trade-no/hy-owned-member-order?mchid=1900000109',undefined]);
    expect(boundary.mock.calls[1]![3]).toBe(boundary.mock.calls[0]![3]);expect(boundary.mock.calls[0]![4]).toBe(true);expect(boundary.mock.calls[1]![4]).toBe(true);
    expect(authority.initiate.mock.invocationCallOrder[0]).toBeLessThan(boundary.mock.invocationCallOrder[0]!);
    expect(boundary.mock.invocationCallOrder[1]).toBeLessThan(authority.confirm.mock.invocationCallOrder[0]!);
   }else{
    expect(boundary).toHaveBeenCalledTimes(1);expect(authority.read).not.toHaveBeenCalled();expect(authority.initiate).not.toHaveBeenCalled();expect(authority.confirm).not.toHaveBeenCalled();
   }
   return result;
  };
  return{config,env,boundary,run};
 }
 it('builds all seven App SDK fields and verifies the exact raw-prepay four-line RSA message with an independent verifier',async()=>{
  const value=await buildWechatAppPaymentLaunch(privateKey,'wx-member-native','1900000109','owned-member-prepay-1');expect(Object.keys(value).sort()).toEqual(['appid','noncestr','package','partnerid','prepayid','sign','timestamp']);expect(value).toMatchObject({appid:'wx-member-native',partnerid:'1900000109',prepayid:'owned-member-prepay-1',package:'Sign=WXPay'});expect(value.noncestr).toMatch(/^[a-z0-9]{32}$/u);expect(value.timestamp).toMatch(/^\d{10}$/u);expect(Buffer.from(value.sign,'base64')).toHaveLength(256);expect(valid(value.sign,appMessage(value))).toBe(true);expect(valid(value.sign,appMessage(value),otherPublic)).toBe(false);expect(valid(value.sign,`${value.appid}\n${value.timestamp}\n${value.noncestr}\nprepay_id=${value.prepayid}\n`)).toBe(false);
 });
 it.each(['appid','timestamp','noncestr','prepayid'] as const)('rejects tampering of the App signed field %s under independent public-key verification',async field=>{const value=await buildWechatAppPaymentLaunch(privateKey,'wx-member-native','1900000109','owned-member-prepay-1');expect(valid(value.sign,appMessage({...value,[field]:value[field]+'x'}))).toBe(false);});
 it.each([undefined,'','bad\nprepay','x'.repeat(65),42])('rejects malformed provider prepay value %s before signing a client ticket',async value=>{await expect(buildWechatAppPaymentLaunch(privateKey,'wx-member-native','1900000109',value)).rejects.toThrow('App调起参数无效');});
 it('preserves legacy App raw prepay alongside the verified complete SDK packet even without the explicit invocation flag',async()=>{const f=fixture('app',false),value=await f.run() as WechatAppPaymentLaunch&{prepay_id:string;signType:string};expect(Object.keys(value).sort()).toEqual(['appid','noncestr','package','partnerid','prepay_id','prepayid','sign','signType','timestamp']);expect(value).toMatchObject({prepay_id:'owned-member-prepay-1',prepayid:'owned-member-prepay-1',appid:'wx-member-native',partnerid:'1900000109',package:'Sign=WXPay',signType:'RSA'});expect(valid(value.sign,appMessage(value))).toBe(true);});
 it('preserves legacy JSAPI fields and signature without appId for old shared-service callers',async()=>{const f=fixture('jsapi',false),value=await f.run();expect(Object.keys(value).sort()).toEqual(['nonceStr','package','paySign','prepay_id','signType','timeStamp']);expect(value.signType).toBe('RSA');expect(valid(String(value.paySign),`wx-member-wechat\n${value.timeStamp}\n${value.nonceStr}\n${value.package}\n`)).toBe(true);});
 it('adds the actual down-order appId to explicit JSAPI output and retains its genuine package-based signature',async()=>{const f=fixture('jsapi',true),value=await f.run();expect(value.appId).toBe('wx-member-wechat');expect(value.package).toBe('prepay_id=owned-member-prepay-1');expect(valid(String(value.paySign),`${value.appId}\n${value.timeStamp}\n${value.nonceStr}\n${value.package}\n`)).toBe(true);expect(f.boundary.mock.calls[0]![2]).toMatchObject({appid:'wx-member-wechat',mchid:'1900000109',payer:{openid:'owned-member-openid'},amount:{total:990,currency:'CNY'}});});
 it('produces complete App orderInfo from the actual selected App profile and the provider prepay ID',async()=>{const f=fixture('app',true),value=await f.run() as WechatAppPaymentLaunch;expect(value.appid).toBe('wx-member-native');expect(value.partnerid).toBe('1900000109');expect(valid(value.sign,appMessage(value))).toBe(true);expect(f.boundary.mock.calls[0]![2]).toMatchObject({appid:value.appid,mchid:value.partnerid,amount:{total:990,currency:'CNY'}});});
 it('uses the original provider credential snapshot even when public configuration and runtime signing key rotate during I/O',async()=>{const f=fixture('app',true);f.boundary.mockImplementationOnce(async()=>{f.config.wechat_app_appid='wx-replaced-native';f.config.pay_weixin_mchid='1900000299';f.env.WECHAT_MCH_PRIVATE_KEY=otherPrivate;return{prepay_id:'owned-member-prepay-original'};});const value=await f.run('owned-member-prepay-original') as WechatAppPaymentLaunch;expect(value.appid).toBe('wx-member-native');expect(value.partnerid).toBe('1900000109');expect(value.prepayid).toBe('owned-member-prepay-original');expect(valid(value.sign,appMessage(value))).toBe(true);expect(valid(value.sign,appMessage(value),otherPublic)).toBe(false);});
});
