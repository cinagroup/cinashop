import { readFileSync, readdirSync } from 'node:fs';
import { assertExternalMigrationCohort, composeExplicitCityCatalog, registeredTableNames } from './helpers/registeredCatalogCohort';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { MigrationService } from '@/services/MigrationService';
import { PINK_SUCCESS_NOTICE_SQL, PINK_SUCCESS_NOTICE_CHECK_DEFINITION, PINK_SUCCESS_NOTICE_EVENTS } from '@/migrations/pinkSuccessNotice';
import { runPinkSuccessNotice } from '@/migrations/runPinkSuccessNotice';
import { financePostgres } from './helpers/financePostgres';
import { outcome, withFinancePeers } from './helpers/financePeers';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { PRICING_OWNER_SETTING } from '@/migrations/checkoutPricingLockCatalog';
import { SECKILL_TIME_REFERENCE_OWNER_SETTING } from '@/migrations/seckillTimeReferenceLockCatalog';
import { readCatalog, type Catalog } from '../scripts/data-migration/postgres-catalog-audit';

const events = PINK_SUCCESS_NOTICE_EVENTS.slice(0, -1);
const oldCheck = `CHECK (event_type IN (${events.map(e => `'${e}'`).join(',')}))`;
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const originalComment = 'Keep owner\'s CHECK and "quoted" migration evidence';
describe.runIf(native)('pink success event forward migration (no business/ACL mutation)', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const apply = async (failAfterDdl = false) => {
    if (native) return f.db.$client.begin('isolation level read committed', async tx => {
      await tx.unsafe(PINK_SUCCESS_NOTICE_SQL);
      if (failAfterDdl) await tx.unsafe('SELECT 1/0');
    });
    // f.exec uses the driver's simple-query path for multi-statement DDL.
    await f.exec('BEGIN');
    try {
      await f.exec(PINK_SUCCESS_NOTICE_SQL);
      if (failAfterDdl) await f.exec('SELECT 1/0');
      await f.exec('COMMIT');
    } catch (error) { await f.exec('ROLLBACK'); throw error; }
  };
  const state = async () => {
    const rows = await f.db.execute(sql`SELECT * FROM public.store_order_outbox ORDER BY id`);
    const catalog = await f.db.execute(sql`SELECT c.oid,c.convalidated,pg_get_constraintdef(c.oid) AS definition,
      obj_description(c.oid,'pg_constraint') AS comment,t.oid AS table_oid,t.relowner,t.relacl,t.relrowsecurity,t.relforcerowsecurity,
      a.attcollation,a.attidentity,a.atthasdef,pg_get_expr(d.adbin,d.adrelid) AS column_default
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname='event_type'
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE c.conrelid='public.store_order_outbox'::regclass AND c.conname='soob_event_type_ck'`);
    return { rows: Array.from(rows), catalog: Array.from(catalog) };
  };
  beforeAll(async () => {
    try {
      f = await financePostgres([], { namespace: 'public' });
      await f.exec('CREATE TABLE public.store_order_outbox (id serial PRIMARY KEY, event_type varchar(64) NOT NULL, payload jsonb NOT NULL)');
    } catch (error) { try { await f?.close(); } finally { throw error; } }
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.exec(`TRUNCATE public.store_order_outbox RESTART IDENTITY;
      ALTER TABLE public.store_order_outbox DISABLE ROW LEVEL SECURITY;
      ALTER TABLE public.store_order_outbox NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE public.store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck;
      ALTER TABLE public.store_order_outbox ALTER COLUMN event_type TYPE varchar(64) COLLATE "default";
      ALTER TABLE public.store_order_outbox ALTER COLUMN event_type DROP DEFAULT;
      ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${oldCheck};
      COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS '${originalComment.replaceAll("'", "''")}';
      INSERT INTO public.store_order_outbox(event_type,payload) VALUES ('order.paid','{"local":true}')`);
  });
  it('keeps embedded and external SQL byte-identical for the caller-owned transaction', () => {
    expect(events).toHaveLength(10); expect(PINK_SUCCESS_NOTICE_EVENTS).toHaveLength(11);
    expect(readFileSync('migrations/0168_pink_success_notice.sql', 'utf8')).toBe(PINK_SUCCESS_NOTICE_SQL);
    expect(new MigrationService(createContainerFromDb(f.db)).pinkSuccessNoticeSqlForVerification()).toBe(PINK_SUCCESS_NOTICE_SQL);
  });
  it('expands the known check, preserves all rows/owner/ACL and is a true no-op on repeat', async () => {
    const before = await state(); await apply(); const after = await state();
    expect(after.rows).toEqual(before.rows);
    expect(after.catalog[0]).toMatchObject({ relowner: before.catalog[0].relowner, relacl: before.catalog[0].relacl,
      definition: PINK_SUCCESS_NOTICE_CHECK_DEFINITION, comment: originalComment, convalidated: true, table_oid: before.catalog[0].table_oid });
    for (const event of PINK_SUCCESS_NOTICE_EVENTS) await f.db.execute(sql`INSERT INTO public.store_order_outbox(event_type,payload) VALUES(${event},'{}')`);
    const final = await state(); await apply(); expect(await state()).toEqual(final);
    await expect(f.exec("INSERT INTO public.store_order_outbox(event_type,payload) VALUES ('unknown.event','{}')")).rejects.toThrow();
    expect(await state()).toEqual(final);
  });
  it.each(['missing', 'widened', 'unvalidated'])('rejects %s CHECK drift without changing rows or schema', async fault => {
    await f.exec('ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck');
    if (fault !== 'missing') await f.exec(`ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${fault === 'widened' ? 'CHECK (true)' : oldCheck + ' NOT VALID'}`);
    const before = await state(); await expect(apply()).rejects.toThrow(); expect(await state()).toEqual(before);
  });
  it.each([
    ['collation', false], ['collation', true], ['default', false], ['default', true],
  ] as const)('rejects %s column drift (already expanded=%s) and preserves all rows/catalog', async (fault, expanded) => {
    if (expanded) await apply();
    const registered = await state();
    await f.exec(fault === 'collation'
      ? 'ALTER TABLE public.store_order_outbox ALTER COLUMN event_type TYPE varchar(64) COLLATE "C"'
      : "ALTER TABLE public.store_order_outbox ALTER COLUMN event_type SET DEFAULT 'order.paid'");
    const before = await state();
    if (fault === 'collation') {
      const registeredEvents = expanded ? PINK_SUCCESS_NOTICE_EVENTS : events;
      expect(before.catalog[0].definition).toBe(
        `CHECK (((event_type)::text = ANY (ARRAY[${registeredEvents.map(event => `('${event}'::character varying)::text`).join(', ')}])))`,
      );
    } else {
      expect(before.catalog[0].definition).toBe(registered.catalog[0].definition);
    }
    expect(before.rows).toEqual(registered.rows);
    await expect(apply()).rejects.toThrow('CHECK drift');
    expect(await state()).toEqual(before);
  });
  it.each(['ENABLE', 'FORCE'])('rejects %s ROW LEVEL SECURITY without changing the current catalog or rows', async mode => {
    await f.exec(`ALTER TABLE public.store_order_outbox ${mode} ROW LEVEL SECURITY`);
    const before = await state(); await expect(apply()).rejects.toThrow('prerequisite drift'); expect(await state()).toEqual(before);
  });
  it('rolls back expansion with a later SQL error', async () => {
    const before = await state();
    await expect(apply(true)).rejects.toThrow('division by zero');
    expect(await state()).toEqual(before);
  });
  it('refuses an oversized maintenance table without narrowing or changing rows', async () => {
    await f.exec("INSERT INTO public.store_order_outbox(event_type,payload) SELECT 'order.paid','{}' FROM generate_series(1,10000)");
    const before = await state();
    await expect(apply()).rejects.toThrow('row budget exceeded'); expect(await state()).toEqual(before);
  });
  it('refuses full-bootstrap replay before old narrowing migrations can execute', async () => {
    await apply(); const before = await state();
    expect(await new MigrationService(createContainerFromDb(f.db)).runAll()).toEqual({ executed: [],
      errors: ['Presale outbox already registered; use standalone forward upgrades, not runAll'] });
    expect(await state()).toEqual(before);
  });
  it.skipIf(!native)('executes the real standalone root transaction on PG16', async () => {
    await runPinkSuccessNotice(f.db);
    expect(String((await state()).catalog[0].definition)).toBe(PINK_SUCCESS_NOTICE_CHECK_DEFINITION);
  });
  it('refuses a peer-held table immediately with ACCESS EXCLUSIVE NOWAIT and leaves all rows and OIDs unchanged', async () => {
    const before = await state();
    await withFinancePeers(f.db, async ([blocker, installer]) => {
      try {
        await blocker.exec('BEGIN; SELECT id FROM public.store_order_outbox FOR SHARE');
        const started = performance.now(), result = await outcome(runPinkSuccessNotice(installer.db));
        expect(performance.now() - started).toBeLessThan(2000);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ code: '55P03' });
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect(await state()).toEqual(before);
  });
  it('caps local timeouts at 5s/1s/5s, preserves stricter settings and restores session settings', async () => {
    const settingsQuery = sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
      current_setting('idle_in_transaction_session_timeout') AS idle`;
    const before = await f.db.execute(settingsQuery);
    for (const [statement, lock, idle] of [[7000, 7000, 7000], [1000, 200, 1500]]) {
      await f.db.$client.begin(async tx => {
        await tx.unsafe(`SET LOCAL statement_timeout='${statement}ms'; SET LOCAL lock_timeout='${lock}ms'; SET LOCAL idle_in_transaction_session_timeout='${idle}ms'`);
        await tx.unsafe(PINK_SUCCESS_NOTICE_SQL);
        const [settings] = await tx.unsafe(`SELECT (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
          (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
          (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`);
        expect(settings).toEqual({ statement: Math.min(statement, 5000), lock: Math.min(lock, 1000), idle: Math.min(idle, 5000) });
      });
    }
    expect(await f.db.execute(settingsQuery)).toEqual(before);
  });
  it('enforces the actual five-second statement ceiling and rolls back a later timeout together with DDL', async () => {
    const before = await state(), started = performance.now();
    const result = await outcome(f.db.$client.begin(async tx => {
      await tx.unsafe(PINK_SUCCESS_NOTICE_SQL); await tx.unsafe('SELECT pg_sleep(5.2)');
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: '57014' });
    expect(performance.now() - started).toBeLessThan(8000); expect(await state()).toEqual(before);
  }, 12000);
});

type FullFixture = Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>;
const migrationFiles = () => readdirSync('migrations').filter(name => /^\d+.*\.sql$/u.test(name)).sort();
async function bindOwners(f: FullFixture) {
  if (!f.seckillTimeReferenceOwner) throw Error('Explicit fixture reference owner missing');
  await f.db.execute(sql`SELECT set_config(${PRICING_OWNER_SETTING},${f.pricingOwner},false),
    set_config(${SECKILL_TIME_REFERENCE_OWNER_SETTING},${f.seckillTimeReferenceOwner},false)`);
}
async function externalMigrations(f: FullFixture, names: string[]) {
  await bindOwners(f);
  for (const name of names) await f.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
    await tx.execute(sql.raw(readFileSync(`migrations/${name}`, 'utf8')));
  });
}
async function fullCatalog(f: FullFixture) {
  return readCatalog(async query => (await f.query(query)).rows.map(row => {
    if (typeof row.key !== 'string' || typeof row.name !== 'string') throw Error('Invalid catalog row identity');
    return { ...row, key: row.key, name: row.name };
  }));
}
function withoutEventCheck(catalog: Catalog): Catalog {
  return { ...catalog, constraints: catalog.constraints.filter(row => row.key !== 'store_order_outbox.soob_event_type_ck') };
}
async function identitiesAndAcl(f: FullFixture) {
  return {
    relations: (await f.query(`SELECT c.oid,c.relname,c.relkind,c.relowner,c.relacl,c.reloptions,c.relpersistence,
      c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname`)).rows,
    routines: (await f.query(`SELECT p.oid,p.proname,p.proowner,p.proacl,p.prosrc,p.proconfig
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid`)).rows,
    schema: (await f.query(`SELECT oid,nspowner,nspacl FROM pg_namespace WHERE nspname='public'`)).rows,
    columns: (await f.query(`SELECT c.relname,a.attnum,a.attname,a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)).rows,
    constraints: (await f.query(`SELECT c.oid,c.conname,c.conrelid,c.convalidated,obj_description(c.oid,'pg_constraint') AS comment
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace
      AND NOT (t.relname='store_order_outbox' AND c.conname='soob_event_type_ck') ORDER BY c.oid`)).rows,
  };
}
async function businessRows(f: FullFixture): Promise<Record<string, string[]>> {
  const rows: Record<string, string[]> = {};
  const tables = (await f.query(`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname`)).rows;
  for (const { relname } of tables) {
    if (typeof relname !== 'string' || !relname) throw Error('Invalid table identity');
    rows[relname] = (await f.query(`SELECT to_jsonb(t)::text AS row_json FROM ONLY public."${relname.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`)).rows.map(row => {
      if (typeof row.row_json !== 'string') throw Error('Invalid captured business row'); return row.row_json;
    });
  }
  return rows;
}
async function eventCheck(f: FullFixture) {
  return (await f.query(`SELECT c.oid,c.convalidated,pg_get_constraintdef(c.oid) AS definition,
    obj_description(c.oid,'pg_constraint') AS comment FROM pg_constraint c
    WHERE c.conrelid='public.store_order_outbox'::regclass AND c.conname='soob_event_type_ck'`)).rows;
}

describe.runIf(native)('pink notice complete PG16 schema paths', () => {
  it('forwards all previous 171 external files using only 0168 while preserving every row, existing ACL/OID and other schema contract', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      // This forward intentionally stops at its historical terminal migration.
      const files = migrationFiles().filter(name => name <= '0168_pink_success_notice.sql');
      expect(files).toHaveLength(172); expect(files.at(-1)).toBe('0168_pink_success_notice.sql');
      expect(files).toContain('0166_recharge_quota_group_seed.sql');expect(files).toContain('0167_seckill_time_reference_lock.sql');
      const previous = files.slice(0, -1); expect(previous).toHaveLength(171); expect(previous.at(-1)).toBe('0167_seckill_time_reference_lock.sql');
      await externalMigrations(f, previous);
      await f.exec(`INSERT INTO public."user"(uid,account,now_money,brokerage_price) VALUES(10,'pink-notice-upgrade-user',123.45,6.78);
        INSERT INTO store_order(id,uid,order_id,total_price,pay_price) VALUES(1,10,'pink-notice-upgrade-order',20.50,20.50);
        INSERT INTO store_combination(id,product_id,people,virtual,status) VALUES(30,50,3,66,1);
        INSERT INTO store_pink(id,uid,order_id,order_id_key,combination_id,product_id,people,status) VALUES(1,10,'pink-notice-upgrade-order','1',30,50,3,1);
        INSERT INTO store_order_outbox(event_key,event_type,aggregate_id,payload) VALUES('order.paid:1','order.paid',1,'{"local":true}');
        COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS '${originalComment.replaceAll("'", "''")}';`);
      expect((await eventCheck(f))[0]).toMatchObject({ convalidated: true, comment: originalComment });
      expect(String((await eventCheck(f))[0].definition)).not.toContain('order.pink.success.notice');
      const role = f.withRuntimeRole; if (!role) throw Error('Real LOGIN fixture required');
      await role(async existing => {
        await f.exec(`GRANT SELECT ON public.store_order_outbox,public.store_combination,public.store_pink TO "${existing.role}";
          GRANT UPDATE(status) ON public.store_combination TO "${existing.role}"`);
        const rows = await businessRows(f), catalog = await fullCatalog(f), identity = await identitiesAndAcl(f);
        expect(Object.keys(rows)).toHaveLength(279);
        for (const table of ['user', 'store_order', 'store_combination', 'store_pink', 'store_order_outbox']) expect(rows[table]).toHaveLength(1);
        const rightsSql = sql`SELECT has_table_privilege(current_user,'public.store_order_outbox','SELECT') AS readable,
          has_table_privilege(current_user,'public.store_order_outbox','INSERT') AS insertable,
          has_table_privilege(current_user,'public.store_order_outbox','DELETE') AS removable,
          has_column_privilege(current_user,'public.store_combination','status','UPDATE') AS status_write,
          has_column_privilege(current_user,'public.store_combination','virtual','UPDATE') AS virtual_write`;
        const rights = await existing.db.execute(rightsSql);
        expect(Array.from(rights)).toEqual([{ readable: true, insertable: false, removable: false, status_write: true, virtual_write: false }]);
        await runPinkSuccessNotice(f.db);
        expect(await businessRows(f)).toEqual(rows);
        expect(withoutEventCheck(await fullCatalog(f))).toEqual(withoutEventCheck(catalog));
        expect(await identitiesAndAcl(f)).toEqual(identity);
        expect(await existing.db.execute(rightsSql)).toEqual(rights);
        expect(await existing.db.execute(sql`SELECT event_key FROM public.store_order_outbox ORDER BY id`)).toEqual([{ event_key: 'order.paid:1' }]);
        expect((await eventCheck(f))[0]).toMatchObject({ convalidated: true, definition: PINK_SUCCESS_NOTICE_CHECK_DEFINITION, comment: originalComment });
        const check = await eventCheck(f), afterCatalog = await fullCatalog(f);
        await runPinkSuccessNotice(f.db);
        expect(await eventCheck(f)).toEqual(check); expect(await fullCatalog(f)).toEqual(afterCatalog);
        expect(await identitiesAndAcl(f)).toEqual(identity); expect(await businessRows(f)).toEqual(rows);
      });
    } finally { await f.close(); }
  }, 120_000);

  it('builds fresh external 176 and embedded 180 paths with explicit city composition and identical five-category contracts for 285 tables', async () => {
    const external = await checkoutPricingMigrationDatabase();
    let embedded: FullFixture | undefined;
    try {
      embedded = await checkoutPricingMigrationDatabase();
      const files = migrationFiles(); assertExternalMigrationCohort(files); expect(files.at(-1)).toBe('0173_customer_city_delivery.sql');
      await externalMigrations(external, files);
      await bindOwners(embedded);
      const result = await new MigrationService(createContainerFromDb(embedded.db)).runAll();
      expect(result.errors).toEqual([]);
      expect(result.executed).toEqual(Array.from({ length: 180 }, (_, index) => String(index).padStart(4, '0')));
      await composeExplicitCityCatalog(external.db,'external');await composeExplicitCityCatalog(embedded.db,'embedded');
      expect(await fullCatalog(embedded)).toEqual(await fullCatalog(external));
      for (const f of [external, embedded]) {
        const rows = await businessRows(f), identity = await identitiesAndAcl(f), check = await eventCheck(f), catalog = await fullCatalog(f);
        expect(Object.keys(rows)).toEqual(registeredTableNames('external'));
        expect(check).toHaveLength(1); expect(check[0]).toMatchObject({ convalidated: true, definition: PINK_SUCCESS_NOTICE_CHECK_DEFINITION });
        for (const table of ['user', 'store_order', 'store_combination', 'store_pink', 'store_order_outbox']) expect(rows[table]).toEqual([]);
        await runPinkSuccessNotice(f.db);
        expect(await eventCheck(f)).toEqual(check); expect(await identitiesAndAcl(f)).toEqual(identity);
        expect(await fullCatalog(f)).toEqual(catalog); expect(await businessRows(f)).toEqual(rows);
        const invalid = await outcome(f.exec("INSERT INTO public.store_order_outbox(event_key,event_type,aggregate_id,payload) VALUES('unknown-fixture','unknown.event',0,'{}')"));
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) expect(invalid.error).toMatchObject({ code: '23514', constraint_name: 'soob_event_type_ck' });
        expect(await businessRows(f)).toEqual(rows); expect(await eventCheck(f)).toEqual(check);
      }
    } finally { try { await embedded?.close(); } finally { await external.close(); } }
  }, 180_000);
});
