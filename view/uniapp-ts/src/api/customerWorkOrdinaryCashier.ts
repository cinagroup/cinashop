import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';
import { customerWorkCanonicalJson } from '../../../common/customerWorkIntent';

export const CUSTOMER_ORDINARY_CASHIER_VERSION = 'customer-cashier-ordinary-v1' as const;
export const CUSTOMER_ORDINARY_CASHIER_PAYMENT_VERSION = 'customer-cashier-ordinary-payment-v1' as const;
export interface OrdinaryCashierRow { product_id: number; sku_unique: string; quantity: number }
export interface OrdinaryCashierDraftInput {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION;
  scope_key: string; buyer_uid: number; tourist_key: string; rows: readonly OrdinaryCashierRow[];
}
export interface OrdinaryCashierManualAddress {
  realName: string; phone: string; province: string; city: string;
  district: string; street: string; detail: string; cityId: number;
}
export interface OrdinaryCashierIntent {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION;
  scope_key: string; draft_key: string; draft_hash: string; buyer_uid: number; tourist_key: string;
  coupon_id: number; use_integral: boolean; shipping_type: 1 | 2; store_id: number; address_id: number;
  manual_address: OrdinaryCashierManualAddress | null; real_name: string;
  user_phone: string; mark: string; custom_form: unknown;
}
export interface OrdinaryCashierQuantityInput {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION;
  scope_key: string; draft_key: string; draft_hash: string; cart_id: number; quantity: number;
}
export interface OrdinaryCashierAddRowsInput {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION;
  scope_key: string; draft_key: string; draft_hash: string; rows: readonly OrdinaryCashierRow[];
}
export interface OrdinaryCashierRemoveInput {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION;
  scope_key: string; draft_key: string; draft_hash: string; cart_ids: readonly number[];
}
export interface OrdinaryCashierPaymentInput {
  version: typeof CUSTOMER_ORDINARY_CASHIER_PAYMENT_VERSION;
  scope_key: string; order_id: number; order_no: string; expected_amount: string;
}
export interface OrdinaryCashierReadQuery { scope_key: string; page?: number; limit?: number; keyword?: string }
export interface OrdinaryCashierCouponQuery { scope_key: string; request_key: string; limit: number; before: number }
export interface OrdinaryCashierRead<T> {
  version: 'customer-cashier-ordinary-read-v1'; actor_uid: number;
  principal: { kind: 'customer-order-manager'; service_id: number; scope: 'global' };
  scope_key: string; consistency_key: string; data: T;
}

const base = '/mobile/work/cashier/ordinary';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const uuidPattern = new RegExp(`^${uuid}$`, 'u');
export function ordinaryCashierEndpoint(path: string, method: 'GET' | 'POST'): boolean {
  if (method === 'GET') {
    if ([`${base}/readiness`, `${base}/catalog`, `${base}/users`].includes(path)) return true;
    if (new RegExp(`^${base}/(?:drafts|operations)/${uuid}$`, 'u').test(path)
      || new RegExp(`^${base}/quotes/[a-f0-9]{32}/coupons$`, 'u').test(path)) return true;
    const identity = path.match(/^\/mobile\/work\/cashier\/ordinary\/(?:catalog\/([1-9]\d{0,9})|users\/([1-9]\d{0,9})\/addresses)$/u);
    return !!identity && Number(identity[1] ?? identity[2]) <= 2_147_483_647;
  }
  if ([`${base}/drafts`, `${base}/quote`, `${base}/orders`].includes(path)) return true;
  if (new RegExp(`^${base}/operations/${uuid}/abandon$`, 'u').test(path)) return true;
  if (new RegExp(`^${base}/drafts/${uuid}/(?:rows|quantity|remove)$`, 'u').test(path)) return true;
  const payment = path.match(/^\/mobile\/work\/cashier\/ordinary\/orders\/([1-9]\d{0,9})\/cash$/u);
  return !!payment && Number(payment[1]) <= 2_147_483_647;
}

/** A transport for the independent ordinary cashier contract. The caller owns
 * the durable operation journal and must recover UNKNOWN using its original
 * UUID; this transport never creates a replacement operation or retries writes. */
export function createOrdinaryCashierRequests(current: () => boolean, deadlineMs = 12_000) {
  const auth = useAuthStore();
  const owner = Object.freeze({ uid: auth.uid, token: auth.token, version: auth.sessionVersion });
  const cancellations = new Set<() => void>();
  let disposed = false;
  const active = () => !disposed && current() && auth.uid === owner.uid
    && auth.token === owner.token && auth.sessionVersion === owner.version;
  function abort() {
    disposed = true;
    for (const cancel of [...cancellations]) cancel();
    cancellations.clear();
  }
  function request<T = unknown>(path: string, method: 'GET' | 'POST' = 'GET', data: Record<string, unknown> = {}, key?: string): Promise<T> {
    if (!active() || !owner.token || owner.uid < 1) return Promise.reject(new RequestError('请登录原经营账号后核对收银结果'));
    const write = method === 'POST' && path !== `${base}/quote`;
    if (!ordinaryCashierEndpoint(path, method) || (write ? !key || !uuidPattern.test(key) : key !== undefined)) {
      return Promise.reject(new RequestError('普通收银地址或原请求编号无效，尚未提交'));
    }
    const abandoned = path.match(new RegExp(`^${base}/operations/(${uuid})/abandon$`, 'u'));
    if (abandoned && key !== abandoned[1]) return Promise.reject(new RequestError('永久放弃须使用同一原请求编号，尚未提交'));
    let snapshot: Record<string, unknown>;
    try { snapshot = JSON.parse(customerWorkCanonicalJson(data)); }
    catch { return Promise.reject(new RequestError('收银原内容不是有效 JSON，尚未提交')); }
    return new Promise((resolve, reject) => {
      let done = false, task: UniApp.RequestTask | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      function finish(value: T | undefined, failure?: Error) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        cancellations.delete(cancel);
        if (failure) reject(failure); else resolve(value as T);
      }
      const cancel = () => {
        finish(undefined, new RequestError('页面或账号已变化，请保留原收银编号核对'));
        task?.abort();
      };
      cancellations.add(cancel);
      timer = setTimeout(() => {
        finish(undefined, new RequestError('收银请求超时，请查询原编号结果'));
        task?.abort();
      }, deadlineMs);
      task = uni.request({ url: `${API_BASE}/api${path}`, method, data: snapshot, timeout: deadlineMs,
        header: { 'Form-type': getFormType(), 'Authori-zation': `Bearer ${owner.token}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(write ? { 'Idempotency-Key': key! } : {}) },
        success: response => {
          if (done) return;
          if (!active()) { cancel(); return; }
          const body = response.data as { status?: unknown; msg?: unknown; data?: T } | null;
          if (!body || typeof body.status !== 'number' || response.statusCode < 200 || response.statusCode >= 300 || body.status !== 200) {
            const businessFailure = response.statusCode >= 200 && response.statusCode < 300
              && typeof body?.status === 'number' && body.status !== 200;
            const failure = new RequestError(businessFailure && typeof body?.msg === 'string' && body.msg.trim()
              ? body.msg : '收银响应未确认，请核对原编号结果',
              typeof body?.status === 'number' ? body.status : undefined, undefined, response.statusCode);
            if (body && [410000, 410001, 410002].includes(Number(body.status))) auth.clear();
            finish(undefined, failure); return;
          }
          finish(body.data);
        },
        fail: failure => {
          if (done) return;
          if (!active()) { cancel(); return; }
          finish(undefined, new RequestError(failure.errMsg || '收银结果未确认，请继续查询原编号'));
        },
      });
    });
  }
  return { owner, active, abort, request };
}
export type OrdinaryCashierRequests = ReturnType<typeof createOrdinaryCashierRequests>;
