import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';

/** Maintenance-only input, never a customer parameter. The caller must have
 * pre-provisioned a separate restricted NOLOGIN owner for this isolated clone.
 * Installation still verifies the real owner/ACL/catalog; syntax is not trust. */
export function requireCheckoutScenarioPricingOwner(value: string | null | undefined): string {
  if (!value) throw Error('Checkout scenario requires an explicit clone pricing owner');
  pricingIdentifier(value);
  return value;
}

/** Call only after the existing audit-token and route/method checks. Keeping the
 * owner explicit per invocation avoids session-setting assumptions in pools.
 * This is an identifier, not a credential, and never authorizes role creation. */
export function checkoutScenarioPricingOwner(request: Request): string {
  return requireCheckoutScenarioPricingOwner(request.headers.get('X-Audit-Pricing-Owner'));
}
