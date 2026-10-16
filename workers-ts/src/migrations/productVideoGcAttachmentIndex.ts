import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

/** Independent bounded owner-maintenance build. No data or sequence writes. */
export const PRODUCT_VIDEO_GC_ATTACHMENT_INDEX_SQL = String.raw`SELECT pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true),
  pg_catalog.set_config('default_tablespace','',true);
DO $product_video_gc_attachment_index$
DECLARE
  table_oid oid;
  index_oid oid;
  row_count integer;
BEGIN
  IF current_user<>session_user OR current_schema()<>'public'
    OR current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')::boolean
    OR current_setting('session_replication_role')<>'origin'
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    OR NOT pg_catalog.pg_try_advisory_xact_lock(731627,12) THEN
    RAISE EXCEPTION 'Product video GC attachment index requires explicit PG16 owner maintenance';
  END IF;
  SELECT c.oid INTO table_oid FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE c.oid=to_regclass('public.system_attachment') AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
      AND a.attname='name' AND a.attnum>0 AND a.atttypid='pg_catalog.varchar'::regtype AND a.atttypmod=104
      AND a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated=''
      AND a.attcollation=(SELECT oid FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace);
  IF table_oid IS NULL THEN RAISE EXCEPTION 'Product video GC attachment table or name column drift'; END IF;
  LOCK TABLE ONLY public.system_attachment IN SHARE MODE NOWAIT;
  IF to_regclass('public.system_attachment') IS DISTINCT FROM table_oid THEN
    RAISE EXCEPTION 'Product video GC attachment table identity drift';
  END IF;
  index_oid := to_regclass('public.system_attachment_video_gc_name_idx');
  IF index_oid IS NULL THEN
    SELECT count(*) INTO row_count FROM (SELECT 1 FROM ONLY public.system_attachment LIMIT 100001) bounded;
    IF row_count>100000 THEN RAISE EXCEPTION 'Product video GC attachment maintenance row budget exceeded'; END IF;
    CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment USING btree (name);
    index_oid := to_regclass('public.system_attachment_video_gc_name_idx');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
    JOIN pg_catalog.pg_index x ON x.indrelid=t.oid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
    WHERE t.oid=table_oid AND a.attname='name' AND i.oid=to_regclass('public.system_attachment_video_gc_name_idx') AND i.relkind='i' AND i.relpersistence='p'
      AND NOT i.relispartition AND i.relowner=t.relowner AND i.reloptions IS NULL AND i.relacl IS NULL AND i.reltablespace=0
      AND i.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
      AND x.indrelid=t.oid AND x.indisvalid AND x.indisready AND x.indislive AND x.indimmediate
      AND NOT x.indisunique AND NOT x.indisprimary AND NOT x.indisexclusion AND NOT x.indnullsnotdistinct
      AND NOT x.indisreplident AND NOT x.indisclustered AND x.indpred IS NULL AND x.indexprs IS NULL
      AND x.indnatts=1 AND x.indnkeyatts=1 AND x.indkey[0]=a.attnum AND x.indoption[0]=0
      AND x.indcollation[0]=a.attcollation
      AND x.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='text_ops' AND opcmethod=i.relam)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conindid=i.oid)
      AND pg_catalog.pg_get_indexdef(i.oid,1,true)='name') THEN
    RAISE EXCEPTION 'Product video GC attachment name index drift';
  END IF;
END
$product_video_gc_attachment_index$;
`;

/** Read-only runtime proof. This never builds, adopts or repairs an index. */
export async function assertProductVideoGcAttachmentIndexReady(tx: Pick<DbClient,'execute'>): Promise<void> {
  try {
    // Pin the actual table against DDL for the caller's transaction and prove
    // the current runtime can perform the equality lookup it is about to use.
    await tx.execute(sql`SELECT name FROM public.system_attachment LIMIT 0`);
    const [state]=await tx.execute(sql`SELECT current_setting('server_version_num')::integer/10000=16
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
        WHERE c.oid=to_regclass('public.system_attachment') AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
      AND a.attname='name' AND a.attnum>0 AND a.atttypid='pg_catalog.varchar'::regtype AND a.atttypmod=104
      AND a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated=''
      AND a.attcollation=(SELECT oid FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace))
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_class t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
        JOIN pg_catalog.pg_index x ON x.indrelid=t.oid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
        WHERE t.oid=to_regclass('public.system_attachment') AND a.attname='name' AND i.oid=to_regclass('public.system_attachment_video_gc_name_idx') AND i.relkind='i' AND i.relpersistence='p'
      AND NOT i.relispartition AND i.relowner=t.relowner AND i.reloptions IS NULL AND i.relacl IS NULL AND i.reltablespace=0
      AND i.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
      AND x.indrelid=t.oid AND x.indisvalid AND x.indisready AND x.indislive AND x.indimmediate
      AND NOT x.indisunique AND NOT x.indisprimary AND NOT x.indisexclusion AND NOT x.indnullsnotdistinct
      AND NOT x.indisreplident AND NOT x.indisclustered AND x.indpred IS NULL AND x.indexprs IS NULL
      AND x.indnatts=1 AND x.indnkeyatts=1 AND x.indkey[0]=a.attnum AND x.indoption[0]=0
      AND x.indcollation[0]=a.attcollation
      AND x.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='text_ops' AND opcmethod=i.relam)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conindid=i.oid)
      AND pg_catalog.pg_get_indexdef(i.oid,1,true)='name') AS ready`);
    if(state?.ready!==true)throw Error('Product video GC attachment index absent or drifted');
  } catch(cause) { throw Object.assign(new ServiceUnavailableException('商品视频清理素材索引尚未就绪'),{cause}); }
}

export async function installProductVideoGcAttachmentIndex(tx: Pick<DbClient,'execute'>): Promise<{applied:boolean}> {
  if(Object.hasOwn(tx,'$client'))throw Error('Explicit video GC index maintenance transaction required');
  // Arm before the DO begins; a stricter caller deadline is never relaxed.
  await tx.execute(sql.raw("SELECT pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),\n  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),\n  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true),\n  pg_catalog.set_config('default_tablespace','',true);"));
  const [before]=await tx.execute(sql`SELECT to_regclass('public.system_attachment_video_gc_name_idx') IS NOT NULL AS present`);
  await tx.execute(sql.raw(PRODUCT_VIDEO_GC_ATTACHMENT_INDEX_SQL));
  await assertProductVideoGcAttachmentIndexReady(tx);
  return {applied:before?.present!==true};
}
