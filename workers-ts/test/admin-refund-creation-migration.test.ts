import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { checkoutPricingMigrationDatabase as sequenceRunnerDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { ADMIN_REFUND_CREATION_INSTALLATION_SQL } from '../src/migrations/adminRefundCreationInstallation';
import { ADMIN_REFUND_CREATION_SQL } from '../src/migrations/adminRefundCreation';
import { ADMIN_REFUND_CREATION_CATALOG_SQL, ADMIN_REFUND_CREATION_EXPECTED_SHAPE } from '../src/migrations/adminRefundCreationCatalog';
import { inspectAdminRefundCreation, runAdminRefundCreation } from '../src/migrations/runAdminRefundCreation';
import { adminRefundCreation } from '../src/models/schema';
import * as models from '../src/models/schema';
import { MigrationService } from '../src/services/MigrationService';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { appendRefundCreation, readRefundCreation } from '../src/services/admin/AdminRefundCreationLedger';

const table = 'public.admin_refund_creation';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('guarded Admin refund creation receipt migration on isolated PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => { f = await sequenceRunnerDatabase(); }, 30000);
  afterEach(async () => { await f?.close(); }, 45000);
  const shape = async () => (await f.db.execute(sql.raw(ADMIN_REFUND_CREATION_CATALOG_SQL)))[0];
  const identity = () => f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class
    WHERE oid=${table}::regclass OR oid IN(SELECT indexrelid FROM pg_index WHERE indrelid=${table}::regclass) ORDER BY oid`);
  const seed = () => f.db.execute(sql`INSERT INTO public.admin_refund_creation(admin_id,request_key,request_hash,order_id,refund_id,outcome)
    VALUES(27,${crypto.randomUUID()}::uuid,${'a'.repeat(64)},100,200,'created'),(27,${crypto.randomUUID()}::uuid,${'b'.repeat(64)},100,NULL,'abandoned')`);
  it('the external file is byte-equal to the embedded installer', () => {
    expect(readFileSync('migrations/0156_admin_refund_creation.sql', 'utf8').trim()).toBe(ADMIN_REFUND_CREATION_INSTALLATION_SQL.trim());
  });
  it('installs an absent table and preserves populated evidence, table and index OIDs/files on repeated installation', async () => {
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ present: false, complete: false });
    await runAdminRefundCreation(f.db); await seed();
    expect(await shape()).toMatchObject({ present: true, safe: true, shape: ADMIN_REFUND_CREATION_EXPECTED_SHAPE });
    const before = await identity(), rows = await f.db.select().from(adminRefundCreation);
    await runAdminRefundCreation(f.db); await runAdminRefundCreation(f.db);
    expect(await identity()).toEqual(before); expect(await f.db.select().from(adminRefundCreation)).toEqual(rows);
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ complete: true });
  });
  it('accepts independently generated ORM DDL without replacing any object', async () => {
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson({ adminRefundCreation }))).join('\n'));
    expect(await shape()).toMatchObject({ safe: true, shape: ADMIN_REFUND_CREATION_EXPECTED_SHAPE });
    const before = await identity(); await runAdminRefundCreation(f.db); expect(await identity()).toEqual(before);
  });
  it('executes the raw external installer twice within actual transactions', async () => {
    const file = readFileSync('migrations/0156_admin_refund_creation.sql', 'utf8');
    for (let n = 0; n < 2; n++) await f.db.transaction(tx => tx.execute(sql.raw(file)));
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ complete: true });
  });
  it.each(['external','embedded','orm'] as const)('registers the receipt in the complete %s schema before any standalone repair', async path => {
    if (path==='external') {
      const files=readdirSync('migrations').filter(name=>/^\d+.*\.sql$/.test(name)).sort();
      expect(files.at(-1)).toBe('0160_checkout_pricing_lock.sql');
      for (const file of files) await f.db.transaction(async tx=>{
        await tx.execute(sql`SET LOCAL search_path=public,pg_temp`);
        await tx.execute(sql.raw(readFileSync(`migrations/${file}`,'utf8')));
      });
    } else if (path==='embedded') {
      expect(await new MigrationService(createContainerFromDb(f.db)).runAll()).toEqual({
        executed:Array.from({length: 167},(_,i)=>String(i).padStart(4,'0')),errors:[],
      });
    } else {
      const api=await import('drizzle-kit/api');
      await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
    }
    expect(await f.db.execute(sql`SELECT COUNT(*)::int AS count FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')`)).toMatchObject([{count:277}]);
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({present:true,complete:true});
    expect(await shape()).toMatchObject({safe:true,shape:ADMIN_REFUND_CREATION_EXPECTED_SHAPE});
    await seed();const before=await identity(),rows=await f.db.select().from(adminRefundCreation);
    await runAdminRefundCreation(f.db);await runAdminRefundCreation(f.db);
    expect(await identity()).toEqual(before);expect(await f.db.select().from(adminRefundCreation)).toEqual(rows);
  },120000);
  const drift = [
    `ALTER TABLE ${table} ALTER COLUMN admin_id TYPE bigint`,
    `ALTER TABLE ${table} ALTER COLUMN request_hash DROP NOT NULL`,
    `ALTER TABLE ${table} DROP CONSTRAINT arc_outcome_ck`,
    `ALTER TABLE ${table} ALTER COLUMN refund_id SET DEFAULT 1`,
    `ALTER TABLE ${table} ALTER COLUMN created_at SET DEFAULT now()`,
    `ALTER TABLE ${table} ALTER COLUMN request_hash TYPE varchar(64) COLLATE "C"`,
    `ALTER TABLE ${table} ADD COLUMN unexpected text`,
    `ALTER TABLE ${table} DROP CONSTRAINT arc_pk`,
    `ALTER TABLE ${table} DROP CONSTRAINT arc_identity_ck; ALTER TABLE ${table} ADD CONSTRAINT arc_identity_ck CHECK (admin_id >= 0 AND order_id > 0)`,
    `ALTER TABLE ${table} DROP CONSTRAINT arc_identity_ck; ALTER TABLE ${table} ADD CONSTRAINT arc_identity_ck CHECK (admin_id > 0 AND order_id > 0) NOT VALID`,
    `ALTER INDEX public.arc_order_history RENAME TO unknown_unique`,
    `CREATE INDEX unexpected ON ${table}(admin_id)`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY unexpected ON ${table} USING(true)`,
    `ALTER TABLE ${table} SET UNLOGGED`,
    `ALTER TABLE ${table} REPLICA IDENTITY FULL`,
    `ALTER TABLE ${table} SET (fillfactor=90)`,
    `CREATE TABLE public.receipt_child(admin_id integer,request_key uuid,FOREIGN KEY(admin_id,request_key) REFERENCES ${table}(admin_id,request_key) ON DELETE CASCADE)`,
    `CREATE RULE unexpected AS ON UPDATE TO ${table} DO INSTEAD NOTHING`,
    `GRANT SELECT ON ${table} TO PUBLIC`,
    `GRANT SELECT(request_key) ON ${table} TO PUBLIC`,
  ];
  for (const mutation of drift) it(`rejects drift without repairs: ${mutation}`, async () => {
    await f.exec(ADMIN_REFUND_CREATION_SQL); await seed(); await f.exec(mutation);
    const before = await shape(), ids = await identity(), rows = await f.db.execute(sql.raw(`SELECT * FROM ${table}`));
    await expect(runAdminRefundCreation(f.db)).rejects.toThrow();
    expect(await shape()).toEqual(before); expect(await identity()).toEqual(ids);
    expect(await f.db.execute(sql.raw(`SELECT * FROM ${table}`))).toEqual(rows);
  });
  it('rejects a same-name view without replacing or renaming it', async () => {
    await f.exec(`CREATE VIEW ${table} AS SELECT 1 AS admin_id`);
    const before = await shape(); await expect(runAdminRefundCreation(f.db)).rejects.toThrow();
    expect(await shape()).toEqual(before);
  });
  it('rejects a preexisting receipt trigger, even disabled, without changing it', async () => {
    await f.exec(ADMIN_REFUND_CREATION_SQL);
    await f.exec(`CREATE FUNCTION public.receipt_hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER receipt_hook BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.receipt_hook();
      ALTER TABLE ${table} DISABLE TRIGGER receipt_hook`);
    await expect(runAdminRefundCreation(f.db)).rejects.toThrow();
    expect(await f.db.execute(sql`SELECT tgenabled::text FROM pg_trigger WHERE tgrelid=${table}::regclass`)).toMatchObject([{ tgenabled: 'D' }]);
  });
  it('rejects an enabled DDL event trigger before creating anything', async () => {
    await f.exec(`CREATE FUNCTION public.ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
      CREATE EVENT TRIGGER ddl_hook ON ddl_command_start EXECUTE FUNCTION public.ddl_hook()`);
    await expect(runAdminRefundCreation(f.db)).rejects.toThrow();
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ present: false });
  });
  it('rolls back a newly created table when inherited default ACLs would expose receipts', async () => {
    await f.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC');
    await expect(runAdminRefundCreation(f.db)).rejects.toThrow();
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ present: false });
    expect(await f.db.execute(sql`SELECT defaclacl::text FROM pg_default_acl`)).toHaveLength(1);
  });
  it('preserves safe runtime SELECT/INSERT grants and refuses mutable/grantable ACLs', async () => {
    await runAdminRefundCreation(f.db);
    await f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT,INSERT ON ${table} TO "${peer.role}"`);
      await runAdminRefundCreation(f.db);
      for (const grant of ['UPDATE', 'DELETE', 'TRUNCATE', 'SELECT WITH GRANT OPTION']) {
        const grantSql = grant === 'SELECT WITH GRANT OPTION' ? `SELECT ON ${table} TO "${peer.role}" WITH GRANT OPTION` : `${grant} ON ${table} TO "${peer.role}"`;
        await f.exec(`GRANT ${grantSql}`);
        await expect(runAdminRefundCreation(f.db)).rejects.toThrow();
        await f.exec(`REVOKE ALL ON ${table} FROM "${peer.role}"; GRANT SELECT,INSERT ON ${table} TO "${peer.role}"`);
      }
      await f.exec(`GRANT UPDATE(request_hash) ON ${table} TO "${peer.role}"`);
      await expect(runAdminRefundCreation(f.db)).rejects.toThrow();
    });
  });
  it('refuses non-owner runtime upgrades and preserves the real LOGIN identity', async () => {
    await runAdminRefundCreation(f.db);
    await f.withRuntimeRole!(async peer => {
      await f.exec(`GRANT SELECT,INSERT ON ${table} TO "${peer.role}"`);
      await expect(runAdminRefundCreation(peer.db)).rejects.toThrow();
      expect(await peer.exec('SELECT current_user=session_user AS unchanged')).toMatchObject([{ unchanged: true }]);
    });
  });
  it('executes receipt read/append as a real restricted LOGIN but denies mutation and privilege recovery', async () => {
    await runAdminRefundCreation(f.db);
    await f.withRuntimeRole!(async peer=>{
      await f.exec(`GRANT SELECT,INSERT ON ${table} TO "${peer.role}"`);
      const container=createContainerFromDb(peer.db);
      for (const refundId of [200,null]) {
        const intent={adminId:27,orderId:100,requestKey:crypto.randomUUID(),requestHash:'a'.repeat(64)};
        const receipt=await withTx(container,tx=>appendRefundCreation(tx,intent,refundId));
        expect(await withTx(container,tx=>readRefundCreation(tx,27,intent.requestKey))).toEqual(receipt);
        expect(await withTx(container,tx=>appendRefundCreation(tx,intent,refundId))).toEqual(receipt);
        await expect(withTx(container,tx=>appendRefundCreation(tx,intent,refundId===null?200:null))).rejects.toThrow();
      }
      const before=await f.db.select().from(adminRefundCreation);
      for (const statement of [`UPDATE ${table} SET request_hash='${'c'.repeat(64)}'`,`DELETE FROM ${table}`,`TRUNCATE ${table}`,
        `ALTER TABLE ${table} ADD COLUMN unexpected text`,`SET ROLE finance_test`]) {
        await expect(peer.exec(statement)).rejects.toMatchObject({code:'42501'});
      }
      await peer.exec('RESET ROLE');
      expect(await peer.exec('SELECT current_user=session_user AS unchanged')).toMatchObject([{unchanged:true}]);
      expect(await f.db.select().from(adminRefundCreation)).toEqual(before);
      await runAdminRefundCreation(f.db);
    });
  });
  it('refuses a held relation lock immediately rather than queueing behind live writes', async () => {
    await runAdminRefundCreation(f.db); const before = await identity();
    await f.withPeer!(async peer => {
      await peer.exec(`BEGIN; LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
      try { await expect(runAdminRefundCreation(f.db)).rejects.toThrow(); }
      finally { await peer.exec('ROLLBACK'); }
    });
    expect(await identity()).toEqual(before);
  });
  it('refuses concurrent installers before table creation', async () => {
    await f.withPeer!(async peer => {
      await peer.exec('BEGIN; SELECT pg_advisory_xact_lock(731610,0)');
      try { await expect(runAdminRefundCreation(f.db)).rejects.toThrow(); }
      finally { await peer.exec('ROLLBACK'); }
    });
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ present: false });
  });
  it('requires a root transaction and rejects raw non-RC or replica-mode installation', async () => {
    await f.db.transaction(async tx => {
      await expect(runAdminRefundCreation(tx)).rejects.toThrow('root database');
    });
    for (const setup of ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", "SET LOCAL session_replication_role='replica'"]) {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(setup)); await tx.execute(sql.raw(ADMIN_REFUND_CREATION_INSTALLATION_SQL)); })).rejects.toThrow();
    }
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ present: false });
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
      await tx.execute(sql.raw(ADMIN_REFUND_CREATION_INSTALLATION_SQL));
      const rows = await tx.execute(settings);
      const actual = Object.fromEntries(rows.map(row => [row.name, row.setting]));
      expect(actual).toMatchObject({ statement_timeout: String(expected[0]), lock_timeout: String(expected[1]),
        idle_in_transaction_session_timeout: String(expected[2]), search_path: 'public, pg_temp', row_security: 'off' });
    });
    expect(await f.db.execute(settings)).toEqual(before);
  });
  it('installs only in public and preserves temporary and other-schema namesakes', async () => {
    await f.exec(`CREATE SCHEMA receipt_other;
      CREATE TABLE receipt_other.admin_refund_creation(marker integer);
      INSERT INTO receipt_other.admin_refund_creation VALUES(17);
      CREATE TEMP TABLE admin_refund_creation(marker integer);
      INSERT INTO pg_temp.admin_refund_creation VALUES(23)`);
    const before = await f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class
      WHERE relname='admin_refund_creation' ORDER BY oid`);
    await runAdminRefundCreation(f.db);
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ complete: true });
    expect(await f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class
      WHERE relname='admin_refund_creation' AND relnamespace<>'public'::regnamespace ORDER BY oid`)).toEqual(before);
    expect(await f.exec('SELECT * FROM receipt_other.admin_refund_creation')).toEqual([{ marker: 17 }]);
    expect(await f.exec('SELECT * FROM pg_temp.admin_refund_creation')).toEqual([{ marker: 23 }]);
  });
  it('rolls back partial DDL when a canonical index name belongs to another relation', async () => {
    await f.exec('CREATE TABLE public.receipt_unrelated(id integer PRIMARY KEY); INSERT INTO public.receipt_unrelated VALUES(1); ALTER INDEX public.receipt_unrelated_pkey RENAME TO arc_pk');
    const before = await f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class WHERE relname IN ('receipt_unrelated','arc_pk') ORDER BY oid`);
    await expect(runAdminRefundCreation(f.db)).rejects.toThrow();
    expect(await inspectAdminRefundCreation(f.db)).toMatchObject({ present: false });
    expect(await f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class WHERE relname IN ('receipt_unrelated','arc_pk') ORDER BY oid`)).toEqual(before);
    expect(await f.exec('SELECT * FROM public.receipt_unrelated')).toEqual([{ id: 1 }]);
  });
  it.each([
    {refundId:null,outcome:'created'}, {refundId:0,outcome:'created'},
    {refundId:-1,outcome:'created'}, {refundId:1,outcome:'abandoned'},
    {refundId:1,outcome:'settled'}, {refundId:null,outcome:'unknown'},
  ])('rejects invalid creation evidence without consuming the key: $outcome/$refundId', async ({refundId,outcome}) => {
    await runAdminRefundCreation(f.db);
    const requestKey=crypto.randomUUID();
    await expect(f.db.execute(sql`INSERT INTO public.admin_refund_creation
      (admin_id,request_key,request_hash,order_id,refund_id,outcome)
      VALUES(27,${requestKey}::uuid,${'a'.repeat(64)},100,${refundId},${outcome})`)).rejects.toThrow();
    expect(await f.db.select().from(adminRefundCreation)).toHaveLength(0);
    await f.db.execute(sql`INSERT INTO public.admin_refund_creation
      (admin_id,request_key,request_hash,order_id,refund_id,outcome)
      VALUES(27,${requestKey}::uuid,${'a'.repeat(64)},100,NULL,'abandoned')`);
    expect(await f.db.select().from(adminRefundCreation)).toHaveLength(1);
  });

});
