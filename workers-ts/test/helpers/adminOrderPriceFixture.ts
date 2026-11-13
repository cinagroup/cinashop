import { sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { installAdminOrderPriceOperation } from '@/migrations/adminOrderPriceOperation';
import { SUPPLIER_ORDER_PRICE_REVISION_EVENTS } from '@/migrations/supplierOrderPriceRevision';

export const priceActor = (id = 1000, password = 'owned-price-manager-password') =>
  ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 });

/** Owned native business fixtures commission the exact current outbox contract
 * directly. This is not evidence for an upgrade from an older catalog; the
 * separate migration tests exercise the reviewed production installer. */
export async function preparePriceFixture(db: DbClient, writer?: string, readers: string[] = []) {
  await withTx(createContainerFromDb(db), tx => installAdminOrderPriceOperation(tx, writer));
  await db.execute(sql.raw(`ALTER TABLE public.store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck;
    ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (event_type IN (${SUPPLIER_ORDER_PRICE_REVISION_EVENTS.map(event => "'" + event + "'").join(',')}))`));
  for (const role of readers) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw Error('Invalid owned price reader');
    await db.execute(sql.raw(`GRANT SELECT ON public.admin_order_price_operation_v1 TO "${role}"`));
  }
}

export async function seedPriceActor(db: DbClient) {
  await db.insert(systemAdmin).values({ id: 1000, account: 'owned-price-manager', pwd: 'owned-price-manager-password',
    adminType: 1, relationId: 0, level: 0, status: 1, isDel: 0 });
}
