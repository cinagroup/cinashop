import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { auditReleasePrerequisiteCatalog } from '../src/migrations/auditReleasePrerequisiteCatalog';
import { runBrokeragePaidOrderFence } from '../src/migrations/runBrokeragePaidOrderFence';
import { runCouponProductScopeFence } from '../src/migrations/runCouponProductScopeFence';
import * as models from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('fixed release catalog on isolated PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => { f = await sequenceRunnerDatabase(); });
  afterEach(async () => { await f?.close(); });

  it('reports each missing public object without creating it, in an explicitly read-only transaction', async () => {
    const queries: string[] = [];
    f.db.$client.options.debug = (_connection, query) => { queries.push(query); };
    const result = await auditReleasePrerequisiteCatalog(f.db);
    expect(queries[0].toLowerCase()).toBe('begin isolation level repeatable read read only');
    expect(queries[1]).toContain("set_config('statement_timeout'");
    expect(queries.at(-1)?.toLowerCase()).toBe('commit');
    expect(result.serverMajor).toBe(16);
    expect(result.schemaPresent).toBe(true);
    for (const [key, count] of [['tables',9],['columns',6],['indexes',4],['constraints',2],['functions',2],['triggers',6]] as const) {
      expect(result[key]).toHaveLength(count);
      expect(result[key].every(item => item.exists === false)).toBe(true);
    }
    expect(result.reachableRoleAttributes.superuser).toBe(true);
    expect(await f.exec("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).toEqual([{ n: 0 }]);
  });

  it('distinguishes pre-withdrawal columns/indexes and the final incremental definitions, preserving rows', async () => {
    await f.exec(`CREATE TABLE user_extract(id serial PRIMARY KEY,uid integer,wechat varchar(32) NOT NULL DEFAULT '');
      CREATE TABLE capital_flow(id serial PRIMARY KEY,note text);
      CREATE TABLE order_notification_delivery(id integer PRIMARY KEY,order_id integer NOT NULL);
      CREATE TABLE store_order_outbox(id integer PRIMARY KEY,event_type text);
      CREATE TABLE system_message(id integer PRIMARY KEY,user_id integer,type integer,status integer,is_del integer);
      INSERT INTO user_extract(uid,wechat) VALUES(7,'synthetic-contact');
      INSERT INTO capital_flow(note) VALUES('synthetic-private-note');
      INSERT INTO order_notification_delivery VALUES(3,5);
      INSERT INTO store_order_outbox VALUES(4,'order.paid');`);
    const before = await auditReleasePrerequisiteCatalog(f.db);
    expect(before.columns.find(c => c.name === 'wechat')).toMatchObject({ exists:true,type:'character varying(32)' });
    expect(before.columns.find(c => c.name === 'request_key')?.exists).toBe(false);
    for (const name of ['0130_user_withdrawal_replay','0131_withdrawal_effects','0132_withdrawal_application_notice','0133_staff_notification_refresh']) {
      await f.exec(readFileSync(`migrations/${name}.sql`, 'utf8'));
    }
    const after = await auditReleasePrerequisiteCatalog(f.db);
    expect(after.columns.every(c => c.exists)).toBe(true);
    expect(after.columns.find(c => c.name === 'wechat')?.type).toBe('character varying(64)');
    expect(after.columns.find(c => c.name === 'order_id')?.notNull).toBe(false);
    expect(after.indexes.every(i => i.exists && i.valid && i.ready && !i.truncated)).toBe(true);
    expect(after.constraints.every(c => c.exists && c.validated && !c.truncated)).toBe(true);
    expect(after.constraints.find(c => c.name === 'soob_event_type_ck')?.definition).toContain('withdrawal.staff.refresh');
    expect(JSON.stringify(after)).not.toContain('synthetic-contact');
    expect(JSON.stringify(after)).not.toContain('synthetic-private-note');
    expect(await f.exec('SELECT uid,wechat,request_key,request_hash FROM user_extract')).toEqual([
      { uid:7,wechat:'synthetic-contact',request_key:'',request_hash:'' },
    ]);
  });

  it('observes actual fence functions and all six exact trigger names, including disabled state', async () => {
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await runBrokeragePaidOrderFence(f.db);
    await runCouponProductScopeFence(f.db);
    const result = await auditReleasePrerequisiteCatalog(f.db);
    expect(result.functions).toHaveLength(2);
    expect(result.functions.every(p => p.exists && !p.securityDefiner && /^[a-f0-9]{32}$/.test(p.sourceHash ?? ''))).toBe(true);
    expect(result.triggers).toHaveLength(6);
    expect(result.triggers.every(t => t.exists && t.enabled === 'O' && !t.truncated)).toBe(true);
    await f.exec('ALTER TABLE store_coupon_product DISABLE TRIGGER coupon_product_update_0151');
    expect((await auditReleasePrerequisiteCatalog(f.db)).triggers.find(t => t.name === 'coupon_product_update_0151')?.enabled).toBe('D');
  }, 30_000);

  it('ignores same-named objects outside public and hashes column defaults rather than exposing them', async () => {
    await f.exec(`CREATE SCHEMA misleading; CREATE TABLE misleading.user_extract(request_key text);
      CREATE TABLE public.user_extract(request_key varchar(96) DEFAULT 'synthetic-sensitive-default');`);
    const result = await auditReleasePrerequisiteCatalog(f.db);
    const column = result.columns.find(c => c.name === 'request_key');
    expect(column).toMatchObject({ exists:true,type:'character varying(96)' });
    expect(column?.defaultHash).toMatch(/^[a-f0-9]{32}$/);
    expect(result.columns.find(c => c.name === 'wechat')?.exists).toBe(false);
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-default');
  });

  it('works through a real non-owner login without business read privileges and restores transaction settings', async () => {
    if (!f.withRuntimeRole) throw new Error('Real runtime LOGIN required');
    await f.exec('CREATE TABLE user_extract(request_key varchar(96))');
    await f.withRuntimeRole(async peer => {
      const settings = "SELECT current_setting('transaction_read_only') AS ro,current_setting('statement_timeout') AS st,current_setting('lock_timeout') AS lt";
      const before = await peer.exec(settings);
      const result = await auditReleasePrerequisiteCatalog(peer.db);
      expect(result.columns.find(c => c.name === 'request_key')?.exists).toBe(true);
      expect(result.reachableRoleAttributes).toEqual({ superuser:false,createDb:false,createRole:false,replication:false,bypassRls:false });
      expect(await peer.exec(settings)).toEqual(before);
      await expect(peer.exec('SELECT * FROM user_extract')).rejects.toMatchObject({ code:'42501' });
    });
  });
});
