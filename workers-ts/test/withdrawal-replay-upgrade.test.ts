import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { inspectWithdrawalReplayUpgrade, runWithdrawalReplayUpgrade } from '../src/migrations/runWithdrawalReplayUpgrade';
import { auditReleasePrerequisiteCatalog } from '../src/migrations/auditReleasePrerequisiteCatalog';
import * as models from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('DB-006 bounded additive production upgrade', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    await f.exec(`CREATE TABLE user_extract(id serial PRIMARY KEY,uid integer NOT NULL DEFAULT 0,
      wechat varchar(15) NOT NULL DEFAULT '',extract_price numeric(12,2),mark text);
      INSERT INTO user_extract(uid,wechat,extract_price,mark) VALUES(5,'old-contact',12.34,'private-note');`);
  });
  afterEach(async () => { await f?.close(); });
  const rows = () => {
    if (f.format !== 'pg16') throw new Error('Real PostgreSQL fixture required');
    return f.exec('SELECT to_jsonb(u) AS value FROM user_extract u ORDER BY id');
  };

  it('matches external0130, preserves every business value, and has a DDL-free idempotent second run', async () => {
    const initial = await inspectWithdrawalReplayUpgrade(f.db);
    expect(initial).toMatchObject({ supported:true,ready:false,withinBudget:true,catalog:{ wechatWidth:15 } });
    const result = await runWithdrawalReplayUpgrade(f.db);
    expect(result).toMatchObject({ applied:true,ready:true,before:{ rows:1 },after:{ rows:1 } });
    expect(result.before).toEqual(result.after);
    expect(result.before).toEqual(initial.fingerprint);
    expect(await inspectWithdrawalReplayUpgrade(f.db)).toMatchObject({ supported:true,ready:true,fingerprint:result.after });
    expect(result.before.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('private-note');
    const catalog = await auditReleasePrerequisiteCatalog(f.db);
    const queries: string[] = [];
    f.db.$client.options.debug = (_connection, query) => { queries.push(query); };
    const again = await runWithdrawalReplayUpgrade(f.db);
    expect(again).toMatchObject({ applied:false,ready:true,before:result.after,after:result.after });
    expect(queries.some(query => /^\s*(ALTER|CREATE|DROP)/i.test(query))).toBe(false);
    await f.exec(readFileSync('migrations/0130_user_withdrawal_replay.sql','utf8'));
    expect(await auditReleasePrerequisiteCatalog(f.db)).toEqual(catalog);
    expect((await rows())[0].value).toMatchObject({ uid:5,wechat:'old-contact',extract_price:12.34,mark:'private-note',request_key:'',request_hash:'' });
  });

  it('enforces non-empty per-user replay uniqueness while allowing empty legacy keys and other users', async () => {
    await runWithdrawalReplayUpgrade(f.db);
    await f.exec("INSERT INTO user_extract(uid,request_key) VALUES(5,''),(5,'intent'),(6,'intent')");
    await expect(f.exec("INSERT INTO user_extract(uid,request_key) VALUES(5,'intent')")).rejects.toMatchObject({ code:'23505' });
  });

  it('rolls back the width change when a late unique-index build fails', async () => {
    await f.exec(`ALTER TABLE user_extract ADD request_key varchar(96) DEFAULT '' NOT NULL,ADD request_hash varchar(64) DEFAULT '' NOT NULL;
      UPDATE user_extract SET request_key='conflict'; INSERT INTO user_extract(uid,request_key) VALUES(5,'conflict');`);
    const before = await rows();
    await expect(runWithdrawalReplayUpgrade(f.db)).rejects.toMatchObject({ code:'23505' });
    expect(await rows()).toEqual(before);
    const catalog = await auditReleasePrerequisiteCatalog(f.db);
    expect(catalog.columns.find(c => c.name === 'wechat')?.type).toBe('character varying(15)');
    expect(catalog.indexes.find(i => i.name === 'ue_request_replay_uq')?.exists).toBe(false);
  });

  it.each([
    "ALTER TABLE user_extract ADD request_key text NOT NULL DEFAULT ''",
    "ALTER TABLE user_extract ADD request_hash varchar(64)",
    "ALTER TABLE user_extract ALTER wechat TYPE varchar(128)",
    'CREATE INDEX ue_request_replay_uq ON user_extract(uid)',
    'ALTER TABLE user_extract ENABLE ROW LEVEL SECURITY',
  ])('refuses incompatible catalog without silently repairing: %s', async ddl => {
    await f.exec(ddl);
    const before = await rows();
    await expect(runWithdrawalReplayUpgrade(f.db)).rejects.toThrow('prerequisite drift');
    expect(await rows()).toEqual(before);
  });

  it('refuses a live competing lock immediately and changes nothing', async () => {
    if (!f.withPeer) throw new Error('Independent PostgreSQL backend required');
    const before = await rows();
    await f.withPeer(async peer => {
      await peer.exec('BEGIN');
      try {
        await peer.exec('LOCK TABLE user_extract IN ROW EXCLUSIVE MODE');
        await expect(runWithdrawalReplayUpgrade(f.db)).rejects.toMatchObject({ code:'55P03' });
      } finally { await peer.exec('ROLLBACK'); }
    });
    expect(await rows()).toEqual(before);
  });

  it('refuses a larger target instead of taking an unbounded maintenance scan', async () => {
    await f.exec('INSERT INTO user_extract(uid) SELECT n FROM generate_series(1,10000) n');
    await expect(runWithdrawalReplayUpgrade(f.db)).rejects.toThrow('row budget exceeded');
    expect((await auditReleasePrerequisiteCatalog(f.db)).columns.find(c => c.name === 'request_key')?.exists).toBe(false);
  });

  it('accepts the complete ORM target as an unchanged no-op', async () => {
    await f.exec('DROP TABLE user_extract');
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
    expect(await runWithdrawalReplayUpgrade(f.db)).toMatchObject({ applied:false,ready:true,before:{ rows:0 },after:{ rows:0 } });
  }, 30_000);

  it('refuses enabled event triggers before executing any DDL', async () => {
    await f.exec(`CREATE FUNCTION public.observe_ddl() RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN RETURN; END';
      CREATE EVENT TRIGGER observe_ddl ON ddl_command_start EXECUTE FUNCTION public.observe_ddl();`);
    expect(await inspectWithdrawalReplayUpgrade(f.db)).toMatchObject({ supported:false,catalog:{ noEventTriggers:false },fingerprint:null });
    await expect(runWithdrawalReplayUpgrade(f.db)).rejects.toThrow('prerequisite drift');
  });

  it('keeps generated maintenance bindings identical for both entrypoints', () => {
    const read = JSON.parse(readFileSync('test/integration/paid-runtime-audit.wrangler.jsonc','utf8'));
    const write = JSON.parse(readFileSync('test/integration/withdrawal-replay-migrate.wrangler.jsonc','utf8'));
    expect(write.vars).toEqual(read.vars);
    expect(write.hyperdrive).toEqual(read.hyperdrive);
    expect(write.compatibility_flags).toEqual(read.compatibility_flags);
  });
});
