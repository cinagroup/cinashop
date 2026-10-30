/** Import only inside APP-PLUS guards. Only public packaged identifiers are
 * consumed; this module never fetches or accepts AppSecret/merchant credentials. */
import manifest from '../manifest.json';
import { createNativeWechatPayment, NativeWechatPaymentError } from './nativeWechatPayment';
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
export function configuredNativeWechatAppId(value: unknown): string {
  const app = record(record(value)?.['app-plus']);
  const modules = record(app?.modules);
  const configs = record(record(app?.distribute)?.sdkConfigs);
  const payment = record(record(configs?.payment)?.weixin);
  const oauth = record(record(configs?.oauth)?.weixin);
  const appId = payment?.appid;
  if (!modules || !Object.hasOwn(modules, 'Payment') || !record(modules.Payment)
    || typeof appId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(appId)
    || oauth && Object.hasOwn(oauth, 'appid') && oauth.appid !== '' && oauth.appid !== appId)
    throw new NativeWechatPaymentError('unconfigured', '尚未配置打包应用的 Payment 模块和微信支付 AppID，请使用匹配的原生安装包');
  return appId;
}
export function assertNativeWechatPaymentAvailable(): string {
  const appId = configuredNativeWechatAppId(manifest);
  if (typeof uni.requestPayment !== 'function') throw new NativeWechatPaymentError('unconfigured', '当前安装包不支持原生微信支付');
  return appId;
}
const pay = createNativeWechatPayment(options => uni.requestPayment(options));
export function reserveNativeWechatPayment(isCurrent: () => boolean) {
  const appId = assertNativeWechatPaymentAvailable();
  const lease = pay.reserve(isCurrent);
  return { request: (value: unknown) => lease.request(value, appId), release: lease.release };
}
export function requestNativeWechatPayment(value: unknown, isCurrent: () => boolean): Promise<void> {
  return pay(value, assertNativeWechatPaymentAvailable(), isCurrent);
}
