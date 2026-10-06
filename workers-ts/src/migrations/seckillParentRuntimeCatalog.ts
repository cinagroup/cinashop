import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

/** The one reviewed Admin INSERT sequence, bound to this exact parent id.
 * Readonly catalog guard; never accepts arbitrary relation/sequence names. */
export async function inspectSeckillParentRuntimeSequence(tx:Pick<DbClient,'execute'>,maintenance:string) {
  pricingIdentifier(maintenance);
  const [r]=await tx.execute(sql`SELECT count(*)=1 AND bool_and(s.relkind='S' AND s.relpersistence='p'
    AND s.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenance})
    AND (SELECT count(*)=1 AND bool_and(d.refobjid='public.store_activity'::regclass
      AND d.refobjsubid=(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid='public.store_activity'::regclass AND attname='id'))
      FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid
        AND d.refclassid=d.classid AND d.deptype IN ('a','i'))
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE a.attrelid='public.store_activity'::regclass AND a.attname='id'
      AND pg_catalog.pg_get_expr(d.adbin,d.adrelid,true)='nextval(''store_activity_id_seq''::regclass)')) AS ready
    FROM pg_catalog.pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relname='store_activity_id_seq'`);
  return {ready:r?.ready===true};
}
