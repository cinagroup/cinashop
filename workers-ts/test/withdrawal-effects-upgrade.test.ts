import { readFileSync } from 'node:fs';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { inspectWithdrawalEffectsUpgrade,runWithdrawalEffectsUpgrade } from '../src/migrations/runWithdrawalEffectsUpgrade';
import { runWithdrawalReplayUpgrade } from '../src/migrations/runWithdrawalReplayUpgrade';
import * as models from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('DB-007 bounded production increment',()=>{
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  const exec = (sql: string) => {
    if (f.format!=='pg16') throw new Error('Real PostgreSQL16 required');
    return f.exec(sql);
  };
  const migration = (name: string) => exec(readFileSync(`migrations/${name}.sql`,'utf8'));
  beforeEach(async()=>{
    f=await sequenceRunnerDatabase();
    await exec(`CREATE TABLE user_extract(id serial PRIMARY KEY,uid integer NOT NULL,wechat varchar(15) NOT NULL DEFAULT '');
      CREATE TABLE capital_flow(id serial PRIMARY KEY, amount numeric(12,2), note text);
      CREATE TABLE order_notification_delivery(id serial PRIMARY KEY,order_id integer NOT NULL,note text);
      CREATE TABLE store_order_outbox(id serial PRIMARY KEY,event_type varchar(64) NOT NULL,payload jsonb,
        CONSTRAINT soob_event_type_ck CHECK(event_type IN ('order.paid','order.delivery.notice','order.refund.refused.notice','order.second_card.advent.notice','order.second_card.expired.notice')));
      CREATE TABLE system_message(id serial PRIMARY KEY,user_id integer,type smallint,status smallint,is_del smallint,content text);
      INSERT INTO capital_flow(amount,note) VALUES(12.34,'private-capital');
      INSERT INTO order_notification_delivery(order_id,note) VALUES(17,'private-delivery');
      INSERT INTO store_order_outbox(event_type,payload) VALUES('order.paid','{"private":"payload"}');
      INSERT INTO system_message(user_id,type,status,is_del,content) VALUES(2,1,1,0,'private-content');`);
    await runWithdrawalReplayUpgrade(f.db);
  });
  afterEach(async()=>{ await f?.close(); });

  it('matches external0131–0133, preserves all four tables, independently verifies and repeats without DDL',async()=>{
    const before=await inspectWithdrawalEffectsUpgrade(f.db);
    expect(before).toMatchObject({ supported:true,ready:false,withinBudget:true });
    const result=await runWithdrawalEffectsUpgrade(f.db);
    expect(result).toMatchObject({ applied:true,ready:true,before:{ rows:4 } });
    expect(result.before).toEqual(before.fingerprint);
    expect(result.after).toEqual(result.before);
    expect(result.after.tables).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain('private');
    const after=await inspectWithdrawalEffectsUpgrade(f.db);
    expect(after).toMatchObject({ supported:true,ready:true,fingerprint:result.after });
    const queries: string[]=[];
    f.db.$client.options.debug=(_c,q)=>{ queries.push(q); };
    expect(await runWithdrawalEffectsUpgrade(f.db)).toMatchObject({ applied:false,ready:true,before:result.after,after:result.after });
    expect(queries.some(q=>/^\s*(ALTER|CREATE|DROP)/i.test(q))).toBe(false);
    for (const name of ['0131_withdrawal_effects','0132_withdrawal_application_notice','0133_staff_notification_refresh']) await migration(name);
    expect(await inspectWithdrawalEffectsUpgrade(f.db)).toEqual(after);
    expect((await exec('SELECT event_key FROM capital_flow'))[0].event_key).toBeNull();
    expect((await exec('SELECT order_id,withdrawal_id FROM order_notification_delivery'))[0]).toEqual({ order_id:17,withdrawal_id:null });
  });

  it('enforces unique non-null event keys and mutually exclusive delivery subjects',async()=>{
    await runWithdrawalEffectsUpgrade(f.db);
    await exec("INSERT INTO capital_flow(event_key) VALUES(NULL),(NULL),('intent')");
    await expect(exec("INSERT INTO capital_flow(event_key) VALUES('intent')")).rejects.toMatchObject({ code:'23505' });
    await exec('INSERT INTO order_notification_delivery(order_id,withdrawal_id) VALUES(NULL,42),(18,NULL)');
    for (const values of ['NULL,NULL','18,42','NULL,0','NULL,-1']) {
      await expect(exec(`INSERT INTO order_notification_delivery(order_id,withdrawal_id) VALUES(${values})`)).rejects.toMatchObject({ code:'23514' });
    }
    await exec("INSERT INTO store_order_outbox(event_type) VALUES('withdrawal.staff.refresh'),('withdrawal.applied.notice'),('withdrawal.approved.notice'),('withdrawal.refused.notice')");
    await expect(exec("INSERT INTO store_order_outbox(event_type) VALUES('unknown')")).rejects.toMatchObject({ code:'23514' });
  });

  it.each(['0131','0132'])('upgrades a validated %s intermediate without losing new data',async version=>{
    await migration('0131_withdrawal_effects');
    if (version==='0132') await migration('0132_withdrawal_application_notice');
    await exec("INSERT INTO capital_flow(event_key) VALUES('already-used'); INSERT INTO order_notification_delivery(withdrawal_id) VALUES(73)");
    const before=await inspectWithdrawalEffectsUpgrade(f.db);
    const result=await runWithdrawalEffectsUpgrade(f.db);
    expect(result.before).toEqual(before.fingerprint);
    expect(result.after).toEqual(result.before);
    expect(result.applied).toBe(true);
  });

  it('never installs a narrower CHECK over an already-final outbox containing staff refresh',async()=>{
    await runWithdrawalEffectsUpgrade(f.db);
    await exec("INSERT INTO store_order_outbox(event_type) VALUES('withdrawal.staff.refresh'); DROP INDEX cf_event_key_uq");
    const before=await inspectWithdrawalEffectsUpgrade(f.db);
    const queries: string[]=[];
    f.db.$client.options.debug=(_c,q)=>{ queries.push(q); };
    expect(await runWithdrawalEffectsUpgrade(f.db)).toMatchObject({ applied:true,before:before.fingerprint,after:before.fingerprint });
    expect(queries.some(q=>/DROP CONSTRAINT/i.test(q))).toBe(false);
  });

  it('rolls back all earlier column and CHECK changes if the late unique index fails',async()=>{
    await exec("ALTER TABLE capital_flow ADD event_key varchar(128); UPDATE capital_flow SET event_key='duplicate'; INSERT INTO capital_flow(event_key) VALUES('duplicate')");
    const before=await inspectWithdrawalEffectsUpgrade(f.db);
    await expect(runWithdrawalEffectsUpgrade(f.db)).rejects.toMatchObject({ code:'23505' });
    expect(await inspectWithdrawalEffectsUpgrade(f.db)).toEqual(before);
  });

  it.each([
    'ALTER TABLE capital_flow ADD event_key text',
    "ALTER TABLE capital_flow ADD event_key varchar(128) DEFAULT 'bad'",
    'ALTER TABLE order_notification_delivery ADD withdrawal_id bigint',
    'CREATE INDEX cf_event_key_uq ON capital_flow(id)',
    'CREATE TABLE ond_withdrawal(id integer)',
    'ALTER TABLE system_message ENABLE ROW LEVEL SECURITY',
    'CREATE TABLE inherited_flow() INHERITS(capital_flow)',
    "ALTER TABLE store_order_outbox DROP CONSTRAINT soob_event_type_ck; ALTER TABLE store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type<>'bad')",
    'ALTER TABLE order_notification_delivery ADD CONSTRAINT ond_subject_ck CHECK(order_id>0)',
  ])('refuses catalog drift before DDL: %s',async ddl=>{
    await exec(ddl);
    const before=await inspectWithdrawalEffectsUpgrade(f.db);
    expect(before.supported).toBe(false);
    expect(before.fingerprint).toBeNull();
    await expect(runWithdrawalEffectsUpgrade(f.db)).rejects.toThrow('prerequisite drift');
    expect(await inspectWithdrawalEffectsUpgrade(f.db)).toEqual(before);
  });

  it.each(['capital_flow','order_notification_delivery','store_order_outbox','system_message'])('fails immediately on a live %s lock',async table=>{
    if (!f.withPeer) throw new Error('Independent PostgreSQL backend required');
    const before=await inspectWithdrawalEffectsUpgrade(f.db);
    await f.withPeer(async peer=>{
      await peer.exec('BEGIN');
      try {
        await peer.exec(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
        await expect(runWithdrawalEffectsUpgrade(f.db)).rejects.toMatchObject({ code:'55P03' });
        // Any locks acquired on earlier tables must have been rolled back too.
        await peer.exec('LOCK TABLE capital_flow,order_notification_delivery,store_order_outbox,system_message IN ACCESS EXCLUSIVE MODE NOWAIT');
      } finally { await peer.exec('ROLLBACK'); }
    });
    expect(await inspectWithdrawalEffectsUpgrade(f.db)).toEqual(before);
  });

  it('requires completed DB-006, without running that migration implicitly',async()=>{
    await exec('ALTER TABLE user_extract DROP request_hash');
    await expect(runWithdrawalEffectsUpgrade(f.db)).rejects.toThrow('DB-006 must be complete');
  });
  it('rejects enabled event triggers at the earlier DB-006 guard, without any DDL',async()=>{
    await exec("CREATE FUNCTION public.observe_ddl() RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN RETURN; END'; CREATE EVENT TRIGGER observe_ddl ON ddl_command_start EXECUTE FUNCTION public.observe_ddl()");
    const queries: string[]=[];
    f.db.$client.options.debug=(_c,q)=>{ queries.push(q); };
    await expect(inspectWithdrawalEffectsUpgrade(f.db)).rejects.toThrow('DB-006 must be complete');
    await expect(runWithdrawalEffectsUpgrade(f.db)).rejects.toThrow('DB-006 must be complete');
    expect(queries.some(q=>/^\s*(ALTER|CREATE|DROP|LOCK)/i.test(q))).toBe(false);
    expect((await exec("SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='capital_flow' AND column_name='event_key'"))[0].n).toBe(0);
  });
  it('refuses over-budget tables before a fingerprint or any DDL',async()=>{
    await exec('INSERT INTO capital_flow(amount) SELECT n FROM generate_series(1,10000) n');
    expect(await inspectWithdrawalEffectsUpgrade(f.db)).toMatchObject({ supported:true,withinBudget:false,fingerprint:null });
    await expect(runWithdrawalEffectsUpgrade(f.db)).rejects.toThrow('row budget exceeded');
    expect((await inspectWithdrawalEffectsUpgrade(f.db)).catalog.keyPresent).toBe(false);
  });
  it('accepts the actual complete ORM as a DDL-free no-op',async()=>{
    await exec('DROP TABLE user_extract,capital_flow,order_notification_delivery,store_order_outbox,system_message');
    const api=await import('drizzle-kit/api');
    await exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
    expect(await runWithdrawalEffectsUpgrade(f.db)).toMatchObject({ applied:false,ready:true,before:{ rows:0 },after:{ rows:0 } });
  },30_000);
  it('keeps shared generated bindings and the fixed production scope explicit',()=>{
    const read=JSON.parse(readFileSync('test/integration/paid-runtime-audit.wrangler.jsonc','utf8'));
    const write=JSON.parse(readFileSync('test/integration/withdrawal-effects-migrate.wrangler.jsonc','utf8'));
    expect(write.vars).toEqual(read.vars); expect(write.hyperdrive).toEqual(read.hyperdrive);
    expect(write.compatibility_flags).toEqual(read.compatibility_flags);
    const runner=readFileSync('scripts/run-withdrawal-effects-production-migration.ps1','utf8');
    expect(runner).toContain("if (-not $Apply)");
    expect(runner).toContain('readinessAttempts -lt 8');
    expect(runner).toContain('0131-0133-withdrawal-effects');
  });
});
