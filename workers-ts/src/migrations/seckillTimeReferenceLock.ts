import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { SECKILL_TIME_REFERENCE_LOCK_FUNCTION, SECKILL_TIME_REFERENCE_LOCK_MAINTENANCE_KEY,
  SECKILL_TIME_REFERENCE_OWNER_SETTING, seckillTimeReferenceLockCatalogQuery,
  seckillTimeReferenceLockCatalogReady } from './seckillTimeReferenceLockCatalog';
import { seckillTimeReferenceLockInstallationSql } from './seckillTimeReferenceLockInstallation';

type Query = Pick<DbClient, 'execute'>;
type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;

/** Read-only exact catalog, separate from service/HTTP permission acceptance. */
export async function inspectSeckillTimeReferenceLock(tx: Query, schema = 'public') {
  const [row] = await tx.execute(seckillTimeReferenceLockCatalogQuery(schema));
  if (!row) throw Error('Seckill time reference lock catalog unavailable');
  return { tablesSafe: row.tablesSafe === true, absent: row.absent === true,
    definitionSafe: row.definitionSafe === true, ownerSafe: row.ownerSafe === true, aclSafe: row.aclSafe === true,
    ownerOid: typeof row.ownerOid === 'string' ? row.ownerOid : null,
    functionOid: typeof row.functionOid === 'string' ? row.functionOid : null };
}

/** Maintenance only. Never chooses/creates owners, repairs drift or grants a LOGIN. */
export async function installSeckillTimeReferenceLock(db: Root, ownerRole: string | undefined, schema = 'public') {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Seckill time reference lock maintenance requires a root database');
  pricingIdentifier(schema); if (ownerRole !== undefined) pricingIdentifier(ownerRole);
  return db.transaction(async tx => {
    if (ownerRole !== undefined) await tx.execute(sql`SELECT pg_catalog.set_config(${SECKILL_TIME_REFERENCE_OWNER_SETTING},${ownerRole},true)`);
    try { await tx.execute(sql.raw(seckillTimeReferenceLockInstallationSql(schema))); }
    catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        if ('code' in cause && cause.code === 'P0001' && 'message' in cause && typeof cause.message === 'string'
          && cause.message.startsWith('Seckill time reference lock')) throw Error(cause.message, { cause: error });
        if (!('cause' in cause) || cause.cause === cause) break;
        cause = cause.cause;
      }
      throw error;
    }
    const state = await inspectSeckillTimeReferenceLock(tx, schema);
    if (!seckillTimeReferenceLockCatalogReady(state)) throw Error('Seckill time reference lock final verification failed');
    return state;
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}

/** Existing DELETE transaction only. This capability locks fixed parent then child;
 * it never reads/mutates business data or accepts objects, roles or SQL inputs. */
export async function acquireSeckillTimeReferenceLock(tx: Query, schema = 'public') {
  if (Object.hasOwn(tx, '$client')) throw Error('Seckill time reference lock requires an existing transaction');
  pricingIdentifier(schema);
  const [gate] = await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${SECKILL_TIME_REFERENCE_LOCK_MAINTENANCE_KEY},n.oid::integer) AS locked
    FROM pg_catalog.pg_namespace n WHERE n.nspname=${schema}`);
  if (gate?.locked !== true) throw Error('Seckill time reference lock maintenance is busy or schema is missing');
  const state = await inspectSeckillTimeReferenceLock(tx, schema);
  if (!seckillTimeReferenceLockCatalogReady(state)) throw Error('Seckill time reference lock catalog is missing or requires review');
  await tx.execute(sql.raw(`SELECT ${pricingIdentifier(schema)}.${SECKILL_TIME_REFERENCE_LOCK_FUNCTION}()`));
}
