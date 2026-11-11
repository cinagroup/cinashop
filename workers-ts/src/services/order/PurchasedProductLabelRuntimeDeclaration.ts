/** Trusted composition data only. This is never accepted from an HTTP body. */
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from '@/migrations/managerRuntimePrivilegePlan';
export type PurchasedLabelRuntimeDeclaration = Readonly<RuntimeGiftPeerDeclarations>;
function snapshot(input: unknown): unknown {
  let nodes = 0, bytes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 8) throw Error('Bounded purchased label declaration required');
    if (value === null || value === undefined || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      bytes += value.length;
      if (value.length > 1024 || bytes > 65536) throw Error('Bounded purchased label declaration strings required');
      return value;
    }
    if (!value || typeof value !== 'object' || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw Error('Plain purchased label declaration required');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (value.length > 32 || keys.length !== value.length + 1) throw Error('Dense purchased label declaration arrays required');
      return Object.freeze(Array.from({ length: value.length }, (_, i) => {
        const d = descriptors[String(i)];
        if (!d?.enumerable || !('value' in d)) throw Error('Data-only purchased label declaration array required');
        return copy(d.value, depth + 1);
      }));
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string' || !descriptors[key]?.enumerable || !('value' in descriptors[key])) throw Error('Data-only purchased label declaration required');
      Object.defineProperty(result, key, { value: copy(descriptors[key].value, depth + 1), enumerable: true });
    }
    return Object.freeze(result);
  };
  return copy(input, 0);
}
export function capturePurchasedLabelRuntimeDeclaration(input: RuntimeGiftPeerDeclarations): PurchasedLabelRuntimeDeclaration {
  const peers = captureRuntimeGiftPeerDeclarations(snapshot(input) as RuntimeGiftPeerDeclarations), t = peers.target;
  if (!peers.purchasedProductLabels || !peers.financial || !peers.cashierSecondCard || peers.manager !== true
    || !t.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE) || !t.local.includes(MANAGER_RUNTIME_ROLE))
    throw Error('Complete five-profile purchased label runtime declaration required');
  const ids = [t.maintenance, t.app, t.admin, ...(t.local ?? [])];
  if (ids.length > 19 || new Set(ids).size !== ids.length) throw Error('Independent purchased label runtime identities required');
  for (const id of [t.database, ...ids]) pricingIdentifier(id);
  return snapshot(peers) as PurchasedLabelRuntimeDeclaration;
}
export function purchasedLabelRuntimeFromEnv(env: object): PurchasedLabelRuntimeDeclaration | undefined {
  const d = Object.getOwnPropertyDescriptor(env, 'PURCHASED_PRODUCT_LABEL_RUNTIME');
  if (!d) {
    if ('PURCHASED_PRODUCT_LABEL_RUNTIME' in env) throw Error('Own purchased label runtime configuration required');
    return undefined;
  }
  if (!d.enumerable || !('value' in d)) throw Error('Data-only purchased label environment required');
  return d.value === undefined ? undefined : capturePurchasedLabelRuntimeDeclaration(d.value);
}
