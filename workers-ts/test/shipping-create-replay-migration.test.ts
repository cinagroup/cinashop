import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { SHIPPING_CREATE_REPLAY_INSTALLATION_SQL } from '../src/migrations/shippingTemplateCreateReplayInstallation';
import { SHIPPING_TEMPLATE_CREATE_REPLAY_SQL } from '../src/migrations/shippingTemplateCreateReplay';
import { SHIPPING_CREATE_REPLAY_CATALOG_SQL, SHIPPING_CREATE_REPLAY_EXPECTED_SHAPE } from '../src/migrations/shippingTemplateCreateReplayCatalog';
import { inspectShippingTemplateCreateReplay, runShippingTemplateCreateReplay } from '../src/migrations/runShippingTemplateCreateReplay';
import { shippingTemplateCreateReplay } from '../src/models/schema';

const table = 'public.shipping_template_create_replay';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('guarded shipping receipt migration on isolated PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => { f = await sequenceRunnerDatabase(); }, 30000);
  afterEach(async () => { await f?.close(); }, 45000);
  const shape = async () => (await f.db.execute(sql.raw(SHIPPING_CREATE_REPLAY_CATALOG_SQL)))[0];
  const identity = () => f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class
    WHERE oid=${table}::regclass OR oid IN(SELECT indexrelid FROM pg_index WHERE indrelid=${table}::regclass) ORDER BY oid`);
  const seed = () => f.db.execute(sql`INSERT INTO public.shipping_template_create_replay(owner_type,relation_id,actor_id,request_key,request_hash,template_id)
    VALUES(2,20,27,${crypto.randomUUID()}::uuid,${'a'.repeat(64)},100)`);
  it('the external file is byte-equal to the embedded installer', () => {
    expect(readFileSync('migrations/0154_shipping_template_create_replay.sql', 'utf8').trim()).toBe(SHIPPING_CREATE_REPLAY_INSTALLATION_SQL.trim());
  });
  it('installs an absent table and preserves populated evidence, table and index OIDs/files on repeated installation', async () => {
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ present: false, complete: false });
    await runShippingTemplateCreateReplay(f.db); await seed();
    expect(await shape()).toMatchObject({ present: true, safe: true, shape: SHIPPING_CREATE_REPLAY_EXPECTED_SHAPE });
    const before = await identity(), rows = await f.db.select().from(shippingTemplateCreateReplay);
    await runShippingTemplateCreateReplay(f.db); await runShippingTemplateCreateReplay(f.db);
    expect(await identity()).toEqual(before); expect(await f.db.select().from(shippingTemplateCreateReplay)).toEqual(rows);
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ complete: true });
  });
  it('accepts independently generated ORM DDL without replacing any object', async () => {
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson({ shippingTemplateCreateReplay }))).join('\n'));
    expect(await shape()).toMatchObject({ safe: true, shape: SHIPPING_CREATE_REPLAY_EXPECTED_SHAPE });
    const before = await identity(); await runShippingTemplateCreateReplay(f.db); expect(await identity()).toEqual(before);
  });
  it('executes the raw external installer twice within actual transactions', async () => {
    const file = readFileSync('migrations/0154_shipping_template_create_replay.sql', 'utf8');
    for (let n = 0; n < 2; n++) await f.db.transaction(tx => tx.execute(sql.raw(file)));
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ complete: true });
  });
  const drift = [
    `ALTER TABLE ${table} ALTER COLUMN actor_id TYPE bigint`,
    `ALTER TABLE ${table} ALTER COLUMN request_hash DROP NOT NULL`,
    `ALTER TABLE ${table} ALTER COLUMN created_at SET DEFAULT now()`,
    `ALTER TABLE ${table} ALTER COLUMN request_hash TYPE varchar(64) COLLATE "C"`,
    `ALTER TABLE ${table} ADD COLUMN unexpected text`,
    `ALTER TABLE ${table} DROP CONSTRAINT stcr_pk`,
    `ALTER TABLE ${table} DROP CONSTRAINT stcr_identity_ck; ALTER TABLE ${table} ADD CONSTRAINT stcr_identity_ck CHECK (actor_id >= 0 AND template_id > 0)`,
    `ALTER TABLE ${table} DROP CONSTRAINT stcr_identity_ck; ALTER TABLE ${table} ADD CONSTRAINT stcr_identity_ck CHECK (actor_id > 0 AND template_id > 0) NOT VALID`,
    `ALTER INDEX public.stcr_template_uq RENAME TO unknown_unique`,
    `CREATE INDEX unexpected ON ${table}(actor_id)`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY unexpected ON ${table} USING(true)`,
    `ALTER TABLE ${table} SET UNLOGGED`,
    `ALTER TABLE ${table} REPLICA IDENTITY FULL`,
    `ALTER TABLE ${table} SET (fillfactor=90)`,
    `CREATE TABLE public.receipt_child(parent integer REFERENCES ${table}(template_id) ON DELETE CASCADE)`,
    `CREATE RULE unexpected AS ON UPDATE TO ${table} DO INSTEAD NOTHING`,
    `GRANT SELECT ON ${table} TO PUBLIC`,
    `GRANT SELECT(request_key) ON ${table} TO PUBLIC`,
  ];
  for (const mutation of drift) it(`rejects drift without repairs: ${mutation}`, async () => {
    await f.exec(SHIPPING_TEMPLATE_CREATE_REPLAY_SQL); await seed(); await f.exec(mutation);
    const before = await shape(), ids = await identity(), rows = await f.db.execute(sql.raw(`SELECT * FROM ${table}`));
    await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow();
    expect(await shape()).toEqual(before); expect(await identity()).toEqual(ids);
    expect(await f.db.execute(sql.raw(`SELECT * FROM ${table}`))).toEqual(rows);
  });
  it('rejects a same-name view without replacing or renaming it', async () => {
    await f.exec(`CREATE VIEW ${table} AS SELECT 1 AS actor_id`);
    const before = await shape(); await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow();
    expect(await shape()).toEqual(before);
  });
  it('rejects a preexisting receipt trigger, even disabled, without changing it', async () => {
    await f.exec(SHIPPING_TEMPLATE_CREATE_REPLAY_SQL);
    await f.exec(`CREATE FUNCTION public.receipt_hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER receipt_hook BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.receipt_hook();
      ALTER TABLE ${table} DISABLE TRIGGER receipt_hook`);
    await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow();
    expect(await f.db.execute(sql`SELECT tgenabled::text FROM pg_trigger WHERE tgrelid=${table}::regclass`)).toMatchObject([{ tgenabled: 'D' }]);
  });
  it('rejects an enabled DDL event trigger before creating anything', async () => {
    await f.exec(`CREATE FUNCTION public.ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
      CREATE EVENT TRIGGER ddl_hook ON ddl_command_start EXECUTE FUNCTION public.ddl_hook()`);
    await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow();
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ present: false });
  });
  it('rolls back a newly created table when inherited default ACLs would expose receipts', async () => {
    await f.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC');
    await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow();
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ present: false });
    expect(await f.db.execute(sql`SELECT defaclacl::text FROM pg_default_acl`)).toHaveLength(1);
  });
  it('preserves safe runtime SELECT/INSERT grants and refuses mutable/grantable ACLs', async () => {
    await runShippingTemplateCreateReplay(f.db);
    await f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT,INSERT ON ${table} TO "${peer.role}"`);
      await runShippingTemplateCreateReplay(f.db);
      for (const grant of ['UPDATE', 'DELETE', 'TRUNCATE', 'SELECT WITH GRANT OPTION']) {
        const grantSql = grant === 'SELECT WITH GRANT OPTION' ? `SELECT ON ${table} TO "${peer.role}" WITH GRANT OPTION` : `${grant} ON ${table} TO "${peer.role}"`;
        await f.exec(`GRANT ${grantSql}`);
        await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow();
        await f.exec(`REVOKE ALL ON ${table} FROM "${peer.role}"; GRANT SELECT,INSERT ON ${table} TO "${peer.role}"`);
      }
      await f.exec(`GRANT UPDATE(request_hash) ON ${table} TO "${peer.role}"`);
      await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow();
    });
  });
  it('refuses non-owner runtime upgrades and preserves the real LOGIN identity', async () => {
    await runShippingTemplateCreateReplay(f.db);
    await f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT,INSERT ON ${table} TO "${peer.role}"`);
      await expect(runShippingTemplateCreateReplay(peer.db)).rejects.toThrow();
      expect(await peer.exec('SELECT current_user=session_user AS unchanged')).toMatchObject([{ unchanged: true }]);
    });
  });
  it('refuses a held relation lock immediately rather than queueing behind live writes', async () => {
    await runShippingTemplateCreateReplay(f.db); const before = await identity();
    await f.withPeer!(async peer => {
      await peer.exec(`BEGIN; LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
      try { await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow(); }
      finally { await peer.exec('ROLLBACK'); }
    });
    expect(await identity()).toEqual(before);
  });
  it('refuses concurrent installers before table creation', async () => {
    await f.withPeer!(async peer => {
      await peer.exec('BEGIN; SELECT pg_advisory_xact_lock(731606,0)');
      try { await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow(); }
      finally { await peer.exec('ROLLBACK'); }
    });
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ present: false });
  });
  it('requires a root transaction and rejects raw non-RC or replica-mode installation', async () => {
    await f.db.transaction(async tx => {
      await expect(runShippingTemplateCreateReplay(tx)).rejects.toThrow('root database');
    });
    for (const setup of ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", "SET LOCAL session_replication_role='replica'"]) {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(setup)); await tx.execute(sql.raw(SHIPPING_CREATE_REPLAY_INSTALLATION_SQL)); })).rejects.toThrow();
    }
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ present: false });
  });
  it.each([
    { limits: [0, 0, 0], expected: [30000, 1000, 5000] },
    { limits: [900, 700, 300], expected: [900, 700, 300] },
  ])('bounds local timeouts without relaxing stricter limits or leaking settings: $limits', async ({ limits, expected }) => {
    const settings = sql`SELECT name,setting FROM pg_settings WHERE name IN
      ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','search_path','row_security') ORDER BY name`;
    const before = await f.db.execute(settings);
    await f.db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout=${limits[0]}; SET LOCAL lock_timeout=${limits[1]};
        SET LOCAL idle_in_transaction_session_timeout=${limits[2]}`));
      await tx.execute(sql.raw(SHIPPING_CREATE_REPLAY_INSTALLATION_SQL));
      const rows = await tx.execute(settings);
      const actual = Object.fromEntries(rows.map(row => [row.name, row.setting]));
      expect(actual).toMatchObject({ statement_timeout: String(expected[0]), lock_timeout: String(expected[1]),
        idle_in_transaction_session_timeout: String(expected[2]), search_path: 'public, pg_temp', row_security: 'off' });
    });
    expect(await f.db.execute(settings)).toEqual(before);
  });
  it('installs only in public and preserves temporary and other-schema namesakes', async () => {
    await f.exec(`CREATE SCHEMA receipt_other;
      CREATE TABLE receipt_other.shipping_template_create_replay(marker integer);
      INSERT INTO receipt_other.shipping_template_create_replay VALUES(17);
      CREATE TEMP TABLE shipping_template_create_replay(marker integer);
      INSERT INTO pg_temp.shipping_template_create_replay VALUES(23)`);
    const before = await f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class
      WHERE relname='shipping_template_create_replay' ORDER BY oid`);
    await runShippingTemplateCreateReplay(f.db);
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ complete: true });
    expect(await f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class
      WHERE relname='shipping_template_create_replay' AND relnamespace<>'public'::regnamespace ORDER BY oid`)).toEqual(before);
    expect(await f.exec('SELECT * FROM receipt_other.shipping_template_create_replay')).toEqual([{ marker: 17 }]);
    expect(await f.exec('SELECT * FROM pg_temp.shipping_template_create_replay')).toEqual([{ marker: 23 }]);
  });
  it('rolls back partial DDL when a canonical index name belongs to another relation', async () => {
    await f.exec('CREATE TABLE public.receipt_unrelated(id integer PRIMARY KEY); INSERT INTO public.receipt_unrelated VALUES(1); ALTER INDEX public.receipt_unrelated_pkey RENAME TO stcr_pk');
    const before = await f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class WHERE relname IN ('receipt_unrelated','stcr_pk') ORDER BY oid`);
    await expect(runShippingTemplateCreateReplay(f.db)).rejects.toThrow();
    expect(await inspectShippingTemplateCreateReplay(f.db)).toMatchObject({ present: false });
    expect(await f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class WHERE relname IN ('receipt_unrelated','stcr_pk') ORDER BY oid`)).toEqual(before);
    expect(await f.exec('SELECT * FROM public.receipt_unrelated')).toEqual([{ id: 1 }]);
  });
});
