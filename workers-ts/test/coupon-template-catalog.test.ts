import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { MigrationService } from '@/services/MigrationService';
import { storeCouponIssue, storeCouponTemplate, storeCouponTemplateIssue } from '@/models/schema';
import { COUPON_TEMPLATE_CATALOG_INSPECTION_SQL, COUPON_TEMPLATE_CATALOG_SQL, inspectCouponTemplateCatalog } from '@/migrations/couponTemplateCatalog';
import { runCouponTemplateCatalog } from '@/migrations/runCouponTemplateCatalog';
import { financePostgres } from './helpers/financePostgres';

describe('independent coupon template schema and explicit installation', () => {
  let db: PGlite;
  beforeAll(async () => { db = new PGlite(); await db.exec('CREATE TABLE public.store_coupon_issue(id serial PRIMARY KEY,cid integer NOT NULL DEFAULT 0)'); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.exec('DROP TABLE IF EXISTS public.store_coupon_template_issue;DROP TABLE IF EXISTS public.store_coupon_template;DROP SEQUENCE IF EXISTS public.store_coupon_template_id_seq;TRUNCATE public.store_coupon_issue');
    await db.exec('INSERT INTO public.store_coupon_issue(id,cid) VALUES(91,1)');
  });
  const install = async (lateFailure = false) => {
    await db.exec('BEGIN');
    try { await db.exec(COUPON_TEMPLATE_CATALOG_SQL); if (lateFailure) throw Error('late caller failure'); await db.exec('COMMIT'); }
    catch (error) { await db.exec('ROLLBACK'); throw error; }
  };
  const rows = async (query: string) => (await db.query(query)).rows;
  const create = (extra = '') => db.exec(`INSERT INTO public.store_coupon_template(title,scope_type,coupon_price,valid_days,add_time${extra ? ',' + extra.split('=')[0] : ''})
    VALUES('template',0,5.25,7,0${extra ? ',' + extra.slice(extra.indexOf('=') + 1) : ''})`);
  it('uses one exact SQL across external 0169, embedded 0175 and the explicit root entry point', async () => {
    expect(readFileSync(resolve(import.meta.dirname, '../migrations/0169_coupon_template_catalog.sql'), 'utf8')).toBe(COUPON_TEMPLATE_CATALOG_SQL);
    expect(new MigrationService(createContainerFromDb({} as DbClient)).couponTemplateCatalogSqlForVerification()).toBe(COUPON_TEMPLATE_CATALOG_SQL);
    await expect(runCouponTemplateCatalog({} as Pick<DbClient, '$client'>)).rejects.toThrow('root');
    const service = readFileSync(resolve(import.meta.dirname, '../src/services/MigrationService.ts'), 'utf8');
    expect(service).toContain("if (i === 175)"); expect(service).toContain('await runCouponTemplateCatalog(this.container.db)');
  });
  it('creates only empty tables and preserves old positive cid without adopting it; repeats without OID churn', async () => {
    await install();
    expect(await rows(COUPON_TEMPLATE_CATALOG_INSPECTION_SQL)).toEqual([{ catalog_ready: true, sequence_ready: true }]);
    expect(await rows('SELECT * FROM public.store_coupon_template')).toEqual([]);
    expect(await rows('SELECT * FROM public.store_coupon_template_issue')).toEqual([]);
    const catalog = () => rows("SELECT oid,relname,relowner,relacl FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid");
    const before = await catalog(); await install(); expect(await catalog()).toEqual(before);
    expect(await rows('SELECT id,cid FROM public.store_coupon_issue')).toEqual([{ id: 91, cid: 1 }]);
  });
  it('has the same structural catalog when built directly from all three ORM models', async () => {
    const f = await financePostgres([], { namespace: 'public' });
    try {
      const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
      for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ storeCouponIssue, storeCouponTemplate, storeCouponTemplateIssue })))
        await f.exec(statement);
      expect(await inspectCouponTemplateCatalog(f.db)).toMatchObject({ ready: true });
    }
    finally { await f.close(); }
  });
  it('rolls back both new tables and serial sequence on a later caller failure', async () => {
    await expect(install(true)).rejects.toThrow('late caller');
    expect(await rows("SELECT to_regclass('public.store_coupon_template') AS t,to_regclass('public.store_coupon_template_issue') AS p,to_regclass('public.store_coupon_template_id_seq') AS s"))
      .toEqual([{ t: null, p: null, s: null }]);
    expect(await rows('SELECT id,cid FROM public.store_coupon_issue')).toEqual([{ id: 91, cid: 1 }]);
  });
  it('rejects partial objects instead of filling or repairing them', async () => {
    await db.exec('CREATE TABLE public.store_coupon_template(id integer)');
    await expect(install()).rejects.toThrow('Partial');
    expect(await rows("SELECT to_regclass('public.store_coupon_template_issue') AS proof")).toEqual([{ proof: null }]);
  });
  it.each([
    'ALTER TABLE public.store_coupon_template ALTER COLUMN title TYPE varchar(65)',
    'ALTER TABLE public.store_coupon_template ADD COLUMN unreviewed integer DEFAULT 1',
    'ALTER TABLE public.store_coupon_template DROP CONSTRAINT sct_scope_ck',
    'ALTER TABLE public.store_coupon_template ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.store_coupon_template_issue DROP CONSTRAINT scti_issue_fk',
    'ALTER TABLE public.store_coupon_template_issue DROP CONSTRAINT scti_template_fk;ALTER TABLE public.store_coupon_template_issue ADD CONSTRAINT scti_template_fk FOREIGN KEY(template_id) REFERENCES public.store_coupon_template(id) ON DELETE CASCADE',
    'ALTER SEQUENCE public.store_coupon_template_id_seq OWNED BY NONE',
    'ALTER SEQUENCE public.store_coupon_template_id_seq INCREMENT BY 2',
    'CREATE INDEX unreviewed_template_idx ON public.store_coupon_template(title)',
  ])('refuses exact catalog drift without repair: %s', async mutation => {
    await install(); await db.exec(mutation);
    const before = await rows("SELECT oid,relname,relowner,relacl FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid");
    await expect(install()).rejects.toThrow('drift');
    expect(await rows("SELECT oid,relname,relowner,relacl FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid")).toEqual(before);
  });
  it.each([
    ["coupon_price='0'", 'money'], ["coupon_price='NaN'", 'money'], ["use_min_price='-0.01'", 'money'],
    ['valid_days=0', 'days'], ['valid_days=3651', 'days'], ['sort=-1', 'state'], ['status=2', 'state'],
    ['is_del=-1', 'state'], ['add_time=-1', 'state'], ["title='   '", 'title'],
    ['scope_type=1', 'scope'], ["product_ids='1'", 'scope'],
  ])('rejects invalid persisted template state %s (%s)', async mutation => {
    await install(); await create();
    await expect(db.exec(`UPDATE public.store_coupon_template SET ${mutation}`)).rejects.toBeTruthy();
  });
  it('validates real scope IDs, integer range, product count and string capacity without claiming SQL sorting', async () => {
    await install(); await create();
    await db.exec("UPDATE public.store_coupon_template SET scope_type=1,category_id=2147483647");
    await db.exec("UPDATE public.store_coupon_template SET scope_type=2,category_id=0,product_ids='2,1'");
    // Ordering/deduplication belongs to strict service input; DB constrains shape and capacity.
    expect((await rows('SELECT product_ids FROM public.store_coupon_template'))[0]).toEqual({ product_ids: '2,1' });
    for (const value of ['0', '-1', '01', '1,,2', '2147483648', Array.from({ length: 101 }, () => '1').join(','), Array.from({ length: 100 }, () => '2147483647').join(',')])
      await expect(db.query('UPDATE public.store_coupon_template SET product_ids=$1', [value])).rejects.toBeTruthy();
    await db.query('UPDATE public.store_coupon_template SET product_ids=$1', [Array.from({ length: 100 }, (_, i) => String(i + 1)).join(',')]);
  });
  it('requires real independent template/issue identities, one provenance per issue, and no cascading deletion', async () => {
    await install(); await create();
    const revision = 'a'.repeat(64);
    await expect(db.query('INSERT INTO public.store_coupon_template_issue VALUES(92,1,0,$1)', [revision])).rejects.toBeTruthy();
    await expect(db.query('INSERT INTO public.store_coupon_template_issue VALUES(91,99,0,$1)', [revision])).rejects.toBeTruthy();
    await expect(db.query('INSERT INTO public.store_coupon_template_issue VALUES(91,1,-1,$1)', [revision])).rejects.toBeTruthy();
    await expect(db.query('INSERT INTO public.store_coupon_template_issue VALUES(91,1,0,$1)', ['A'.repeat(64)])).rejects.toBeTruthy();
    await db.query('INSERT INTO public.store_coupon_template_issue VALUES(91,1,0,$1)', [revision]);
    await expect(db.query('INSERT INTO public.store_coupon_template_issue VALUES(91,1,0,$1)', [revision])).rejects.toBeTruthy();
    await expect(db.exec('DELETE FROM public.store_coupon_template')).rejects.toBeTruthy();
    await expect(db.exec('DELETE FROM public.store_coupon_issue')).rejects.toBeTruthy();
  });
});
