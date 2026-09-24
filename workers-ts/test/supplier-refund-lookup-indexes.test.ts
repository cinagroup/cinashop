import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SUPPLIER_REFUND_LOOKUP_INDEX_SQL } from '@/migrations/supplierRefundLookupIndexes';
import { runSupplierRefundLookupIndexes } from '@/migrations/runSupplierRefundLookupIndexes';
import { supplierFlowingWater, supplierTransactions } from '@/models/schema';
import { presaleSupplierFlowQuery, presaleSupplierTransactionQuery } from '@/services/activity/PresaleSupplierRefundProof';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { createContainerFromDb } from '@/lib/di';
import { MigrationService } from '@/services/MigrationService';
import { catalogKinds, readCatalog } from '../scripts/data-migration/postgres-catalog-audit';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const targets = ['supplier_flowing_water', 'supplier_transactions'] as const;
const indexes = ['sfw_link_id_idx', 'stx_link_id_idx'] as const;
it('keeps registered external supplier lookup SQL byte-identical to embedded 0168', () => {
  expect(readFileSync('migrations/0162_supplier_refund_lookup_indexes.sql', 'utf8').trim()).toBe(SUPPLIER_REFUND_LOOKUP_INDEX_SQL.trim());
});

describe.skipIf(!native)('supplier refund lookup indexes on owned PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => {
    f = await financePostgres([supplierFlowingWater, supplierTransactions]);
    // DDL always targets public; peers retain their fixture identity/schema.
    for (const table of targets) await f.exec(`ALTER TABLE ${table} SET SCHEMA public;
      INSERT INTO public.${table}(order_id,link_id,pay_price) VALUES ('local-1','local-order-a',1.23),('local-2','local-order-b',4.56)`);
    // financePostgres builds columns/primary keys only; these upgrade fixtures
    // intentionally start without ordinary indexes. The nine-path audit uses
    // the actual ORM generator to prove fresh-index registration independently.
  });
  afterEach(async () => { await f?.close(); });
  const apply = () => runSupplierRefundLookupIndexes(f.db);
  const state = async () => ({
    rows: await Promise.all(targets.map(table => f.db.execute(sql.raw(`SELECT * FROM public.${table} ORDER BY id`)).then(rows => Array.from(rows)))),
    relations: Array.from(await f.db.execute(sql`SELECT c.oid,c.relname,c.relkind,c.relowner,c.relacl,c.reloptions,
      c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,i.indisvalid,i.indisready,i.indislive,
      CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END AS definition
      FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid=c.oid
      WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname`)),
    columns: Array.from(await f.db.execute(sql`SELECT c.relname,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,
      a.attidentity,a.attgenerated,a.attcollation,a.attacl,pg_get_expr(d.adbin,d.adrelid) AS initial
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`)),
  });
  it('installs both exact indexes without row/owner/ACL changes, then preserves their OIDs on repeat', async () => {
    const before = await state(); await apply(); const after = await state();
    expect(after.rows).toEqual(before.rows);
    expect(after.columns).toEqual(before.columns);
    expect(after.relations.filter(row => !indexes.some(name => name === row.relname))).toEqual(before.relations);
    for (let i = 0; i < indexes.length; i++) expect(after.relations.find(row => row.relname === indexes[i])).toMatchObject({
      relkind: 'i', indisvalid: true, indisready: true, indislive: true,
      definition: `CREATE INDEX ${indexes[i]} ON public.${targets[i]} USING btree (link_id, id)`,
    });
    await apply(); expect(await state()).toEqual(after);
  });
  it('upgrades the complete previous external catalog via the standalone runner, never replaying bootstrap', async () => {
    const whole = await checkoutPricingMigrationDatabase();
    try {
      // Freeze the previous supplier-index upgrade boundary as later migrations register.
      const files = readdirSync('migrations').filter(name => /^\d+.*\.sql$/.test(name) && name <= '0162_supplier_refund_lookup_indexes.sql').sort();
      expect(files.at(-1)).toBe('0162_supplier_refund_lookup_indexes.sql');
      expect(files.at(-2)).toBe('0161_presale_delivery_outbox.sql');
      for (const file of files.slice(0,-1)) await whole.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
        await tx.execute(sql.raw(readFileSync(`migrations/${file}`,'utf8')));
      });
      for (const table of targets) await whole.exec(`INSERT INTO public.${table}(order_id,link_id,pay_price)
        VALUES('local-prior-1','local-prior-order',1.23),('local-prior-2','local-prior-order',4.56)`);
      const catalog = () => readCatalog(async query => (await whole.query(query)).rows.map(row => {
        if (typeof row.key !== 'string' || typeof row.name !== 'string') throw Error('Invalid catalog row identity');
        return { ...row, key: row.key, name: row.name };
      }));
      const identities = () => whole.exec(`SELECT 'relation' AS kind,oid::text,relfilenode::text AS file,relowner::text AS owner,relacl::text AS acl
        FROM pg_class WHERE relnamespace='public'::regnamespace
        UNION ALL SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
        UNION ALL SELECT 'constraint',oid::text,NULL,NULL,NULL FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY kind,oid`);
      const rows = () => Promise.all(targets.map(table => whole.exec(`SELECT * FROM public.${table} ORDER BY id`)));
      const before = await catalog(), originalIds = await identities(), originalRows = await rows();
      expect(before.tables).toHaveLength(277); expect(before.indexes).toHaveLength(1069);
      expect(before.indexes.filter(row => indexes.some(name => name === row.name))).toEqual([]);
      const service = new MigrationService(createContainerFromDb(whole.db));
      expect(service.supplierRefundLookupIndexesMigrationSqlForVerification()).toBe(SUPPLIER_REFUND_LOOKUP_INDEX_SQL);
      expect(await service.runAll()).toEqual({ executed: [], errors: ['Presale outbox already registered; use standalone forward upgrades, not runAll'] });
      expect(await catalog()).toEqual(before); expect(await identities()).toEqual(originalIds); expect(await rows()).toEqual(originalRows);
      await runSupplierRefundLookupIndexes(whole.db);
      const after = await catalog(), installedIds = await identities();
      expect(after.indexes).toHaveLength(1071);
      expect(after.indexes.filter(row => !indexes.some(name => name === row.name))).toEqual(before.indexes);
      for (const kind of catalogKinds.filter(kind => kind !== 'indexes')) expect(after[kind]).toEqual(before[kind]);
      expect(installedIds.filter(row => originalIds.some(old => old.kind === row.kind && old.oid === row.oid))).toEqual(originalIds);
      expect(installedIds).toHaveLength(originalIds.length + 2); expect(await rows()).toEqual(originalRows);
      await runSupplierRefundLookupIndexes(whole.db); await runSupplierRefundLookupIndexes(whole.db);
      expect(await catalog()).toEqual(after); expect(await identities()).toEqual(installedIds); expect(await rows()).toEqual(originalRows);
      expect(await service.runAll()).toEqual({ executed: [], errors: ['Presale outbox already registered; use standalone forward upgrades, not runAll'] });
      expect(await identities()).toEqual(installedIds); expect(await rows()).toEqual(originalRows);
    } finally { await whole.close(); }
  }, 120000);
  const drifts = [
    ['reversed keys', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions(id,link_id)'],
    ['unique', 'CREATE UNIQUE INDEX stx_link_id_idx ON public.supplier_transactions(link_id,id)'],
    ['partial', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions(link_id,id) WHERE is_del=0'],
    ['include', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions(link_id,id) INCLUDE(uid)'],
    ['descending', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions(link_id DESC,id)'],
    ['hash', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions USING hash(link_id)'],
    ['expression', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions(lower(link_id),id)'],
    ['reloptions', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions(link_id,id) WITH(fillfactor=80)'],
    ['collision', 'CREATE TABLE public.stx_link_id_idx(id integer)'],
    ['invalid', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions(link_id,id); UPDATE pg_index SET indisvalid=false WHERE indexrelid=\'public.stx_link_id_idx\'::regclass'],
    ['not ready', 'CREATE INDEX stx_link_id_idx ON public.supplier_transactions(link_id,id); UPDATE pg_index SET indisready=false,indisvalid=false WHERE indexrelid=\'public.stx_link_id_idx\'::regclass'],
    ['nullable column', 'ALTER TABLE public.supplier_transactions ALTER COLUMN link_id DROP NOT NULL'],
    ['wrong width', 'ALTER TABLE public.supplier_transactions ALTER COLUMN link_id TYPE varchar(51)'],
    ['RLS', 'ALTER TABLE public.supplier_transactions ENABLE ROW LEVEL SECURITY'],
    ['unlogged', 'ALTER TABLE public.supplier_transactions SET UNLOGGED'],
  ] as const;
  it.each(drifts)('refuses %s on the second table with neither target changed', async (_name, fault) => {
    await f.exec(fault); const before = await state();
    await expect(apply()).rejects.toThrow(/Supplier refund lookup (index|column|table\/owner) drift/);
    expect(await state()).toEqual(before);
    expect(before.relations.some(row => row.relname === indexes[0])).toBe(false);
  });
  it('rolls back both indexes on a later failure in the caller-owned transaction', async () => {
    const before = await state();
    await expect(f.db.$client.begin(async tx => {
      await tx.unsafe(SUPPLIER_REFUND_LOOKUP_INDEX_SQL); await tx.unsafe('SELECT 1/0');
    })).rejects.toThrow('division by zero');
    expect(await state()).toEqual(before);
  });
  it('preserves stricter caller timeouts and restores session settings after commit', async () => {
    const settings = () => f.db.execute(sql`SELECT current_setting('statement_timeout') AS statement,
      current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
    const before = Array.from(await settings());
    await f.db.$client.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='100ms'; SET LOCAL idle_in_transaction_session_timeout='2s'");
      await tx.unsafe(SUPPLIER_REFUND_LOOKUP_INDEX_SQL);
      const [row] = await tx.unsafe("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle");
      expect(row).toEqual({ statement: '2s', lock: '100ms', idle: '2s' });
    });
    expect(Array.from(await settings())).toEqual(before);
  });
  it('refuses missing-index installation above its bounded row budget without partial DDL', async () => {
    await f.exec("INSERT INTO public.supplier_transactions(link_id) SELECT 'local-budget-'||n FROM generate_series(1,99999) n");
    await expect(apply()).rejects.toThrow('row budget exceeded');
    expect(Array.from(await f.db.execute(sql`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace
      AND relname IN ('sfw_link_id_idx','stx_link_id_idx')`))).toEqual([]);
    const [row] = await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.supplier_transactions`);
    expect(row.count).toBe(100001);
  });
  it.each(targets)('fails fast under an independent %s writer, then installs after rollback', async table => {
    const before = await state();
    await withFinancePeers(f.db, async ([writer, installer]) => {
      await writer.exec('BEGIN');
      try {
        await writer.exec(`INSERT INTO public.${table}(link_id) VALUES('local-uncommitted')`);
        const start = performance.now();
        await expect(runSupplierRefundLookupIndexes(installer.db)).rejects.toThrow(/could not obtain lock/);
        expect(performance.now() - start).toBeLessThan(2000);
      } finally { await writer.exec('ROLLBACK'); }
      expect(await state()).toEqual(before); await runSupplierRefundLookupIndexes(installer.db);
    });
    expect((await state()).relations.filter(row => indexes.some(name => name === row.relname))).toHaveLength(2);
  });

  it('rejects empty/oversized/duplicate lookup keys and retains overflow sentinels', async () => {
    for (const keys of [[], [''], ['x'.repeat(51)], ['duplicate', 'duplicate'], Array.from({ length: 204 }, (_, i) => `key-${i}`)]) {
      expect(() => presaleSupplierFlowQuery(f.db, keys)).toThrow('凭据不一致');
      expect(() => presaleSupplierTransactionQuery(f.db, keys)).toThrow('凭据不一致');
    }
    await apply();
    for (const table of targets) await f.exec(`INSERT INTO public.${table}(link_id) SELECT 'local-overflow' FROM generate_series(1,1200)`);
    await f.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL search_path TO public,pg_catalog`);
      expect(await presaleSupplierFlowQuery(tx, ['local-overflow'])).toHaveLength(1008);
      expect(await presaleSupplierTransactionQuery(tx, ['local-overflow'])).toHaveLength(405);
    });
  });

  it('uses exact unfiltered lookup indexes with 200,000 unrelated rows per table and 2/203 keys', async () => {
    await apply();
    for (const table of targets) {
      await f.exec(`TRUNCATE public.${table} RESTART IDENTITY;
        INSERT INTO public.${table}(order_id,link_id,uid,pay_price,is_del)
        SELECT 'local-noise-'||n,'local-noise-order-'||n,n,1.23,(n%2)::smallint FROM generate_series(1,200000) n;
        INSERT INTO public.${table}(order_id,link_id,uid,pay_price,is_del)
        SELECT 'local-match-'||n,CASE WHEN n%2=0 THEN 'local-order-a' ELSE 'local-order-b' END,n,4.56,(n%2)::smallint FROM generate_series(1,16) n`);
    }
    await f.exec('UPDATE public.supplier_flowing_water SET status=-1 WHERE id>200000 AND id%3=0');
    for (const table of targets) await f.exec(`ANALYZE public.${table}`);
    // An exact preinstalled index remains a no-op even above installation budget.
    const identity = () => f.db.execute(sql`SELECT oid,relname FROM pg_class WHERE relnamespace='public'::regnamespace
      AND relname IN ('sfw_link_id_idx','stx_link_id_idx') ORDER BY relname`);
    const before = Array.from(await identity()); await apply(); expect(Array.from(await identity())).toEqual(before);
    for (const keyCount of [2, 203]) await f.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL search_path TO public,pg_catalog`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      const keys = ['local-order-a', 'local-order-b', ...Array.from({ length: keyCount - 2 }, (_, i) => `local-absent-${i}`)];
      const queries = [presaleSupplierFlowQuery(tx, keys), presaleSupplierTransactionQuery(tx, keys)];
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const [explanation] = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.getSQL()}`);
        const report = planReport(explanation['QUERY PLAN']);
        expect(report.indexNames).toContain(indexes[i]);
        expect(report.nodeTypes).not.toContain('Seq Scan');
        expect(report.rows).toBe(16); expect(report.blocks).toBeLessThan(1000); expect(report.elapsedMs).toBeLessThan(2000);
        const rows = await query;
        expect(rows.map(row => row.id)).toEqual(Array.from({ length: 16 }, (_, n) => 200001 + n));
        expect(rows.some(row => row.isDel === 1)).toBe(true);
        if (i === 0) expect(rows.some(row => 'status' in row && row.status === -1)).toBe(true);
        console.info(JSON.stringify({ test: 'supplier-refund-lookup-capacity', table: targets[i], unrelatedRows: 200000, keyCount, ...report }));
      }
    });
  }, 60000);
});

/** Fail on malformed EXPLAIN rather than casting an unverified driver payload. */
function planReport(value: unknown) {
  const record = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid EXPLAIN object');
    return input as Record<string, unknown>;
  };
  const number = (input: unknown): number => {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) throw Error('Invalid EXPLAIN number');
    return input;
  };
  if (!Array.isArray(value) || value.length !== 1) throw Error('Invalid EXPLAIN root');
  const explanation = record(value[0]), plan = record(explanation.Plan);
  const indexNames: string[] = [], nodeTypes: string[] = [];
  function walk(node: Record<string, unknown>) {
    if (typeof node['Node Type'] !== 'string') throw Error('Invalid EXPLAIN node type');
    nodeTypes.push(node['Node Type']);
    if (typeof node['Index Name'] === 'string') indexNames.push(node['Index Name']);
    if (node.Plans !== undefined) {
      if (!Array.isArray(node.Plans)) throw Error('Invalid EXPLAIN children');
      node.Plans.forEach(child => walk(record(child)));
    }
  }
  walk(plan);
  return { indexNames, nodeTypes, rows: number(plan['Actual Rows']),
    blocks: number(plan['Shared Hit Blocks']) + number(plan['Shared Read Blocks']), elapsedMs: number(explanation['Execution Time']) };
}
