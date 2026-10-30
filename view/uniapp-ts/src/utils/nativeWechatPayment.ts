/** Pure native wxpay DTO projection. It validates syntax and the explicit
 * public packaged AppID; merchant ownership and signatures remain server facts.
 * SDK completion never proves that an order was paid. */
export interface NativeWechatOrderInfo {
  appid: string;
  partnerid: string;
  prepayid: string;
  package: 'Sign=WXPay';
  noncestr: string;
  timestamp: string;
  sign: string;
}
export type NativeWechatPaymentErrorKind = 'invalid' | 'unconfigured' | 'busy' | 'stale' | 'cancelled' | 'failed';
export class NativeWechatPaymentError extends Error {
  constructor(readonly kind: NativeWechatPaymentErrorKind, message: string) { super(message); this.name = 'NativeWechatPaymentError'; }
}
const invalid = () => new NativeWechatPaymentError('invalid', '原生微信支付参数无效，请刷新订单核对');
export function checkedNativeWechatOrderInfo(value: unknown, expectedAppId: string): NativeWechatOrderInfo {
  if (typeof expectedAppId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(expectedAppId))
    throw new NativeWechatPaymentError('unconfigured', '尚未配置打包应用的原生微信支付 AppID');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const row = value as Record<string, unknown>;
  const allowed = ['appid', 'partnerid', 'prepayid', 'package', 'noncestr', 'timestamp', 'sign', 'prepay_id', 'signType'];
  const descriptors = Object.getOwnPropertyDescriptors(row);
  if (Reflect.ownKeys(row).some(key => typeof key !== 'string' || !allowed.includes(key))
    || allowed.slice(0, 7).some(key => !Object.hasOwn(row, key))) throw invalid();
  for (const property of Object.values(descriptors)) if (!property.enumerable || !Object.hasOwn(property, 'value')) throw invalid();
  if (row.appid !== expectedAppId || typeof row.partnerid !== 'string' || !/^\d{1,32}$/u.test(row.partnerid)
    || typeof row.prepayid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(row.prepayid)
    || row.package !== 'Sign=WXPay' || typeof row.noncestr !== 'string' || !/^[A-Za-z0-9]{1,32}$/u.test(row.noncestr)
    || typeof row.timestamp !== 'string' || !/^[1-9]\d{0,15}$/u.test(row.timestamp) || !Number.isSafeInteger(Number(row.timestamp))
    || typeof row.sign !== 'string' || row.sign.length < 16 || row.sign.length > 2048 || row.sign.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row.sign)
    || Object.hasOwn(row, 'prepay_id') && row.prepay_id !== row.prepayid
    || Object.hasOwn(row, 'signType') && row.signType !== 'RSA') throw invalid();
  return { appid: expectedAppId, partnerid: row.partnerid, prepayid: row.prepayid, package: 'Sign=WXPay',
    noncestr: row.noncestr, timestamp: row.timestamp, sign: row.sign };
}
export interface NativeWechatPaymentCall {
  provider: 'wxpay';
  orderInfo: NativeWechatOrderInfo;
  success: (value?: unknown) => void;
  fail: (value?: unknown) => void;
}
export interface NativeWechatPaymentLease {
  request(value: unknown, expectedAppId: string): Promise<void>;
  /** Releases an attempt only while it has not entered the native SDK. */
  release(): void;
}
/** One instance belongs to the whole native entry module, shared by all pages.
 * Reserve synchronously before the first order/prepay mutation. Once the SDK
 * starts, only its own first callback can release that attempt. */
export function createNativeWechatPayment(send: (options: NativeWechatPaymentCall) => void) {
  let active: object | null = null;
  const stale = () => new NativeWechatPaymentError('stale', '支付页面或登录状态已变化，请刷新核对订单');
  const reserve = (isCurrent: () => boolean): NativeWechatPaymentLease => {
    const current = () => { try { return isCurrent() === true; } catch { return false; } };
    if (active) throw new NativeWechatPaymentError('busy', '原生微信支付正在处理中，请先核对原交易');
    if (!current()) throw stale();
    const owner = {};
    let started = false;
    active = owner;
    const release = () => { if (!started && active === owner) active = null; };
    return {
      release,
      request(value, expectedAppId) {
        if (active !== owner || started) return Promise.reject(stale());
        let orderInfo: NativeWechatOrderInfo;
        try {
          orderInfo = checkedNativeWechatOrderInfo(value, expectedAppId);
          if (!current()) throw stale();
        } catch (error) { release(); return Promise.reject(error); }
        started = true;
        return new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (failed: boolean, value?: unknown) => {
            if (settled) return;
            settled = true;
            if (active === owner) active = null;
            if (!current()) { reject(stale()); return; }
            if (!failed) { resolve(); return; }
            const message = value && typeof value === 'object' ? (value as { errMsg?: unknown }).errMsg : undefined;
            const cancelled = typeof message === 'string' && /cancel|取消/iu.test(message);
            reject(new NativeWechatPaymentError(cancelled ? 'cancelled' : 'failed', cancelled
              ? '微信支付已取消，请核对订单状态' : '微信支付未完成，请核对订单状态'));
          };
          try { send({ provider: 'wxpay', orderInfo, success: () => finish(false), fail: value => finish(true, value) }); }
          catch { finish(true); }
        });
      },
    };
  };
  const pay = (value: unknown, expectedAppId: string, isCurrent: () => boolean): Promise<void> => {
    let lease: NativeWechatPaymentLease;
    try { lease = reserve(isCurrent); } catch (error) { return Promise.reject(error); }
    return lease.request(value, expectedAppId).finally(lease.release);
  };
  return Object.assign(pay, { reserve });
}
