/** Code-only native authorization. Provider identity is established by the
 * server exchange; SDK userInfo/authResult never becomes an account identity. */
export type NativeWechatAuthorizeErrorKind = 'unconfigured' | 'busy' | 'invalid' | 'stale' | 'cancelled' | 'failed';
export class NativeWechatAuthorizeError extends Error {
  constructor(readonly kind: NativeWechatAuthorizeErrorKind, message: string) { super(message); this.name = 'NativeWechatAuthorizeError'; }
}
export interface NativeWechatAuthorizeService {
  id: string;
  nativeClient: boolean;
  extra?: unknown;
  authorize(success: (event: unknown) => void, fail: (event: unknown) => void,
    options: { scope: 'snsapi_userinfo'; state: string; appid: string }): void;
}
export interface NativeWechatAuthorization { code: string; state: string }
export interface NativeWechatAuthorizeLease {
  authorize(challenge: { state: string; appId: string }, expectedAppId: string, onStarted?: () => void): Promise<NativeWechatAuthorization>;
  /** A local cancellation cannot cancel an already opened WeChat SDK. */
  release(): void;
}
const invalid = () => new NativeWechatAuthorizeError('invalid', '微信授权回传无效，请重新发起登录');
const stale = () => new NativeWechatAuthorizeError('stale', '登录页面或账号已变化，请重新发起登录');
const STATE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
export function checkedNativeWechatAuthorization(event: unknown, expectedState: string, extra?: unknown): NativeWechatAuthorization {
  const row = record(event);
  if (!row || typeof expectedState !== 'string' || !STATE.test(expectedState)) throw invalid();
  const code = ownValue(row, 'code'), state = ownValue(row, 'state');
  if (typeof code !== 'string' || !/^[\x21-\x7e]{1,512}$/u.test(code) || state !== expectedState) throw invalid();
  const extension = record(extra);
  if (extension && Object.hasOwn(extension, 'state') && ownValue(extension, 'state') !== expectedState) throw invalid();
  return { code, state: expectedState };
}
function sdkFailure(event: unknown): NativeWechatAuthorizeError {
  let cancelled = false;
  try {
    const row = record(event), code = row && ownValue(row, 'code'), message = row && ownValue(row, 'message');
    cancelled = code === -2 || code === '-2' || typeof message === 'string' && /cancel|取消/iu.test(message);
  } catch { /* Native failures remain sanitized even for an unreadable event. */ }
  return new NativeWechatAuthorizeError(cancelled ? 'cancelled' : 'failed', cancelled ? '微信授权已取消' : '微信授权未完成，请重试');
}
/** Reserve before requesting a server challenge. A released pre-SDK service
 * lookup cannot open WeChat later; a live SDK lease survives local retirement
 * until its first terminal callback. Only that callback releases its owner. */
export function createNativeWechatAuthorize(getServices: (success: (services: NativeWechatAuthorizeService[]) => void,
  fail: (event: unknown) => void) => void) {
  let active: object | null = null;
  return (isCurrent: () => boolean): NativeWechatAuthorizeLease => {
    const current = () => { try { return isCurrent() === true; } catch { return false; } };
    if (active) throw new NativeWechatAuthorizeError('busy', '微信授权正在处理中，请等待原授权返回');
    if (!current()) throw stale();
    const owner = {}; active = owner;
    let invoked = false, started = false, closed = false, rejectWaiting: ((error: Error) => void) | undefined;
    const release = () => {
      if (started || closed) return;
      closed = true; if (active === owner) active = null;
      rejectWaiting?.(stale());
    };
    return {
      release,
      authorize(challenge, expectedAppId, onStarted) {
        if (closed || invoked || active !== owner || !current()) { release(); return Promise.reject(stale()); }
        invoked = true;
        if (!/^[A-Za-z0-9_-]{1,32}$/u.test(expectedAppId) || challenge.appId !== expectedAppId
          || !STATE.test(challenge.state)) {
          release(); return Promise.reject(invalid());
        }
        return new Promise<NativeWechatAuthorization>((resolve, reject) => {
          let settled = false, lookupSettled = false;
          const finish = (error?: Error, value?: NativeWechatAuthorization) => {
            if (settled) return;
            settled = true; closed = true;
            if (active === owner) active = null;
            if (!current()) { reject(stale()); return; }
            if (error) reject(error); else resolve(value!);
          };
          rejectWaiting = error => finish(error);
          try {
            getServices(services => {
              if (settled || lookupSettled) return;
              lookupSettled = true;
              if (!current() || active !== owner) { finish(stale()); return; }
              try {
                const matches = Array.isArray(services) ? services.filter(service => service?.id === 'weixin') : [];
                const service = matches[0];
                if (matches.length !== 1 || service.nativeClient !== true || typeof service.authorize !== 'function') {
                  finish(new NativeWechatAuthorizeError('unconfigured', '当前安装包或设备不支持原生微信授权')); return;
                }
                started = true;
                onStarted?.();
                service.authorize(event => {
                  try { finish(undefined, checkedNativeWechatAuthorization(event, challenge.state, service.extra)); }
                  catch { finish(invalid()); }
                }, event => finish(sdkFailure(event)), { scope: 'snsapi_userinfo', state: challenge.state, appid: expectedAppId });
              } catch { finish(new NativeWechatAuthorizeError('failed', '微信授权未完成，请重试')); }
            }, event => {
              if (settled || lookupSettled) return;
              lookupSettled = true; finish(sdkFailure(event));
            });
          } catch { finish(new NativeWechatAuthorizeError('failed', '微信授权未完成，请重试')); }
        });
      },
    };
  };
}
