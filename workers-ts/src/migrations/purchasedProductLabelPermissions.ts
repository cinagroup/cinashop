/** Explicit prospective successor. Names come from the operator's declaration;
 * capabilities are fixed here and are never inferred from current grants. */
import { pricingIdentifier } from './checkoutPricingLockCatalog';
export const PURCHASED_LABEL_TABLE_PRIVILEGES = {
  app: { purchased_product_label_intent: ['SELECT', 'INSERT'], purchased_product_label_state: ['SELECT', 'INSERT'],
    purchased_product_label_result: ['SELECT', 'INSERT'] },
  admin: { purchased_product_label_intent: ['SELECT', 'INSERT'], purchased_product_label_state: ['SELECT', 'INSERT'],
    purchased_product_label_result: ['SELECT'] },
} as const;
export const PURCHASED_LABEL_STATE_UPDATE = {
  app: ['status', 'dispatch_count', 'attempt_count', 'available_at', 'lease_until', 'lease_token', 'last_error', 'processed_at', 'updated_at'],
  admin: ['status', 'dispatch_count', 'attempt_count', 'replay_count', 'available_at', 'lease_until', 'lease_token', 'last_error', 'processed_at', 'updated_at'],
} as const;
export interface PurchasedLabelPrincipals { app: string; admin: string }
export function capturePurchasedLabelPrincipals(input: PurchasedLabelPrincipals): Readonly<PurchasedLabelPrincipals> {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 2)
    throw Error('Exact named purchased label principals required');
  const result: Record<string, string> = {};
  for (const key of ['app', 'admin']) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string') throw Error('Data-only purchased label principals required');
    pricingIdentifier(d.value); result[key] = d.value;
  }
  if (result.app === result.admin) throw Error('Independent purchased label principals required');
  return Object.freeze({ app: result.app!, admin: result.admin! });
}
export function purchasedLabelExpectedAcl(input?: PurchasedLabelPrincipals): string[] {
  if (!input) return [];
  const roles = capturePurchasedLabelPrincipals(input), result: string[] = [], columns = new Set<string>();
  for (const kind of ['app', 'admin'] as const) {
    for (const [table, privileges] of Object.entries(PURCHASED_LABEL_TABLE_PRIVILEGES[kind]))
      for (const privilege of privileges) result.push(`table:${table}:${roles[kind]}:${privilege}`);
    for (const column of PURCHASED_LABEL_STATE_UPDATE[kind]) {
      columns.add(column); result.push(`column:purchased_product_label_state:${column}:${roles[kind]}:UPDATE`);
    }
  }
  for (const column of columns) result.push(`marker:purchased_product_label_state:${column}`);
  return result.sort();
}
