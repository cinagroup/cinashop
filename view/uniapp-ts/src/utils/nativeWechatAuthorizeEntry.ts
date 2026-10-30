/** APP-PLUS only. Public identifiers are compared before requesting a server
 * challenge; no AppSecret or SDK access token is read by this module. */
import manifest from '../manifest.json';
import { createNativeWechatAuthorize, NativeWechatAuthorizeError, type NativeWechatAuthorizeService } from './nativeWechatAuthorize';
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
export function configuredNativeWechatOAuthAppId(value: unknown): string {
  const app = record(record(value)?.['app-plus']), modules = record(app?.modules);
  const configs = record(record(app?.distribute)?.sdkConfigs);
  const oauth = record(record(configs?.oauth)?.weixin), payment = record(record(configs?.payment)?.weixin);
  const appId = oauth?.appid;
  if (!modules || !Object.hasOwn(modules, 'OAuth') || !record(modules.OAuth)
    || typeof appId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(appId)
    || payment && Object.hasOwn(payment, 'appid') && payment.appid !== '' && payment.appid !== appId)
    throw new NativeWechatAuthorizeError('unconfigured', '请使用已配置微信 OAuth 模块和 AppID 的匹配原生安装包');
  return appId;
}
export function assertNativeWechatAuthorizeAvailable(): string {
  const appId = configuredNativeWechatOAuthAppId(manifest);
  if (typeof plus === 'undefined' || typeof plus.oauth?.getServices !== 'function')
    throw new NativeWechatAuthorizeError('unconfigured', '当前安装包不支持原生微信授权');
  return appId;
}
const reserve = createNativeWechatAuthorize((success, fail) => plus.oauth.getServices(
  services => success(services as NativeWechatAuthorizeService[]), fail));
export function reserveNativeWechatAuthorize(isCurrent: () => boolean) {
  const appId = assertNativeWechatAuthorizeAvailable(), lease = reserve(isCurrent);
  return { appId, release: lease.release,
    authorize: (challenge: { state: string; appId: string }, onStarted?: () => void) => lease.authorize(challenge, appId, onStarted) };
}
