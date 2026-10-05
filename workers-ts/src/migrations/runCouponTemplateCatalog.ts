import type { DbClient } from '../lib/di';
import { COUPON_TEMPLATE_CATALOG_SQL } from './couponTemplateCatalog';

/** Explicit maintenance-only schema forward. Runtime commissioning is separate. */
export async function runCouponTemplateCatalog(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Coupon template catalog requires a root database connection');
  await db.$client.begin('isolation level read committed', async tx => {
    await tx.unsafe(COUPON_TEMPLATE_CATALOG_SQL);
  });
}
