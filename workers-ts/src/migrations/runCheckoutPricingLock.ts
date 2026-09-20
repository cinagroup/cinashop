import { installCheckoutPricingLock } from './checkoutPricingLock';

/** Root-only numbered migration. Requires the connection's explicitly supplied
 * cinashop.checkout_pricing_owner; never guesses an owner or creates a role. */
export async function runCheckoutPricingLockSchema(db: Parameters<typeof installCheckoutPricingLock>[0]): Promise<void> {
  await installCheckoutPricingLock(db, undefined);
}
