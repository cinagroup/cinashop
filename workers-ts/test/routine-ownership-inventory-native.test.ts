/** Actual isolated PG16 catalog/rows/LOGINs and independent peers. The proxy
 * below only pauses real unsafe SQL at a deterministic boundary: no result,
 * snapshot, row, lock or inventory digest is fabricated. No provider is used. */
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectRoutineOwnershipInventory, type RoutineInventoryTarget,
  type RoutineOwnershipInventory } from '../scripts/routine-ownership-inventory';
import { createContainerFromDb } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { assertRegisteredDatabaseCohort, registeredTableNames } from './helpers/registeredCatalogCohort';

const KEY = '6b'.repeat(32), SECRET = 'owned_inventory_secret_never_in_report_or_error';
const FAILURE = 'Routine ownership database inventory incomplete';
type Sql = postgres.Sql;
type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Context = { f: Fixture; client: Sql; target: RoutineInventoryTarget };
type Boundary = { when: 'before' | 'after'; mode: string; text: string };

async function fixture(work: (c: Context) => Promise<void>) {
  const f = await sequenceRunnerDatabase();
  try {
    if (f.format !== 'pg16' || !f.withPeer || !f.withRuntimeRole) throw Error('Actual owned PG16 with independent LOGINs required');
    const client = f.db.$client as unknown as Sql;
    const [identity] = await client.unsafe<{ database: string; maintenance: string }[]>(
      'SELECT current_database() AS database,current_user AS maintenance');
    await work({ f, client, target: identity });
  } finally { await f.close(); }
}

/** postgres.js still owns both BEGIN/COMMIT and the real pinned connection.
 * Only the async callback boundary changes; every SQL executes unchanged. */
function synchronized(client: Sql, hook: (boundary: Boundary) => void | Promise<void>): Sql {
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key !== 'begin') return Reflect.get(target, key, receiver);
      return (mode: string, action: (tx: postgres.TransactionSql) => Promise<unknown>) => client.begin(mode, tx => action(new Proxy(tx, {
        get(bound, property, innerReceiver) {
          if (property !== 'unsafe') return Reflect.get(bound, property, innerReceiver);
          return ((text: string, ...arguments_: unknown[]) => (async () => {
            await hook({ when: 'before', mode, text });
            const result = await Reflect.apply(bound.unsafe, bound, [text, ...arguments_]);
            await hook({ when: 'after', mode, text });
            return result;
          })()) as typeof bound.unsafe;
        },
      })));
    },
  });
}

const collect = (c: Context, client = c.client) => collectRoutineOwnershipInventory(client, c.target, KEY);
const relation = (report: RoutineOwnershipInventory, schema: string, name: string) => {
  const matches = report.relations.filter(row => row.schema === schema && row.name === name);
  expect(matches).toHaveLength(1); return matches[0]!;
};
const privateOnly = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  expect(text).not.toContain(SECRET); expect(text).not.toContain(KEY);
};
async function refused(work: Promise<unknown>) {
  const result = await work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  expect(result.ok).toBe(false);
  if (result.ok) throw Error('Incomplete inventory incorrectly returned a report');
  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).message).toBe(FAILURE);
  expect(Object.hasOwn(result.error as object, 'cause')).toBe(false);
  expect(Object.hasOwn(result.error as object, 'query')).toBe(false);
  expect(Object.hasOwn(result.error as object, 'parameters')).toBe(false);
  privateOnly(String(result.error)); privateOnly((result.error as Error).stack);
}

async function seedRows(c: Context) {
  await c.client.unsafe(`CREATE SEQUENCE public.inventory_sequence START 41;
    CREATE TABLE public.inventory_source(id bigint PRIMARY KEY,amount numeric(30,10),payload text,is_del integer,delete_time bigint);
    CREATE SCHEMA inventory_archive;
    CREATE TABLE inventory_archive.history(id integer,payload text,is_del integer);`);
  await c.client.unsafe(`INSERT INTO public.inventory_source
    SELECT 9007199254740993::bigint+n,12345678901234567890.1234567890::numeric,
      $1||':'||n::text,n%2,CASE WHEN n%2=1 THEN 1700000000 ELSE 0 END
    FROM generate_series(1,33) n`, [SECRET]);
  await c.client.unsafe('INSERT INTO inventory_archive.history VALUES(1,$1,1),(2,$1,0)', [SECRET]);
  // Superuser's read must bypass this policy, rather than run an incomplete
  // application-role view of stored rows.
  await c.client.unsafe(`ALTER TABLE public.inventory_source ENABLE ROW LEVEL SECURITY;
    CREATE POLICY inventory_deny_all ON public.inventory_source USING(false)`);
}

async function business(c: Context) {
  return {
    rows: Array.from(await c.client.unsafe('SELECT to_jsonb(t)::text AS row,t.xmin::text AS version,t.ctid::text AS position FROM ONLY public.inventory_source t ORDER BY t.ctid')),
    history: Array.from(await c.client.unsafe('SELECT to_jsonb(t)::text AS row,t.xmin::text AS version,t.ctid::text AS position FROM ONLY inventory_archive.history t ORDER BY t.ctid')),
    sequence: Array.from(await c.client.unsafe('SELECT last_value::text,is_called FROM public.inventory_sequence')),
  };
}

/** Verify the public stream format against exact server TEXT. Parsing the
 * large integers/decimals into JS Number would produce a different digest. */
async function exactSourceDigest(c: Context, schema: string, name: string) {
  const [identity] = await c.client.unsafe<{ oid: string; type_oid: string; schema: string; name: string; kind: string; am: string }[]>(
    `SELECT c.oid::text AS oid,c.reltype::text AS type_oid,n.nspname AS schema,c.relname AS name,c.relkind AS kind,a.amname AS am
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_am a ON a.oid=c.relam WHERE n.nspname=$1 AND c.relname=$2`, [schema, name]);
  const digest = createHmac('sha256', KEY).update('cinashop.routine-ownership-inventory.v1\0relation\0');
  const frame = (value: string) => { digest.update(String(Buffer.byteLength(value, 'utf8')) + ':'); digest.update(value, 'utf8'); };
  frame(JSON.stringify(identity));
  // Identifiers here are fixed fixture names, not interpolated input.
  const rows = await c.client.unsafe<{ version: string; position: string; value: string }[]>(
    `SELECT t.xmin::text AS version,t.ctid::text AS position,to_jsonb(t)::text AS value
      FROM ONLY "${schema}"."${name}" t ORDER BY t.ctid`);
  for (const row of rows) frame(row.version + ':' + row.position + ':' + row.value);
  return digest.digest('hex');
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('maintenance Routine database inventory on actual PG16', () => {
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Inventory must not contact a provider')); });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  it('completes the actual full embedded migration graph with its seed rows and JSONB outbox payload intact', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      expect(await new MigrationService(createContainerFromDb(f.db)).runAll()).toEqual({
        executed: Array.from({ length: 185 }, (_, i) => String(i).padStart(4, '0')), errors: [],
      });
      await assertRegisteredDatabaseCohort(f.db, 'embedded');
      const names = registeredTableNames('embedded'), client = f.db.$client as unknown as Sql;
      expect(names).toHaveLength(283);
      await client.unsafe(`INSERT INTO public.store_order_outbox(event_key,event_type,aggregate_id,payload)
        VALUES('order.paid:inventory','order.paid',1,$1::jsonb)`,
      ['{"private":"' + SECRET + '","integer":9007199254740995,"nested":[true,null,{"decimal":1234567890.1234567890}]}']);
      const [target] = await client.unsafe<{ database: string; maintenance: string }[]>(
        'SELECT current_database() AS database,current_user AS maintenance');
      // Independent counts cover the real registered graph, including seed
      // rows. No table is silently skipped because its business data is empty.
      const countSql = names.map(name => `SELECT '${name}' AS name,count(*)::text AS count
        FROM ONLY public."${name.replaceAll('"', '""')}"`).join(' UNION ALL ');
      const counts = await client.unsafe<{ name: string; count: string }[]>(countSql);
      const before = await client.unsafe('SELECT to_jsonb(t)::text AS value,t.xmin::text AS version,t.ctid::text AS position FROM public.store_order_outbox t');
      const report = await collectRoutineOwnershipInventory(client, target, KEY);
      expect(report.relations.map(row => row.name).sort()).toEqual(names);
      expect(report.relations.every(row => row.schema === 'public')).toBe(true);
      expect(report.rowCount).toBe(counts.reduce((total, row) => total + BigInt(row.count), 0n).toString());
      for (const row of counts) expect(relation(report, 'public', row.name).rowCount).toBe(row.count);
      expect(report).toMatchObject({ activationAllowed: false, ownership: 'not_evaluated', externalSourcesIncluded: false });
      expect(await client.unsafe(countSql)).toEqual(counts);
      expect(await client.unsafe('SELECT to_jsonb(t)::text AS value,t.xmin::text AS version,t.ctid::text AS position FROM public.store_order_outbox t')).toEqual(before);
      privateOnly(report);
    } finally { await f.close(); }
  }, 30000);

  it('includes every page tail, soft-deleted row and non-public source without exposing row values or reserving sequences', async () => fixture(async c => {
    await seedRows(c); const before = await business(c);
    const report = await collect(c), repeated = await collect(c);
    expect(report).toMatchObject({ version: 1, purpose: 'routine_ownership_database_inventory',
      scope: 'non_system_heap_tables_and_partition_roots', ownership: 'not_evaluated',
      activationAllowed: false, externalSourcesIncluded: false, rowCount: '35' });
    expect(report.relations).toHaveLength(2);
    expect(relation(report, 'public', 'inventory_source')).toMatchObject({ kind: 'r', rowCount: '33' });
    expect(relation(report, 'inventory_archive', 'history')).toMatchObject({ rowCount: '2' });
    expect(relation(report, 'public', 'inventory_source').digest).toBe(await exactSourceDigest(c, 'public', 'inventory_source'));
    expect(repeated.sourceDigest).toBe(report.sourceDigest); expect(repeated.metadataDigest).toBe(report.metadataDigest);
    expect(await business(c)).toEqual(before); privateOnly(report); privateOnly(repeated);
    await c.client.unsafe('UPDATE public.inventory_source SET payload=$1 WHERE id=9007199254741026', ['changed-final-page-tail']);
    const tail = await collect(c);
    expect(tail.rowCount).toBe('35'); expect(relation(tail, 'public', 'inventory_source').digest)
      .not.toBe(relation(report, 'public', 'inventory_source').digest);
    await c.client.unsafe('UPDATE inventory_archive.history SET payload=$1 WHERE is_del=1', ['changed-soft-deleted-row']);
    const deleted = await collect(c);
    expect(relation(deleted, 'inventory_archive', 'history').digest).not.toBe(relation(tail, 'inventory_archive', 'history').digest);
  }), 30000);

  it('scans ONLY each inheritance heap and partition leaf once while retaining the storage-free parent', async () => fixture(async c => {
    await c.client.unsafe(`CREATE TABLE public.inventory_parent(id integer,payload text);
      CREATE TABLE public.inventory_child(extra integer) INHERITS(public.inventory_parent);
      INSERT INTO public.inventory_parent VALUES(1,'parent'); INSERT INTO public.inventory_child VALUES(2,'child',8),(3,'child',9);
      CREATE TABLE public.inventory_partition(id integer,payload text) PARTITION BY RANGE(id);
      CREATE TABLE public.inventory_leaf_a PARTITION OF public.inventory_partition FOR VALUES FROM(0) TO(10);
      CREATE TABLE public.inventory_leaf_b PARTITION OF public.inventory_partition FOR VALUES FROM(10) TO(20);
      INSERT INTO public.inventory_partition VALUES(4,'leaf-a'),(14,'leaf-b');`);
    const report = await collect(c);
    expect(report.rowCount).toBe('5'); expect(report.relations).toHaveLength(5);
    for (const [name, count] of [['inventory_parent','1'], ['inventory_child','2'], ['inventory_partition','0'],
      ['inventory_leaf_a','1'], ['inventory_leaf_b','1']]) expect(relation(report, 'public', name).rowCount).toBe(count);
    expect(relation(report, 'public', 'inventory_partition').kind).toBe('p');
  }), 30000);

  it('fingerprints same-value xmin changes, schema metadata and a newly added empty table independently', async () => fixture(async c => {
    await seedRows(c); const first = await collect(c), values = await business(c);
    await c.client.unsafe('UPDATE public.inventory_source SET payload=payload WHERE id=9007199254741026');
    const updated = await collect(c), after = await business(c);
    expect(after.rows.map(row => row.row)).toEqual(values.rows.map(row => row.row));
    expect(updated.metadataDigest).toBe(first.metadataDigest); expect(updated.sourceDigest).not.toBe(first.sourceDigest);
    expect(relation(updated, 'public', 'inventory_source').digest).not.toBe(relation(first, 'public', 'inventory_source').digest);
    await c.client.unsafe('ALTER TABLE public.inventory_source ALTER COLUMN is_del SET DEFAULT 0');
    const metadata = await collect(c);
    expect(metadata.metadataDigest).not.toBe(updated.metadataDigest);
    expect(relation(metadata, 'public', 'inventory_source').digest).toBe(relation(updated, 'public', 'inventory_source').digest);
    await c.client.unsafe('CREATE TABLE inventory_archive.new_empty(id integer)');
    const added = await collect(c);
    expect(added.metadataDigest).not.toBe(metadata.metadataDigest); expect(added.sourceDigest).not.toBe(metadata.sourceDigest);
    expect(added.rowCount).toBe('35'); expect(relation(added, 'inventory_archive', 'new_empty').rowCount).toBe('0');
  }), 30000);

  it('rejects a new relation between RC discovery and the locked RR scope rather than returning a prefix', async () => fixture(async c => {
    await c.client.unsafe('CREATE TABLE public.inventory_source(id integer); INSERT INTO public.inventory_source VALUES(1)');
    await c.f.withPeer!(async peer => {
      let changed = false;
      const observed = synchronized(c.client, async b => {
        if (!changed && b.when === 'after' && b.mode.includes('read committed') && b.text.startsWith('SELECT c.oid::text AS oid')) {
          changed = true; await peer.exec('CREATE TABLE public.inventory_late(id integer)');
        }
      });
      await refused(collect(c, observed)); expect(changed).toBe(true);
      expect((await collect(c)).relations).toHaveLength(2);
    });
  }), 30000);

  it('keeps all rows in one RR snapshot while an independent peer commits insert/update/delete during the scan', async () => fixture(async c => {
    await seedRows(c); const baseline = await collect(c);
    await c.f.withPeer!(async peer => {
      let changed = false;
      const observed = synchronized(c.client, async b => {
        if (!changed && b.when === 'after' && b.mode.includes('repeatable read') && b.text.startsWith('DECLARE ')
          && b.text.includes('LEFT JOIN ONLY "public"."inventory_source"')) {
          changed = true;
          await peer.exec(`UPDATE public.inventory_source SET payload='after-snapshot' WHERE id=9007199254741026;
            DELETE FROM public.inventory_source WHERE id=9007199254740994;
            INSERT INTO public.inventory_source VALUES(42,1.25,'after-snapshot',0,0)`);
        }
      });
      const captured = await collect(c, observed); expect(changed).toBe(true);
      expect(captured.rowCount).toBe('35'); expect(captured.sourceDigest).toBe(baseline.sourceDigest);
      expect(relation(captured, 'public', 'inventory_source').digest).toBe(relation(baseline, 'public', 'inventory_source').digest);
      expect((await collect(c)).sourceDigest).not.toBe(baseline.sourceDigest);
    });
  }), 30000);

  it('takes NOWAIT table locks before the RR snapshot and prevents a concurrent TRUNCATE until the inventory ends', async () => fixture(async c => {
    await c.client.unsafe('CREATE TABLE public.inventory_source(id integer); INSERT INTO public.inventory_source VALUES(1),(2)');
    await c.f.withPeer!(async peer => {
      await peer.exec('BEGIN');
      try {
        await peer.exec('TRUNCATE public.inventory_source');
        const statements: string[] = [];
        await refused(collect(c, synchronized(c.client, b => {
          if (b.when === 'before' && b.mode.includes('repeatable read')) statements.push(b.text);
        })));
        expect(statements.filter(text => !text.startsWith('SET LOCAL'))).toHaveLength(1);
        expect(statements.find(text => text.startsWith('LOCK TABLE'))).toContain(' IN ACCESS SHARE MODE NOWAIT');
        expect(statements.some(text => text.startsWith('SELECT'))).toBe(false);
      } finally { await peer.exec('ROLLBACK'); }
      let probed = false;
      const captured = await collect(c, synchronized(c.client, async b => {
        if (!probed && b.when === 'before' && b.text.startsWith('DECLARE ')
          && b.text.includes('LEFT JOIN ONLY "public"."inventory_source"')) {
          probed = true; await peer.exec("BEGIN; SET LOCAL lock_timeout='100ms'");
          try { await expect(peer.exec('TRUNCATE public.inventory_source')).rejects.toMatchObject({ code: '55P03' }); }
          finally { await peer.exec('ROLLBACK'); }
        }
      }));
      expect(probed).toBe(true); expect(captured.rowCount).toBe('2');
      await peer.exec('TRUNCATE public.inventory_source'); expect((await collect(c)).rowCount).toBe('0');
    });
  }), 30000);

  it('rejects actual non-maintenance LOGINs and wrong targets with one redacted failure', async () => fixture(async c => {
    await c.client.unsafe('CREATE TABLE public.inventory_source(id integer)');
    await refused(collectRoutineOwnershipInventory(c.client, { ...c.target, database: 'wrong_owned_database' }, KEY));
    await refused(collectRoutineOwnershipInventory(c.client, { ...c.target, maintenance: 'wrong_owned_role' }, KEY));
    await refused(collectRoutineOwnershipInventory(c.client, c.target, SECRET));
    await c.f.withRuntimeRole!(async runtime => {
      await refused(collectRoutineOwnershipInventory(runtime.db.$client as unknown as Sql,
        { database: c.target.database, maintenance: runtime.role }, KEY));
      expect((await runtime.exec('SELECT current_user=session_user AS real_login'))[0].real_login).toBe(true);
    });
    expect((await collect(c)).rowCount).toBe('0');
  }), 30000);

  it('refuses oversized text and tiny JSONB with large numeric expansion without returning an apparently complete report', async () => fixture(async c => {
    await c.client.unsafe('CREATE TABLE public.inventory_source(payload text)');
    await c.client.unsafe('INSERT INTO public.inventory_source VALUES($1)', [SECRET + 'x'.repeat(262145)]);
    await refused(collect(c));
    await c.client.unsafe('DROP TABLE public.inventory_source; CREATE TABLE public.inventory_json(payload jsonb)');
    // A root numeric leaf must be recognized by the strict recursive path.
    // This one legal value is ~100k text, below the row cap.
    await c.client.unsafe("INSERT INTO public.inventory_json VALUES('1e100000'::jsonb)");
    expect((await collect(c)).rowCount).toBe('1');
    await c.client.unsafe("UPDATE public.inventory_json SET payload='{\"a\":1e100000,\"b\":1e100000,\"c\":1e100000}'::jsonb");
    const [small] = await c.client.unsafe<{ bytes: number }[]>('SELECT pg_column_size(payload) AS bytes FROM public.inventory_json');
    expect(small.bytes).toBeLessThan(32768); await refused(collect(c));
    expect((await c.client.unsafe('SELECT count(*)::text AS count FROM public.inventory_json'))[0].count).toBe('1');
    await c.client.unsafe(`DROP TABLE public.inventory_json; CREATE TABLE public.inventory_source(id integer);
      INSERT INTO public.inventory_source VALUES(1);
      ALTER TABLE public.inventory_source ADD COLUMN metadata_json jsonb
        DEFAULT '{"a":1e100000,"b":1e100000,"c":1e100000}'::jsonb`);
    const [missing] = await c.client.unsafe<{ atthasmissing: boolean; bytes: number }[]>(
      `SELECT atthasmissing,pg_column_size(attmissingval) AS bytes FROM pg_attribute
        WHERE attrelid='public.inventory_source'::regclass AND attname='metadata_json'`);
    expect(missing.atthasmissing).toBe(true); expect(missing.bytes).toBeLessThan(32768);
    let catalogSerializationStarted = false;
    await refused(collect(c, synchronized(c.client, b => {
      if (b.when === 'before' && b.text.startsWith('DECLARE ')) catalogSerializationStarted = true;
    })));
    expect(catalogSerializationStarted).toBe(false);
  }), 30000);

  it.each(['foreign', 'materialized', 'custom'] as const)('refuses %s storage instead of silently omitting it or executing its output', async kind => fixture(async c => {
    await c.client.unsafe('CREATE TABLE public.inventory_source(id integer); INSERT INTO public.inventory_source VALUES(1)');
    if (kind === 'foreign') await c.client.unsafe(`CREATE FOREIGN DATA WRAPPER inventory_fdw NO HANDLER NO VALIDATOR;
      CREATE SERVER inventory_remote FOREIGN DATA WRAPPER inventory_fdw;
      CREATE FOREIGN TABLE public.inventory_unsupported(id integer) SERVER inventory_remote`);
    else if (kind === 'materialized') await c.client.unsafe('CREATE MATERIALIZED VIEW public.inventory_unsupported AS SELECT * FROM public.inventory_source');
    else {
      // Fast ADD COLUMN stores an enum array in pg_attribute.attmissingval.
      // Its custom JSON cast must not run while streaming catalog metadata.
      await c.client.unsafe(`CREATE TYPE public.inventory_enum AS ENUM('x');
        CREATE FUNCTION public.inventory_cast(public.inventory_enum) RETURNS json LANGUAGE plpgsql VOLATILE AS $$
          BEGIN PERFORM pg_advisory_lock(731715,92); RETURN '"not-executed"'::json; END $$;
        CREATE CAST(public.inventory_enum AS json) WITH FUNCTION public.inventory_cast(public.inventory_enum);
        ALTER TABLE public.inventory_source ADD COLUMN unsupported public.inventory_enum NOT NULL DEFAULT 'x'`);
      expect((await c.client.unsafe(`SELECT atthasmissing FROM pg_attribute
        WHERE attrelid='public.inventory_source'::regclass AND attname='unsupported'`))[0].atthasmissing).toBe(true);
    }
    try {
      await refused(collect(c));
      if (kind === 'custom') await c.f.withPeer!(async peer => {
        const [probe] = await peer.exec('SELECT pg_try_advisory_lock(731715,92) AS untouched');
        expect(probe.untouched).toBe(true);
        if (probe.untouched) await peer.exec('SELECT pg_advisory_unlock(731715,92)');
      });
      expect((await c.client.unsafe('SELECT id FROM public.inventory_source'))[0].id).toBe(1);
    } finally { if (kind === 'custom') await c.client.unsafe('SELECT pg_advisory_unlock(731715,92)'); }
  }), 30000);

  it.each(['empty', 'custom-cast'] as const)('rejects %s replacement after schema rename even after RR catalogs froze', async replacement => fixture(async c => {
    await c.client.unsafe('CREATE TABLE public.inventory_source(id integer); INSERT INTO public.inventory_source VALUES(1)');
    await c.f.withPeer!(async peer => {
      let changed = false;
      const observed = synchronized(c.client, async b => {
        if (!changed && b.when === 'before' && b.mode.includes('repeatable read') && b.text.startsWith('DECLARE ')
          && b.text.includes('LEFT JOIN ONLY "public"."inventory_source"')) {
          changed = true;
          await peer.exec('ALTER SCHEMA public RENAME TO inventory_original; CREATE SCHEMA public');
          if (replacement === 'empty') await peer.exec('CREATE TABLE public.inventory_source(id integer)');
          else await peer.exec(`CREATE TYPE public.inventory_enum AS ENUM('x');
            CREATE FUNCTION public.inventory_cast(public.inventory_enum) RETURNS json LANGUAGE plpgsql VOLATILE AS $$
              BEGIN PERFORM pg_advisory_lock(731715,91); RETURN '{"secret":"not-executed"}'::json; END $$;
            CREATE CAST(public.inventory_enum AS json) WITH FUNCTION public.inventory_cast(public.inventory_enum);
            CREATE TABLE public.inventory_source(id public.inventory_enum); INSERT INTO public.inventory_source VALUES('x')`);
        }
      });
      try {
        await refused(collect(c, observed)); expect(changed).toBe(true);
        const [probe] = await peer.exec('SELECT pg_try_advisory_lock(731715,91) AS untouched');
        expect(probe.untouched).toBe(true);
        if (probe.untouched) await peer.exec('SELECT pg_advisory_unlock(731715,91)');
        expect((await peer.exec('SELECT count(*)::text AS count FROM inventory_original.inventory_source'))[0].count).toBe('1');
      } finally { await c.client.unsafe('SELECT pg_advisory_unlock(731715,91)'); }
    });
  }), 30000);
});
