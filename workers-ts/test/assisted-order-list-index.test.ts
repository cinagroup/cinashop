import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ASSISTED_ORDER_LIST_INDEX_SQL } from '@/migrations/assistedOrderListIndex';
import { runAssistedOrderListIndex } from '@/migrations/runAssistedOrderListIndex';
import { storeOrder } from '@/models/schema';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { createContainerFromDb } from '@/lib/di';
import { MigrationService } from '@/services/MigrationService';
import { catalogKinds, readCatalog } from '../scripts/data-migration/postgres-catalog-audit';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const indexName = 'so_assisted_actor_list';
const definition = 'CREATE INDEX so_assisted_actor_list ON public.store_order USING btree '
  + '(staff_id, is_channel, is_system_del, is_del, add_time DESC, id DESC)';

it('keeps external 0165 SQL byte-identical to embedded 0171', () => {
  expect(readFileSync('migrations/0165_assisted_order_list_index.sql', 'utf8').trim())
    .toBe(ASSISTED_ORDER_LIST_INDEX_SQL.trim());
});

describe.skipIf(!native)('assisted actor list index on owned PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => {
    f = await financePostgres([storeOrder], { namespace: 'public' });
    await f.exec(`INSERT INTO public.store_order(order_id,staff_id,is_channel,is_system_del,is_del,add_time)
      VALUES ('local-assisted-1',7,2,0,0,100),('local-assisted-2',7,2,0,0,101),('local-ordinary',7,0,0,0,102)`);
  });
  afterEach(async () => { await f?.close(); });
  const apply = () => runAssistedOrderListIndex(f.db);
  const state = async () => ({
    rows: Array.from(await f.db.execute(sql`SELECT id,order_id,staff_id,is_channel,is_system_del,is_del,add_time
      FROM public.store_order ORDER BY id`)),
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

  it('installs only the exact index, preserves rows/owner/ACL, and repeats without replacing its OID', async () => {
    const before = await state(); await apply(); const after = await state();
    expect(after.rows).toEqual(before.rows); expect(after.columns).toEqual(before.columns);
    expect(after.relations.filter(row => row.relname !== indexName)).toEqual(before.relations);
    expect(after.relations.find(row => row.relname === indexName)).toMatchObject({
      relkind: 'i', indisvalid: true, indisready: true, indislive: true, definition,
    });
    await apply(); expect(await state()).toEqual(after);
  });

  it('upgrades complete previous external catalog without replaying bootstrap or changing business rows', async () => {
    const whole = await checkoutPricingMigrationDatabase();
    try {
      const files = readdirSync('migrations').filter(name => /^\d+.*\.sql$/.test(name)
        && name <= '0165_assisted_order_list_index.sql').sort();
      expect(files.at(-1)).toBe('0165_assisted_order_list_index.sql');
      expect(files.at(-2)).toBe('0164_purchase_cancellation_evidence.sql');
      for (const file of files.slice(0, -1)) await whole.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
        await tx.execute(sql.raw(readFileSync(`migrations/${file}`, 'utf8')));
      });
      await whole.exec(`INSERT INTO public.store_order(order_id,staff_id,is_channel,is_system_del,is_del,add_time)
        VALUES ('local-upgrade-assisted',7,2,0,0,101)`);
      const catalog = () => readCatalog(async query => (await whole.query(query)).rows.map(row => {
        if (typeof row.key !== 'string' || typeof row.name !== 'string') throw Error('Invalid catalog row identity');
        return { ...row, key: row.key, name: row.name };
      }));
      const rows = () => whole.exec(`SELECT id,order_id,staff_id,is_channel,is_system_del,is_del,add_time
        FROM public.store_order ORDER BY id`);
      const before = await catalog(), originalRows = await rows();
      expect(before.indexes.some(row => row.name === indexName)).toBe(false);
      const service = new MigrationService(createContainerFromDb(whole.db));
      expect(service.assistedOrderListIndexMigrationSqlForVerification()).toBe(ASSISTED_ORDER_LIST_INDEX_SQL);
      expect(await service.runAll()).toEqual({ executed: [], errors: ['Presale outbox already registered; use standalone forward upgrades, not runAll'] });
      await runAssistedOrderListIndex(whole.db);
      const after = await catalog();
      expect(after.indexes).toHaveLength(before.indexes.length + 1);
      expect(after.indexes.filter(row => row.name !== indexName)).toEqual(before.indexes);
      for (const kind of catalogKinds.filter(kind => kind !== 'indexes')) expect(after[kind]).toEqual(before[kind]);
      expect(await rows()).toEqual(originalRows);
      await runAssistedOrderListIndex(whole.db);
      expect(await catalog()).toEqual(after); expect(await rows()).toEqual(originalRows);
    } finally { await whole.close(); }
  }, 120_000);

  it.each([
    ['reversed keys', 'CREATE INDEX so_assisted_actor_list ON public.store_order(is_channel,staff_id,is_system_del,is_del,add_time DESC,id DESC)'],
    ['unique', 'CREATE UNIQUE INDEX so_assisted_actor_list ON public.store_order(staff_id,is_channel,is_system_del,is_del,add_time DESC,id DESC)'],
    ['partial', 'CREATE INDEX so_assisted_actor_list ON public.store_order(staff_id,is_channel,is_system_del,is_del,add_time DESC,id DESC) WHERE is_channel=2'],
    ['include', 'CREATE INDEX so_assisted_actor_list ON public.store_order(staff_id,is_channel,is_system_del,is_del,add_time DESC,id DESC) INCLUDE(uid)'],
    ['wrong direction', 'CREATE INDEX so_assisted_actor_list ON public.store_order(staff_id,is_channel,is_system_del,is_del,add_time,id)'],
    ['wrong method', 'CREATE INDEX so_assisted_actor_list ON public.store_order USING hash(staff_id)'],
    ['expression', 'CREATE INDEX so_assisted_actor_list ON public.store_order(staff_id,is_channel,is_system_del,is_del,(add_time+1),id DESC)'],
    ['reloptions', 'CREATE INDEX so_assisted_actor_list ON public.store_order(staff_id,is_channel,is_system_del,is_del,add_time DESC,id DESC) WITH(fillfactor=80)'],
    ['collision', 'CREATE TABLE public.so_assisted_actor_list(id integer)'],
    ['nullable key', 'ALTER TABLE public.store_order ALTER COLUMN staff_id DROP NOT NULL'],
    ['RLS', 'ALTER TABLE public.store_order ENABLE ROW LEVEL SECURITY'],
    ['unlogged', 'ALTER TABLE public.store_order SET UNLOGGED'],
  ] as const)('rejects %s without replacing an existing object', async (_name, fault) => {
    await f.exec(fault); const before = await state();
    await expect(apply()).rejects.toThrow(/Assisted order list (index|column|table\/owner) drift/);
    expect(await state()).toEqual(before);
  });

  it('rolls back index creation after a later failure and preserves stricter caller timeouts', async () => {
    const before = await state();
    await expect(f.db.$client.begin(async tx => {
      await tx.unsafe(ASSISTED_ORDER_LIST_INDEX_SQL); await tx.unsafe('SELECT 1/0');
    })).rejects.toThrow('division by zero');
    expect(await state()).toEqual(before);
    const settings = () => f.db.execute(sql`SELECT current_setting('statement_timeout') AS statement,
      current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
    const initial = Array.from(await settings());
    await f.db.$client.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='100ms'; SET LOCAL idle_in_transaction_session_timeout='2s'");
      await tx.unsafe(ASSISTED_ORDER_LIST_INDEX_SQL);
      const [limits] = await tx.unsafe(`SELECT current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(limits).toEqual({ statement: '2s', lock: '100ms', idle: '2s' });
    });
    expect(Array.from(await settings())).toEqual(initial);
  });

  it('refuses missing-index installation above the maintenance row budget without DDL', async () => {
    await f.exec(`INSERT INTO public.store_order(order_id)
      SELECT 'local-budget-'||n FROM generate_series(1,100001) n`);
    await expect(apply()).rejects.toThrow('row budget exceeded');
    expect(Array.from(await f.db.execute(sql`SELECT relname FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname=${indexName}`))).toEqual([]);
  }, 60_000);

  it('fails fast under an independent writer and succeeds after that writer rolls back', async () => {
    const before = await state();
    await withFinancePeers(f.db, async ([writer, installer]) => {
      await writer.exec('BEGIN');
      try {
        await writer.exec(`INSERT INTO public.store_order(order_id) VALUES('local-uncommitted')`);
        const start = performance.now();
        await expect(runAssistedOrderListIndex(installer.db)).rejects.toThrow(/could not obtain lock/);
        expect(performance.now() - start).toBeLessThan(2000);
      } finally { await writer.exec('ROLLBACK'); }
      expect(await state()).toEqual(before); await runAssistedOrderListIndex(installer.db);
    });
    expect((await state()).relations.find(row => row.relname === indexName)).toMatchObject({ definition });
  });

  it('uses the six-key index for generic and custom sorted pagination amid 200,000 unrelated rows', async () => {
    await apply();
    await f.exec(`INSERT INTO public.store_order(order_id,staff_id,is_channel,is_system_del,is_del,add_time)
      SELECT 'local-noise-'||n,100+n%10,0,0,0,n FROM generate_series(1,200000) n;
      INSERT INTO public.store_order(order_id,staff_id,is_channel,is_system_del,is_del,add_time)
      SELECT 'local-match-'||n,7,2,0,0,n FROM generate_series(1,100) n;
      ANALYZE public.store_order`);
    await f.db.$client.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='5s'");
      await tx.unsafe(`PREPARE assisted_list_plan(integer,smallint,smallint,smallint) AS
        SELECT id FROM public.store_order WHERE staff_id=$1 AND is_channel=$2 AND is_system_del=$3
          AND is_del=$4 AND pid IN(0,-1) ORDER BY add_time DESC,id DESC LIMIT 25`);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await tx.unsafe(`SET LOCAL plan_cache_mode='${mode}'`);
        const [explanation] = await tx.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
          EXECUTE assisted_list_plan(7,2,0,0)`);
        const plan = JSON.stringify(explanation['QUERY PLAN']);
        expect(plan).toContain(`"Index Name":"${indexName}"`);
        expect(plan).toContain('"Shared Hit Blocks"');
        expect(plan).toContain('"Actual Rows":25');
        expect(plan).not.toContain('"Node Type":"Seq Scan"');
        expect(plan).not.toContain('"Node Type":"Sort"');
        const rows = await tx.unsafe('EXECUTE assisted_list_plan(7,2,0,0)');
        expect(rows).toHaveLength(25);
      }
      await tx.unsafe('DEALLOCATE assisted_list_plan');
    });
  }, 120_000);

  it('measures first and deep keyset pages plus filtered reads with a large owned history', async () => {
    // Stay below the migration's 100,000-row ordinary-index budget. Unlike the
    // unrelated-row case above, these rows all share the leading actor keys.
    await f.exec(`INSERT INTO public.store_order
      (order_id,staff_id,is_channel,is_system_del,is_del,pid,add_time,real_name,paid,status,refund_status,shipping_type)
      SELECT 'local-owned-'||n,7,2,0,0,0,n,
        CASE WHEN n%600=0 THEN 'cursor-needle' ELSE '' END,
        CASE WHEN n%500=0 THEN 1 ELSE 0 END,0,0,1
      FROM generate_series(1,30000) n;
      INSERT INTO public.store_order(order_id,staff_id,is_channel,is_system_del,is_del,pid,add_time)
      SELECT 'local-other-'||n,100+n%5,2,0,0,0,30000+n
      FROM generate_series(1,10000) n`);
    await apply();
    await f.exec('ANALYZE public.store_order');
    const [anchor] = await f.db.$client.unsafe<{ id: number }[]>(
      "SELECT id FROM public.store_order WHERE order_id='local-owned-20000'",
    );
    expect(anchor?.id).toBeGreaterThan(0);

    type PlanNode = {
      'Node Type': string;
      'Index Name'?: string;
      'Index Cond'?: string;
      'Actual Rows'?: number;
      'Shared Hit Blocks'?: number;
      'Shared Read Blocks'?: number;
      'Rows Removed by Filter'?: number;
      Plans?: PlanNode[];
    };
    type PlanDoc = { Plan: PlanNode; 'Execution Time': number };
    const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];
    const prepared = [
      `PREPARE assisted_owned_first(integer,smallint,smallint,smallint) AS
        SELECT add_time,id FROM public.store_order
        WHERE staff_id=$1 AND is_channel=$2 AND is_system_del=$3 AND is_del=$4
          AND pid IN(0,-1) ORDER BY add_time DESC,id DESC LIMIT 25`,
      `PREPARE assisted_owned_deep(integer,smallint,smallint,smallint,integer,integer) AS
        SELECT add_time,id FROM public.store_order
        WHERE staff_id=$1 AND is_channel=$2 AND is_system_del=$3 AND is_del=$4
          AND pid IN(0,-1) AND (add_time,id)<($5,$6)
        ORDER BY add_time DESC,id DESC LIMIT 25`,
      `PREPARE assisted_owned_keyword(integer,smallint,smallint,smallint,text) AS
        SELECT add_time,id FROM public.store_order
        WHERE staff_id=$1 AND is_channel=$2 AND is_system_del=$3 AND is_del=$4
          AND pid IN(0,-1) AND (order_id ILIKE $5 OR real_name ILIKE $5 OR user_phone ILIKE $5)
        ORDER BY add_time DESC,id DESC LIMIT 25`,
      `PREPARE assisted_owned_status(integer,smallint,smallint,smallint) AS
        SELECT add_time,id FROM public.store_order
        WHERE staff_id=$1 AND is_channel=$2 AND is_system_del=$3 AND is_del=$4
          AND pid IN(0,-1) AND paid=1 AND status IN(0,4)
          AND refund_status IN(0,3) AND shipping_type IN(1,3)
        ORDER BY add_time DESC,id DESC LIMIT 25`,
    ];
    const cases = [
      { name: 'first', args: '(7,2,0,0)', top: 30000, step: 1, requiresIndex: true },
      { name: 'deep', args: `(7,2,0,0,20000,${anchor.id})`, top: 19999, step: 1, requiresIndex: true },
      { name: 'keyword', args: "(7,2,0,0,'%needle%')", top: 30000, step: 600, requiresIndex: false },
      { name: 'status', args: '(7,2,0,0)', top: 30000, step: 500, requiresIndex: false },
    ] as const;
    await f.db.$client.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='5s'");
      for (const statement of prepared) await tx.unsafe(statement);
      for (const mode of ['force_generic_plan', 'force_custom_plan']) {
        await tx.unsafe(`SET LOCAL plan_cache_mode='${mode}'`);
        for (const entry of cases) {
          const execution = `EXECUTE assisted_owned_${entry.name}${entry.args}`;
          const [explanation] = await tx.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${execution}`);
          const plan = (explanation['QUERY PLAN'] as PlanDoc[])[0];
          const nodes = nodesOf(plan.Plan);
          const rows = await tx.unsafe<{ add_time: number; id: number }[]>(execution);
          expect(rows.map(row => row.add_time)).toEqual(
            Array.from({ length: 25 }, (_, index) => entry.top - index * entry.step),
          );
          expect(plan.Plan['Actual Rows']).toBe(25);
          if (entry.requiresIndex) {
            expect(nodes.some(node => node['Index Name'] === indexName)).toBe(true);
            expect(nodes.some(node => ['Seq Scan', 'Sort'].includes(node['Node Type']))).toBe(false);
          }
          if (entry.name === 'deep') {
            const indexScan = nodes.find(node => node['Index Name'] === indexName);
            expect(indexScan?.['Index Cond']).toMatch(/ROW\(add_time, id\)\s*<\s*ROW\(/);
            expect(nodes.reduce((sum, node) => sum + (node['Rows Removed by Filter'] ?? 0), 0))
              .toBeLessThan(25);
          }
          // Keyword ILIKE and status predicates are not index keys. Record the
          // planner's actual choice and work; do not claim this index serves them.
          process.stdout.write(`ASSISTED_OWNED_LIST_PLAN ${JSON.stringify({ mode, query: entry.name,
            indexNames: [...new Set(nodes.map(node => node['Index Name']).filter(Boolean))],
            indexConds: nodes.map(node => node['Index Cond']).filter(Boolean),
            nodeTypes: nodes.map(node => node['Node Type']),
            filterNodes: nodes.filter(node => (node['Rows Removed by Filter'] ?? 0) > 0)
              .map(node => ({ nodeType: node['Node Type'], removed: node['Rows Removed by Filter'] })),
            sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
            sharedReadBlocks: plan.Plan['Shared Read Blocks'],
            executionMs: plan['Execution Time'] })}\n`);
        }
      }
      for (const entry of cases) await tx.unsafe(`DEALLOCATE assisted_owned_${entry.name}`);
    });
  }, 120_000);
});
