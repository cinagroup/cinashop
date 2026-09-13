import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

export const SHIPPING_LIFECYCLE_ENVIRONMENT_SQL = String.raw`SELECT
  pg_catalog.current_setting('session_replication_role') IN ('origin','local') AS "originTriggersActive",
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS "noEnabledEventTriggers",
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname='public' AND c.relname IN
      ('shipping_templates','store_product','store_seckill','store_bargain',
       'store_combination','store_integral','store_discounts_products')
      AND t.tgenabled<>'D'
      -- Reserved names/functions remain the exact protocol inspector's job.
      -- Do not waive internal RI triggers: CASCADE can remove/rebind retained
      -- references before the shipping AFTER trigger observes them.
      AND NOT pg_catalog.starts_with(t.tgname,'shipping_lifecycle_')
      AND NOT (pn.nspname='public' AND pg_catalog.starts_with(p.proname,'shipping_lifecycle_'))
  ) AS "noUnreviewedRelationTriggers",
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r
    JOIN pg_catalog.pg_class c ON c.oid=r.ev_class
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN
      ('shipping_templates','store_product','store_seckill','store_bargain',
       'store_combination','store_integral','store_discounts_products')
      AND r.ev_enabled<>'D'
  ) AS "noUnreviewedRelationRules"`;

/** Catalog-only gate before installation DDL. Unknown enabled event/relation
 * triggers can change history/references despite a complete protocol catalog.
 * The supported external/embedded/ORM paths have no other seven-table triggers;
 * additional triggers (including internal RI actions) and enabled rewrite rules
 * require explicit review. Rules rewrite queries before row triggers can run.
 * Do not invoke, disable, drop or change them, or change replication mode.
 * This snapshot cannot fence an independent superuser changing database-wide
 * event triggers afterwards: maintenance identities still require coordination.
 */
export async function assertShippingLifecycleInstallationEnvironment(tx: Pick<DbClient, 'select'>) {
  const [environment] = await tx.select({
    originTriggersActive: sql<boolean>`"originTriggersActive"`,
    noEnabledEventTriggers: sql<boolean>`"noEnabledEventTriggers"`,
    noUnreviewedRelationTriggers: sql<boolean>`"noUnreviewedRelationTriggers"`,
    noUnreviewedRelationRules: sql<boolean>`"noUnreviewedRelationRules"`,
  }).from(sql.raw(`(${SHIPPING_LIFECYCLE_ENVIRONMENT_SQL}) installation_environment`));
  if (environment?.originTriggersActive !== true || environment.noEnabledEventTriggers !== true
    || environment.noUnreviewedRelationTriggers !== true || environment.noUnreviewedRelationRules !== true) {
    throw new Error('Shipping installation environment requires review');
  }
}
