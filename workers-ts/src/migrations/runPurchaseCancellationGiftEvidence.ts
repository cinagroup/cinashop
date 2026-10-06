import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { PURCHASE_CANCELLATION_GIFT_STATE_SQL } from './purchaseCancellationGiftEvidenceCatalog';
import { PURCHASE_CANCELLATION_GIFT_INSTALLATION_SQL }
  from './purchaseCancellationGiftEvidenceInstallation';
import { PURCHASE_CANCELLATION_SETUP_SQL, PURCHASE_CANCELLATION_SOURCE_SQL }
  from './purchaseCancellationEvidenceInstallation';

type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
function root(db: Root) {
  if (!Object.hasOwn(db, '$client') || !db.$client)
    throw Error('Purchase cancellation gift forward requires a root database');
}

/** Read-only exact catalog/source inspection; no backfill, repair or grant. */
export async function inspectPurchaseCancellationGiftEvidence(db: Root) {
  root(db);
  return db.transaction(async tx => {
    await tx.execute(sql.raw(PURCHASE_CANCELLATION_SETUP_SQL));
    const [row] = await tx.execute(sql.raw(`SELECT s.state,p.ready FROM
      (${PURCHASE_CANCELLATION_GIFT_STATE_SQL}) s CROSS JOIN
      (${PURCHASE_CANCELLATION_SOURCE_SQL}) p`));
    return { state: row?.state, sourcesReady: row?.ready === true };
  }, { isolationLevel: 'read committed', accessMode: 'read only' });
}

/** Explicit 0177 only, caller uses an independent maintenance connection. */
export async function runPurchaseCancellationGiftEvidence(db: Root): Promise<void> {
  root(db);
  await db.transaction(tx => tx.execute(sql.raw(PURCHASE_CANCELLATION_GIFT_INSTALLATION_SQL)),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
