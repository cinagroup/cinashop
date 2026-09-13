import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

export const SHIPPING_LIFECYCLE_ENVIRONMENT_SQL = String.raw`SELECT
  pg_catalog.current_setting('session_replication_role') IN ('origin','local') AS "originTriggersActive",
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS "noEnabledEventTriggers"`;

/** Catalog-only gate before installation DDL. Unknown enabled event triggers
 * can run unrelated writes while leaving the expected protocol catalog intact.
 * Do not invoke, disable, drop or change them, or change replication mode.
 * This snapshot cannot fence an independent superuser changing database-wide
 * event triggers afterwards: maintenance identities still require coordination.
 */
export async function assertShippingLifecycleInstallationEnvironment(tx: Pick<DbClient, 'select'>) {
  const [environment] = await tx.select({
    originTriggersActive: sql<boolean>`"originTriggersActive"`,
    noEnabledEventTriggers: sql<boolean>`"noEnabledEventTriggers"`,
  }).from(sql.raw(`(${SHIPPING_LIFECYCLE_ENVIRONMENT_SQL}) installation_environment`));
  if (environment?.originTriggersActive !== true || environment.noEnabledEventTriggers !== true) {
    throw new Error('Shipping installation environment requires review');
  }
}
