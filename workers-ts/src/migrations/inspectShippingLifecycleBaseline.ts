import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { SHIPPING_LIFECYCLE_BOUND_SQL, SHIPPING_LIFECYCLE_SHAPE_SQL, SHIPPING_LIFECYCLE_BASELINE_SQL } from './shippingLifecycleInspectionSql';

/** Internal query layer. Caller owns the transaction, isolation and locks.
 * Deliberately makes no read-only, installation or future-protection claim. */
export async function boundShippingLifecycleInspection(tx: Pick<DbClient, 'execute'>) {
  await tx.execute(sql.raw(SHIPPING_LIFECYCLE_BOUND_SQL));
}

export async function inspectShippingLifecycleCatalog(tx: Pick<DbClient, 'select'>) {
    const catalog = await tx.select({ table: sql<string>`table_name`, compatible: sql<boolean>`compatible` }).from(sql.raw(`(${SHIPPING_LIFECYCLE_SHAPE_SQL}) shape`)).orderBy(sql`table_name`);
    return catalog;
}

export async function inspectShippingLifecycleBaseline(tx: Pick<DbClient, 'select'>) {
    const catalog = await inspectShippingLifecycleCatalog(tx);
    const base = { scope: 'shipping-lifecycle-stored-reference-baseline' as const,
      protocolCatalogVerified: false as const, installationAuthorized: false as const,
      futureWritesProtected: false as const, catalog };
    if (catalog.length !== 7 || catalog.some(row => !row.compatible)) {
      return { ...base, baselineReady: false, dataChecked: false, tables: [] };
    }
    // Explicit schema qualification prevents a temporary table/search-path
    // shadow from supplying apparently healthy rows. Include every retained row.
    const tables = await tx.select({ table: sql<string>`table_name`, rows: sql<number>`rows`,
      references: sql<number>`reference_count`, implicitDefault: sql<number>`implicit_default`,
      invalidReferences: sql<number>`invalid_references`, negativeTemplateId: sql<number>`negative_template_id`,
      missingSource: sql<number>`missing_source`, invalidSourceOwner: sql<number>`invalid_source_owner`,
      missingTemplate: sql<number>`missing_template`, unavailableTemplate: sql<number>`unavailable_template`,
      ownerMismatch: sql<number>`owner_mismatch` }).from(sql.raw(`(${SHIPPING_LIFECYCLE_BASELINE_SQL}) baseline`)).orderBy(sql`table_name`);
    return { ...base, baselineReady: tables.length === 6 && tables.every(row => row.invalidReferences === 0), dataChecked: true, tables };
}
