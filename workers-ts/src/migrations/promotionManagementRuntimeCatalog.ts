import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
/** Fixed promotion parent/auxiliary serial sequences; no arbitrary names. */
export async function inspectPromotionManagementRuntimeSequences(tx:Pick<DbClient,'execute'>,maintenance:string) {
  const [row]=await tx.execute(sql`WITH expected(table_name,sequence_name) AS (VALUES
    ('store_promotions','store_promotions_id_seq'),('store_promotions_auxiliary','store_promotions_auxiliary_id_seq'))
    SELECT count(*)=2 AND bool_and(s.relkind='S' AND s.relpersistence='p'
      AND s.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenance})
      AND q.seqtypid='integer'::regtype AND q.seqstart=1 AND q.seqincrement=1 AND q.seqmin=1
      AND q.seqmax=2147483647 AND q.seqcache=1 AND NOT q.seqcycle
      AND (SELECT count(*)=1 AND bool_and(d.refobjid=to_regclass('public.'||e.table_name)
        AND d.refobjsubid=(SELECT attnum FROM pg_catalog.pg_attribute
          WHERE attrelid=d.refobjid AND attname='id' AND attnum>0 AND NOT attisdropped))
        FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid
          AND d.refclassid=d.classid AND d.deptype IN('a','i'))
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef ad JOIN pg_catalog.pg_attribute a ON a.attrelid=ad.adrelid AND a.attnum=ad.adnum
        WHERE a.attrelid=to_regclass('public.'||e.table_name) AND a.attname='id' AND a.attnotnull
          AND a.atttypid='integer'::regtype AND a.attgenerated='' AND a.attidentity=''
          AND pg_catalog.pg_get_expr(ad.adbin,ad.adrelid)='nextval('''||e.sequence_name||'''::regclass)')) AS ready
    FROM expected e JOIN pg_catalog.pg_class s ON s.relnamespace='public'::regnamespace AND s.relname=e.sequence_name
      JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid`);
  return {ready:row?.ready===true};
}
