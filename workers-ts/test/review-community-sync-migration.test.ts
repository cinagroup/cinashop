import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { MigrationService } from '@/services/MigrationService';
import { REVIEW_COMMUNITY_SYNC_SQL } from '@/migrations/reviewCommunitySync';
import { runReviewCommunitySync } from '@/migrations/runReviewCommunitySync';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const external = readFileSync(resolve(import.meta.dirname, '../migrations/0185_review_community_sync.sql'), 'utf8');
const oldSchema = readFileSync(resolve(import.meta.dirname, '../migrations/0006a_embedded_schema_parity.sql'), 'utf8');
const oldReplyDefinition = oldSchema.match(/CREATE TABLE IF NOT EXISTS "store_product_reply" \([\s\S]*?\n\);/u)?.[0];
if (!oldReplyDefinition) throw Error('Independent historical reply DDL missing');
const expectedColumns = [
  { name: 'community_sync_digest', type: 'character varying(64)', not_null: true, default_sql: "''::character varying" },
  { name: 'community_sync_post_id', type: 'integer', not_null: true, default_sql: '0' },
  { name: 'community_sync_requested', type: 'smallint', not_null: true, default_sql: '0' },
];
const columnsSql = `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
  pg_get_expr(d.adbin,d.adrelid) AS default_sql FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.store_product_reply'::regclass AND NOT a.attisdropped
  AND a.attname IN ('community_sync_requested','community_sync_digest','community_sync_post_id') ORDER BY a.attname`;

describe.runIf(native)('review community synchronization complete fresh PG16 registry', () => {
  it('executes all 186 embedded migrations and installs exact unrequested defaults on fresh reviews', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      expect(f.format).toBe('pg16');
      expect(new MigrationService(createContainerFromDb(f.db)).reviewCommunitySyncSqlForVerification()).toBe(external);
      expect(REVIEW_COMMUNITY_SYNC_SQL).toBe(external);
      expect(await new MigrationService(createContainerFromDb(f.db)).runAll()).toEqual({
        executed: Array.from({ length: 186 }, (_, i) => String(i).padStart(4, '0')), errors: [],
      });
      expect(await f.exec(columnsSql)).toEqual(expectedColumns);
      await f.exec(`INSERT INTO public.store_product_reply(id,uid,product_id,oid,"unique",comment,pics)
        VALUES(19,11,70,31,'fresh_review','Fresh review remains private opt-out','[]')`);
      expect(await f.exec(`SELECT community_sync_requested,community_sync_digest,community_sync_post_id
        FROM public.store_product_reply WHERE id=19`)).toEqual([
        { community_sync_requested: 0, community_sync_digest: '', community_sync_post_id: 0 },
      ]);
      expect(await f.exec('TABLE public.community')).toEqual([]);
      await runReviewCommunitySync(f.db);
      expect(await f.exec(columnsSql)).toEqual(expectedColumns);
    } finally { await f.close(); }
  }, 120_000);
});

describe.runIf(native)('review community synchronization standalone PG16 upgrade', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    expect(f.format).toBe('pg16');
    await f.exec(oldReplyDefinition!);
    await f.exec(`INSERT INTO public.store_product_reply(id,uid,product_id,oid,"unique",comment,pics,product_score,status,is_del)
      VALUES(7,11,70,21,'old_review','Existing historical review with image','["https://example.invalid/review.png"]',4,0,0)`);
  }, 30_000);
  afterEach(async () => { await f?.close(); }, 45_000);
  const rows = () => f.exec('SELECT * FROM public.store_product_reply ORDER BY id');
  const catalog = () => f.exec(`SELECT c.oid::text,c.relname,c.relkind,c.relowner::text,c.relacl::text,c.relfilenode::text,
    c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace='public'::regnamespace ORDER BY c.oid`);
  const allColumns = () => f.exec(`SELECT a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,a.attacl::text,
    a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_sql FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.store_product_reply'::regclass AND a.attnum>0 ORDER BY a.attnum`);
  const snapshot = async () => ({ rows: await rows(), catalog: await catalog(), columns: await allColumns() });
  const externalInstall = () => f.db.$client.begin('isolation level read committed', tx => tx.unsafe(external));

  it.each(['embedded runner', 'external SQL'] as const)('upgrades existing rows through %s without enrolling them or changing identities and grants', async path => {
    expect(REVIEW_COMMUNITY_SYNC_SQL).toBe(external);
    const beforeRows = await rows();
    await f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT ON public.store_product_reply TO "${peer.role}"`);
      const beforeCatalog = await catalog(), beforeColumns = await allColumns();
      const rights = () => peer.exec(`SELECT current_user=session_user AS genuine_login,
        has_table_privilege(current_user,'public.store_product_reply','SELECT') AS read,
        has_table_privilege(current_user,'public.store_product_reply','INSERT,UPDATE,DELETE,TRUNCATE') AS write`);
      expect(await rights()).toEqual([{ genuine_login: true, read: true, write: false }]);
      if (path === 'embedded runner') await runReviewCommunitySync(f.db); else await externalInstall();
      expect(await f.exec(columnsSql)).toEqual(expectedColumns);
      expect(await catalog()).toEqual(beforeCatalog);
      expect((await allColumns()).slice(0, beforeColumns.length)).toEqual(beforeColumns);
      expect(await rows()).toEqual(beforeRows.map(row => ({ ...row,
        community_sync_requested: 0, community_sync_digest: '', community_sync_post_id: 0,
      })));
      expect(await rights()).toEqual([{ genuine_login: true, read: true, write: false }]);
      const installed = await snapshot();
      await runReviewCommunitySync(f.db); await externalInstall();
      expect(await snapshot()).toEqual(installed);
      await expect(runReviewCommunitySync(peer.db)).rejects.toThrow('identity/owner drift');
      expect(await snapshot()).toEqual(installed);
      expect(await rights()).toEqual([{ genuine_login: true, read: true, write: false }]);
    });
  });

  it.each([
    ['partial', 'ALTER TABLE public.store_product_reply ADD COLUMN community_sync_requested smallint DEFAULT 0 NOT NULL', 'Partial review'],
    ['type', 'ALTER TABLE public.store_product_reply ALTER COLUMN community_sync_requested TYPE integer', 'column/default drift'],
    ['digest width', 'ALTER TABLE public.store_product_reply ALTER COLUMN community_sync_digest TYPE varchar(63)', 'column/default drift'],
    ['default', 'ALTER TABLE public.store_product_reply ALTER COLUMN community_sync_post_id SET DEFAULT 1', 'column/default drift'],
    ['nullability', 'ALTER TABLE public.store_product_reply ALTER COLUMN community_sync_digest DROP NOT NULL', 'column/default drift'],
  ])('refuses %s drift without repairing columns, changing rows, or modifying ACLs', async (kind, drift, error) => {
    if (kind !== 'partial') await runReviewCommunitySync(f.db);
    await f.exec(drift);
    const before = await snapshot();
    await expect(runReviewCommunitySync(f.db)).rejects.toThrow(error);
    expect(await snapshot()).toEqual(before);
    await expect(externalInstall()).rejects.toThrow(error);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back all three additions when the maintenance transaction aborts', async () => {
    const before = await snapshot();
    await expect(f.db.$client.begin('isolation level read committed', async tx => {
      await tx.unsafe(external); throw Error('abort review upgrade');
    })).rejects.toThrow('abort review upgrade');
    expect(await snapshot()).toEqual(before);
  });

  it.each(['isolation level repeatable read', 'isolation level read committed read only'])('rejects unsafe maintenance transaction %s without writes', async mode => {
    const before = await snapshot();
    await expect(f.db.$client.begin(mode, tx => tx.unsafe(external))).rejects.toThrow('reviewed PG16 maintenance');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an existing maintenance advisory transaction immediately and leaves no additions', async () => {
    const before = await snapshot();
    await f.withPeer!(async peer => {
      await peer.exec('BEGIN; SELECT pg_advisory_xact_lock(741915,0)');
      try {
        await expect(runReviewCommunitySync(f.db)).rejects.toThrow('maintenance busy');
        expect(await snapshot()).toEqual(before);
      } finally { await peer.exec('ROLLBACK'); }
    });
    await runReviewCommunitySync(f.db);
    expect(await f.exec(columnsSql)).toEqual(expectedColumns);
  });

  it('uses NOWAIT for a real conflicting table lock, leaves rows and ACLs unchanged, and succeeds after release', async () => {
    const before = await snapshot();
    await f.withPeer!(async peer => {
      await peer.exec('BEGIN; LOCK TABLE public.store_product_reply IN ACCESS SHARE MODE');
      try {
        await expect(runReviewCommunitySync(f.db)).rejects.toMatchObject({ code: '55P03' });
        expect(await snapshot()).toEqual(before);
      } finally { await peer.exec('ROLLBACK'); }
    });
    await runReviewCommunitySync(f.db);
    expect(await f.exec(columnsSql)).toEqual(expectedColumns);
  });
});
