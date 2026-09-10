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
    for (const [key, count] of [['tables',15],['columns',11],['indexes',8],['constraints',3],['functions',2],['triggers',6]] as const) {
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
    expect(after.columns.filter(c => ['user_extract','capital_flow','order_notification_delivery'].includes(c.table))).toHaveLength(6);
    expect(after.columns.filter(c => ['user_extract','capital_flow','order_notification_delivery'].includes(c.table)).every(c => c.exists)).toBe(true);
    expect(after.columns.find(c => c.name === 'wechat')?.type).toBe('character varying(64)');
    expect(after.columns.find(c => c.name === 'order_id')?.notNull).toBe(false);
    const withdrawalIndexes = after.indexes.filter(i => ['ue_request_replay_uq','cf_event_key_uq','ond_withdrawal','smsg_staff_inbox'].includes(i.name));
    expect(withdrawalIndexes).toHaveLength(4);
    expect(withdrawalIndexes.every(i => i.exists && i.valid && i.ready && !i.truncated)).toBe(true);
    const withdrawalConstraints = after.constraints.filter(c => c.table !== 'store_cart');
    expect(withdrawalConstraints).toHaveLength(2);
    expect(withdrawalConstraints.every(c => c.exists && c.validated && !c.truncated)).toBe(true);
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
    expect(result.tables).toHaveLength(15);
    expect(result.tables.every(t => t.exists && t.kind === 'r' && !t.rls)).toBe(true);
    expect(result.columns).toHaveLength(11);
    expect(result.columns.every(c => c.exists)).toBe(true);
    expect(result.indexes).toHaveLength(8);
    expect(result.indexes.every(i => i.exists && i.valid && i.ready && !i.truncated)).toBe(true);
    expect(result.constraints).toHaveLength(3);
    expect(result.constraints.every(c => c.exists && c.validated && !c.truncated)).toBe(true);
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

  it('observes 0134 widths before and after the actual migration without exposing or altering values', async () => {
    await f.exec(`CREATE TABLE public.user(add_ip varchar(16) NOT NULL,last_ip varchar(16) NOT NULL);
      CREATE TABLE store_order(user_ip varchar(16) NOT NULL);
      CREATE TABLE store_product_category(pic varchar(128) NOT NULL);
      INSERT INTO public.user VALUES('192.0.2.1','192.0.2.2');
      INSERT INTO store_order VALUES('192.0.2.3');
      INSERT INTO store_product_category VALUES('synthetic-private-image-path');`);
    const rows = () => f.exec(`SELECT jsonb_build_object('user',(SELECT jsonb_agg(u) FROM public.user u),
      'order',(SELECT jsonb_agg(o) FROM store_order o),'category',(SELECT jsonb_agg(c) FROM store_product_category c)) AS value`);
    const beforeRows = await rows();
    const before = await auditReleasePrerequisiteCatalog(f.db);
    const widths = (catalog: typeof before) => catalog.columns.filter(c => ['add_ip','last_ip','user_ip','pic'].includes(c.name));
    expect(widths(before).map(c => [c.name,c.type])).toEqual([
      ['user_ip','character varying(16)'],['pic','character varying(128)'],
      ['add_ip','character varying(16)'],['last_ip','character varying(16)'],
    ]);
    await f.exec(readFileSync('migrations/0134_repository_column_width_alignment.sql','utf8'));
    const after = await auditReleasePrerequisiteCatalog(f.db);
    expect(widths(after).map(c => [c.name,c.type,c.notNull])).toEqual([
      ['user_ip','character varying(45)',true],['pic','character varying(512)',true],
      ['add_ip','character varying(45)',true],['last_ip','character varying(45)',true],
    ]);
    expect(await rows()).toEqual(beforeRows);
    expect(JSON.stringify(after)).not.toContain('192.0.2.1');
    expect(JSON.stringify(after)).not.toContain('synthetic-private-image-path');
  });

  it('observes actual 0146-0149 incremental definitions, including missing and drifted objects', async () => {
    await f.exec(`CREATE TABLE store_order_refund(id integer NOT NULL,add_time integer NOT NULL,
      is_cancel smallint NOT NULL,is_del smallint NOT NULL,apply_type smallint NOT NULL,refund_type smallint NOT NULL,
      refund_reason varchar(255) NOT NULL,refund_explain varchar(255) NOT NULL,order_id varchar(50) NOT NULL);
      CREATE TABLE payment_reconciliation_case(callback_event_id bigint);
      CREATE TABLE store_product_reply(order_cart_info_id integer);
      CREATE TABLE work_contact_action_outbox(corp_id varchar(18) NOT NULL,client_id integer NOT NULL);
      CREATE TABLE store_cart(id integer PRIMARY KEY,type smallint NOT NULL);
      INSERT INTO store_cart VALUES(17,0),(18,2);`);
    const names = ['sor_pink_recovery_scan','prc_callback_event','spr_order_cart_info','wcao_client_ref'];
    const before = await auditReleasePrerequisiteCatalog(f.db);
    expect(before.indexes.filter(i => names.includes(i.name))).toHaveLength(4);
    expect(before.indexes.filter(i => names.includes(i.name)).every(i => !i.exists)).toBe(true);
    expect(before.columns.find(c => c.name === 'bargain_user_id')?.exists).toBe(false);
    expect(before.constraints.find(c => c.name === 'sc_bargain_participation_ck')?.exists).toBe(false);
    for (const name of ['0146_pink_recovery_index','0147_foreign_key_child_indexes',
      '0148_work_contact_client_index','0149_bargain_cart_participation']) {
      await f.exec(readFileSync(`migrations/${name}.sql`,'utf8'));
    }
    const after = await auditReleasePrerequisiteCatalog(f.db);
    const indexes = after.indexes.filter(i => names.includes(i.name));
    expect(indexes.every(i => i.exists && i.valid && i.ready && !i.unique && !i.truncated)).toBe(true);
    expect(indexes.find(i => i.name === 'prc_callback_event')?.definition).toContain('USING btree (callback_event_id)');
    expect(indexes.find(i => i.name === 'spr_order_cart_info')?.definition).toContain('USING btree (order_cart_info_id)');
    expect(indexes.find(i => i.name === 'wcao_client_ref')?.definition).toContain('USING btree (corp_id, client_id)');
    expect(indexes.find(i => i.name === 'sor_pink_recovery_scan')?.definition).toContain('pink_cancel_');
    expect(after.columns.find(c => c.name === 'bargain_user_id')).toMatchObject({ exists:true,type:'integer',notNull:true,defaultHash:'cfcd208495d565ef66e7dff9f98764da' });
    expect(after.constraints.find(c => c.name === 'sc_bargain_participation_ck')).toMatchObject({ exists:true,validated:true,truncated:false });
    expect(await f.exec('SELECT * FROM store_cart ORDER BY id')).toEqual([
      { id:17,type:0,bargain_user_id:0 },{ id:18,type:2,bargain_user_id:0 },
    ]);
    await f.exec(`DROP INDEX wcao_client_ref;
      CREATE INDEX wcao_client_ref ON work_contact_action_outbox(client_id);
      ALTER TABLE store_cart DROP CONSTRAINT sc_bargain_participation_ck;
      ALTER TABLE store_cart ADD CONSTRAINT sc_bargain_participation_ck CHECK(bargain_user_id>=0) NOT VALID;`);
    const drifted = await auditReleasePrerequisiteCatalog(f.db);
    expect(drifted.indexes.find(i => i.name === 'wcao_client_ref')?.definition).toContain('USING btree (client_id)');
    expect(drifted.constraints.find(c => c.name === 'sc_bargain_participation_ck')?.validated).toBe(false);
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
