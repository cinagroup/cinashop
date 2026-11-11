/** Closed immutable success receipt. It proves the selected configuration and
 * scope of this occurrence; it is never a caller capability or live catalog. */
import { purchasedLabelIds, type PurchasedLabelIntent } from './PurchasedProductLabelCodec';
export interface PurchasedLabelProductConfig { productId: number; found: boolean; labelIds: string | null }
export interface PurchasedLabelBundleConfig { activityId: number; found: boolean; linkIds: string | null }
export interface PurchasedLabelGrant { labelId: number; type: 0 | 1; relationId: number; added: boolean }
export interface PurchasedLabelResult {
  format: 1; taskId: string; sourceHash: string; userId: number; financialStoreId: number;
  products: readonly PurchasedLabelProductConfig[]; bundle: PurchasedLabelBundleConfig | null;
  targets: readonly PurchasedLabelGrant[]; skipped: readonly { labelId: number; reason: 'missing' | 'retired' }[];
  completedAt: number;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const digest = /^[a-f0-9]{64}$/u;
const fail = (): never => { throw Error('购买标签不可变成功回执须维护核对'); };
const id = (v: unknown, zero = false): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= (zero ? 0 : 1) && v <= 2147483647;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !('value' in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !('value' in d)) return fail(); return d.value;
  });
}
function config(value: unknown, bundle: boolean) {
  const r = record(value, bundle ? ['activityId', 'found', 'linkIds'] : ['productId', 'found', 'labelIds']);
  const key = bundle ? 'activityId' : 'productId', csv = bundle ? 'linkIds' : 'labelIds';
  const raw = r[csv];
  if (!id(r[key]) || typeof r.found !== 'boolean' || !r.found && raw !== null
    || raw !== null && (typeof raw !== 'string' || raw.length > (bundle ? 255 : 64))) return fail();
  purchasedLabelIds(raw);
  return Object.freeze(r);
}
export function capturePurchasedLabelResult(value: unknown, intent: PurchasedLabelIntent, taskId: string, sourceHash: string): Readonly<PurchasedLabelResult> {
  const r = record(value, ['format', 'taskId', 'sourceHash', 'userId', 'financialStoreId', 'products', 'bundle', 'targets', 'skipped', 'completedAt']);
  if (!uuid.test(taskId) || !digest.test(sourceHash) || r.format !== 1 || r.taskId !== taskId || r.sourceHash !== sourceHash
    || r.userId !== intent.userId || r.financialStoreId !== intent.financialStoreId || !id(r.completedAt)) return fail();
  const products = array(r.products, 200).map(p => config(p, false)) as unknown as PurchasedLabelProductConfig[];
  const ids = [...new Set(intent.carts.map(c => c.productId))].sort((a, b) => a-b);
  if (JSON.stringify(products.map(p => p.productId)) !== JSON.stringify(ids)) return fail();
  const needsBundle = intent.orderType === 5 && intent.activityId > 0;
  const bundle = r.bundle === null ? null : config(r.bundle, true) as unknown as PurchasedLabelBundleConfig;
  if (needsBundle ? !bundle || bundle.activityId !== intent.activityId : bundle !== null) return fail();
  const requested = new Set([...products.flatMap(p => purchasedLabelIds(p.labelIds)), ...purchasedLabelIds(bundle?.linkIds ?? null)]);
  const seen = new Set<number>();
  const targets = array(r.targets, 10000).map(v => {
    const t = record(v, ['labelId', 'type', 'relationId', 'added']);
    if (!id(t.labelId) || !requested.has(t.labelId) || seen.has(t.labelId) || typeof t.added !== 'boolean'
      || !(t.type === 0 && t.relationId === 0 || t.type === 1 && intent.financialStoreId > 0 && t.relationId === intent.financialStoreId)) return fail();
    seen.add(t.labelId); return Object.freeze(t) as unknown as PurchasedLabelGrant;
  });
  const skipped = array(r.skipped, 10000).map(v => {
    const s = record(v, ['labelId', 'reason']);
    if (!id(s.labelId) || !requested.has(s.labelId) || seen.has(s.labelId) || (typeof s.reason !== 'string' || !['missing', 'retired'].includes(s.reason))) return fail();
    seen.add(s.labelId); return Object.freeze(s) as unknown as { labelId: number; reason: 'missing' | 'retired' };
  });
  if (seen.size !== requested.size || [targets, skipped].some(rows => rows.some((v, i) => i > 0 && v.labelId <= rows[i-1]!.labelId))) return fail();
  const result = Object.freeze({ ...r, products: Object.freeze(products), bundle, targets: Object.freeze(targets), skipped: Object.freeze(skipped) }) as unknown as Readonly<PurchasedLabelResult>;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1048576) return fail();
  return result;
}
