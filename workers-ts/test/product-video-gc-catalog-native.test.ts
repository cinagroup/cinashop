import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { PRODUCT_VIDEO_GC_ATTACHMENT_INDEX_SQL, assertProductVideoGcAttachmentIndexReady,
  installProductVideoGcAttachmentIndex } from '@/migrations/productVideoGcAttachmentIndex';
import { PRODUCT_VIDEO_GC_SQL, PRODUCT_VIDEO_GC_CONSTRAINTS_SHA256,
  inspectProductVideoGc, assertProductVideoGcReady, installProductVideoGc } from '@/migrations/productVideoGc';
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof financePostgres>>;
const table = 'public.product_video_gc_state_v1', guard = 'public.product_video_gc_guard_v1()';
const low = '10000000-0000-4000-8000-000000000001', middle = '20000000-0000-4000-8000-000000000001';
const maximum = 'f0000000-0000-4000-8000-000000000001';
const seed = ['admin', 'supplier'].map(scope => ({ scope, cursor: null, maximum: null, cycle: 0,
  lease_token: null, lease_until: 0, last_completed_at: 0, updated_at: 0 }));
const snapshot = (f: Fixture) => f.db.execute(sql`SELECT scope,cursor::text,maximum::text,cycle,lease_token::text,
  lease_until,last_completed_at,updated_at FROM public.product_video_gc_state_v1 ORDER BY scope`);
async function isolated<T>(run: (f: Fixture) => Promise<T>, install = true): Promise<T> {
  const f = await financePostgres([], { namespace: 'public' });
  try { if (install) await f.db.transaction(tx => installProductVideoGc(tx)); return await run(f); }
  finally { await f.close(); }
}
async function claim(f: Fixture, scope = 'admin', seconds = 120, token = crypto.randomUUID()) {
  const [row] = await f.db.execute(sql`UPDATE public.product_video_gc_state_v1 SET lease_token=${token}::uuid,
    lease_until=floor(extract(epoch FROM clock_timestamp()))::integer+${seconds},
    updated_at=floor(extract(epoch FROM clock_timestamp()))::integer WHERE scope=${scope}
    RETURNING lease_token::text,lease_until,updated_at`);
  return row;
}
const release = (f: Fixture) => f.exec(`UPDATE ${table} SET lease_token=NULL,lease_until=0 WHERE scope='admin'`);
const bind = (f: Fixture) => f.exec(`UPDATE ${table} SET maximum='${maximum}' WHERE scope='admin'`);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent two-scope product video GC catalog on genuine PG16', () => {
  let f: Fixture;
  beforeAll(async () => { f = await financePostgres([], { namespace: 'public' }); }, 30000);
  afterAll(async () => { await f?.close(); });

  it('pins the actual PG16 constraints, eight columns, fixed scopes and independent SQL mirror', async () => {
    expect(readFileSync(resolve(import.meta.dirname, '../src/migrations/maintenance/0187_product_video_gc.sql'), 'utf8')
      .split('\n').slice(1).join('\n')).toBe(PRODUCT_VIDEO_GC_SQL);
    await f.db.transaction(async tx => {
      await tx.execute(sql.raw(PRODUCT_VIDEO_GC_SQL));
      const catalog = await inspectProductVideoGc(tx);
      console.log('PRODUCT_VIDEO_GC_NATIVE_CATALOG', JSON.stringify(catalog));
      expect(catalog?.constraints_hash).toBe(PRODUCT_VIDEO_GC_CONSTRAINTS_SHA256);
      expect(catalog?.columns).toHaveLength(8); expect(catalog?.scopes).toBe(true);
      await assertProductVideoGcReady(tx);
    });
    expect(await snapshot(f)).toEqual(seed);
    expect(await f.db.transaction(tx => installProductVideoGc(tx))).toEqual({ applied: false });
    expect(readFileSync(resolve(import.meta.dirname, '../src/services/MigrationService.ts'), 'utf8')).not.toContain('product_video_gc_state_v1');
  });

  it('seeds exactly two fixed rows before enabling guards and preserves existing rows on supported owner maintenance rerun', async () => {
    await isolated(async fresh => {
      await fresh.exec("CREATE TABLE public.existing_gc_probe (id integer PRIMARY KEY,value text NOT NULL); INSERT INTO public.existing_gc_probe VALUES(1,'untouched')");
      const original = () => fresh.db.execute(sql`SELECT c.oid::text,c.relacl::text AS acl,
        (SELECT jsonb_agg(p) FROM public.existing_gc_probe p) AS rows FROM pg_class c WHERE c.oid='public.existing_gc_probe'::regclass`);
      const before = await original();
      expect(await fresh.db.transaction(tx => installProductVideoGc(tx))).toEqual({ applied: true });
      expect(await snapshot(fresh)).toEqual(seed);
      await claim(fresh); await bind(fresh); await release(fresh); const changed = await snapshot(fresh);
      expect(await fresh.db.transaction(tx => installProductVideoGc(tx))).toEqual({ applied: false });
      expect(await snapshot(fresh)).toEqual(changed); expect(await original()).toEqual(before);
    }, false);
  }, 30000);

  it('rejects unsupported maintenance entry contexts before creating any catalog', async () => {
    await isolated(async fresh => {
      await expect(installProductVideoGc(fresh.db)).rejects.toThrow('transaction');
      await expect(fresh.db.transaction(tx => installProductVideoGc(tx, 'unsafe-role'))).rejects.toThrow('identity');
      await expect(fresh.db.transaction(tx => installProductVideoGc(tx), { isolationLevel: 'repeatable read' })).rejects.toThrow('PG16');
      await expect(fresh.db.transaction(tx => installProductVideoGc(tx), { accessMode: 'read only' })).rejects.toThrow('PG16');
      await expect(fresh.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`); await installProductVideoGc(tx);
      })).rejects.toThrow('PG16');
      await expect(fresh.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL search_path=pg_catalog`); await installProductVideoGc(tx);
      })).rejects.toThrow('PG16');
      const objects = await fresh.db.execute(sql`SELECT to_regclass('public.product_video_gc_state_v1') IS NULL AS absent,
        to_regprocedure('public.product_video_gc_guard_v1()') IS NULL AS no_function`);
      expect(objects[0]).toEqual({ absent: true, no_function: true });
    }, false);
  }, 30000);

  it('refuses either partial catalog without repairing or replacing its objects', async () => {
    for (const definition of [
      `CREATE TABLE ${table} (scope varchar(16))`,
      `CREATE FUNCTION ${guard} RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
    ]) await isolated(async fresh => {
      await fresh.exec(definition);
      const census = () => fresh.db.execute(sql`SELECT to_regclass('public.product_video_gc_state_v1')::oid AS relation,
        to_regprocedure('public.product_video_gc_guard_v1()')::oid AS function`);
      const before = await census();
      await expect(fresh.db.transaction(tx => installProductVideoGc(tx))).rejects.toThrow('Partial');
      expect(await census()).toEqual(before);
      await expect(fresh.db.transaction(tx => assertProductVideoGcReady(tx))).rejects.toThrow('尚未就绪');
    }, false);
  }, 30000);

  it('fails closed on exact column CHECK index trigger function table and ACL drift without repairing it', async () => {
    await isolated(async fresh => {
      const baseline = await inspectProductVideoGc(fresh.db), rollback = Error('rollback owned GC catalog drift');
      for (const change of [
        `ALTER TABLE ${table} ADD COLUMN unexpected integer`,
        `ALTER TABLE ${table} ALTER COLUMN cycle SET DEFAULT 0`,
        `ALTER TABLE ${table} ALTER COLUMN cycle DROP NOT NULL`,
        `ALTER TABLE ${table} DROP CONSTRAINT pvgc_lease_ck`,
        `ALTER TABLE ${table} RENAME CONSTRAINT pvgc_numeric_ck TO unreviewed_numeric`,
        `ALTER TABLE ${table} ALTER COLUMN scope TYPE varchar(16) COLLATE "C"`,
        `CREATE INDEX unreviewed_gc_index ON ${table}(cycle)`,
        'ALTER INDEX public.pvgc_pk SET (fillfactor=70)',
        `ALTER TABLE ${table} DISABLE TRIGGER pvgc_rows`,
        `CREATE TRIGGER unreviewed_gc_trigger BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${guard}`,
        `CREATE OR REPLACE FUNCTION ${guard} RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN RETURN NEW; END'`,
        `ALTER FUNCTION ${guard} SECURITY DEFINER`,
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${table} REPLICA IDENTITY FULL`,
        `GRANT SELECT ON ${table} TO PUBLIC`,
        `GRANT UPDATE(cycle) ON ${table} TO PUBLIC`,
        `GRANT EXECUTE ON FUNCTION ${guard} TO PUBLIC`,
      ]) {
        await expect(fresh.db.transaction(async tx => {
          await tx.execute(sql.raw(change)); const drifted = await inspectProductVideoGc(tx);
          await expect(assertProductVideoGcReady(tx), change).rejects.toThrow('尚未就绪');
          await expect(installProductVideoGc(tx), change).rejects.toThrow('尚未就绪');
          expect(await inspectProductVideoGc(tx)).toEqual(drifted); throw rollback;
        })).rejects.toBe(rollback);
        expect(await inspectProductVideoGc(fresh.db)).toEqual(baseline);
      }
    });
  }, 30000);

  it('requires both fixed scope rows and never silently reseeds a damaged catalog', async () => {
    await isolated(async fresh => {
      const rollback = Error('rollback owned missing GC scope');
      await expect(fresh.db.transaction(async tx => {
        await tx.execute(sql`ALTER TABLE public.product_video_gc_state_v1 DISABLE TRIGGER pvgc_rows`);
        await tx.execute(sql`DELETE FROM public.product_video_gc_state_v1 WHERE scope='supplier'`);
        await tx.execute(sql`ALTER TABLE public.product_video_gc_state_v1 ENABLE TRIGGER pvgc_rows`);
        const [count] = await tx.execute(sql`SELECT count(*)::integer AS count FROM public.product_video_gc_state_v1`);
        expect(count?.count).toBe(1); expect((await inspectProductVideoGc(tx))?.scopes).toBe(false);
        await expect(assertProductVideoGcReady(tx)).rejects.toThrow('尚未就绪');
        await expect(installProductVideoGc(tx)).rejects.toThrow('尚未就绪');
        expect((await tx.execute(sql`SELECT count(*)::integer AS count FROM public.product_video_gc_state_v1`))[0]?.count).toBe(1);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await snapshot(fresh)).toEqual(seed);
    });
  }, 30000);

  it('allows claim bind release strict advance and finish while preserving the other scope exactly', async () => {
    await isolated(async fresh => {
      const supplier = (await snapshot(fresh))[1];
      await claim(fresh); await bind(fresh); await release(fresh);
      expect((await snapshot(fresh))[0]).toMatchObject({ cursor: null, maximum, cycle: 0, lease_token: null, lease_until: 0 });
      await claim(fresh); await fresh.exec(`UPDATE ${table} SET cursor='${low}',lease_token=NULL,lease_until=0 WHERE scope='admin'`);
      await claim(fresh); await fresh.exec(`UPDATE ${table} SET cursor='${middle}',lease_token=NULL,lease_until=0 WHERE scope='admin'`);
      await claim(fresh); await fresh.exec(`UPDATE ${table} SET cursor='${maximum}',lease_token=NULL,lease_until=0 WHERE scope='admin'`);
      await claim(fresh); await fresh.exec(`UPDATE ${table} SET cursor=NULL,maximum=NULL,cycle=cycle+1,lease_token=NULL,lease_until=0,
        last_completed_at=floor(extract(epoch FROM clock_timestamp()))::integer WHERE scope='admin'`);
      const after = await snapshot(fresh);
      expect(after[0]).toMatchObject({ cursor: null, maximum: null, cycle: 1, lease_token: null, lease_until: 0 });
      expect(Number(after[0].last_completed_at)).toBeGreaterThan(0); expect(after[1]).toEqual(supplier);
      // Empty cycles can complete without binding a nonexistent high-water UUID.
      await claim(fresh); await fresh.exec(`UPDATE ${table} SET cycle=cycle+1,lease_token=NULL,lease_until=0 WHERE scope='admin'`);
      expect((await snapshot(fresh))[0]).toMatchObject({ cycle: 2, last_completed_at: after[0].last_completed_at });
      await assertProductVideoGcReady(fresh.db);
    });
  }, 30000);

  it('uses actual database expiry for reclaim and rejects renewal same-token live takeover or excessive lease bounds', async () => {
    await isolated(async fresh => {
      await claim(fresh); const before = await snapshot(fresh);
      for (const change of [
        `lease_token='${crypto.randomUUID()}',lease_until=floor(extract(epoch FROM clock_timestamp()))::integer+120`,
        `lease_until=lease_until+1`,
        `lease_token='${crypto.randomUUID()}',lease_until=floor(extract(epoch FROM clock_timestamp()))::integer+1000`,
        `lease_token='${crypto.randomUUID()}',lease_until=floor(extract(epoch FROM clock_timestamp()))::integer`,
      ]) await expect(fresh.exec(`UPDATE ${table} SET ${change} WHERE scope='admin'`)).rejects.toMatchObject({ code: '42501' });
      expect(await snapshot(fresh)).toEqual(before);
      await release(fresh);
      const first = await claim(fresh, 'admin', 1);
      await fresh.db.execute(sql`SELECT pg_sleep(1.1)`);
      await expect(claim(fresh, 'admin', 120, String(first.lease_token))).rejects.toMatchObject({ cause: { code: '42501' } });
      const second = await claim(fresh); expect(second.lease_token).not.toBe(first.lease_token);
      await release(fresh);
      expect((await snapshot(fresh))[0]).toMatchObject({ lease_token: null, lease_until: 0 });
    });
  }, 30000);

  it('refuses every unleased header mutation and every bind advance or finish outside its exact transition', async () => {
    await isolated(async fresh => {
      const denied = async (changes: string[]) => {
        const before = await snapshot(fresh);
        for (const change of changes) {
          await expect(fresh.exec(`UPDATE ${table} SET ${change} WHERE scope='admin'`), change).rejects.toMatchObject({ code: '42501' });
          expect(await snapshot(fresh)).toEqual(before);
        }
      };
      await denied(['updated_at=1', 'cycle=1', `maximum='${maximum}'`, `cursor='${low}'`, 'last_completed_at=1',
        'lease_until=1', `scope='other'`, 'scope=scope']);
      await claim(fresh);
      await denied([`maximum='${maximum}',cursor='${low}'`, `maximum='${maximum}',lease_until=lease_until+1`,
        `maximum='${maximum}',cycle=cycle+1`, `maximum='${maximum}',last_completed_at=1`, 'updated_at=updated_at-1',
        'lease_token=NULL,lease_until=0,cycle=cycle+2,last_completed_at=1']);
      await bind(fresh);
      await denied([`maximum='${middle}'`, `cursor='${low}'`, 'maximum=NULL', 'cycle=cycle+1',
        `lease_token='${crypto.randomUUID()}',maximum='${middle}'`,
        'lease_token=NULL,lease_until=0,cycle=cycle+1',
        `lease_token=NULL,lease_until=0,cursor='ffffffff-ffff-4fff-8fff-ffffffffffff'`]);
      await fresh.exec(`UPDATE ${table} SET cursor='${middle}',lease_token=NULL,lease_until=0 WHERE scope='admin'`);
      await claim(fresh);
      await denied([`lease_token=NULL,lease_until=0,cursor='${low}'`, 'lease_token=NULL,lease_until=0,cursor=NULL',
        'lease_token=NULL,lease_until=0,cursor=NULL,maximum=NULL,cycle=cycle+2,last_completed_at=1',
        'lease_token=NULL,lease_until=0,cursor=NULL,maximum=NULL,cycle=cycle+1,last_completed_at=0',
        'lease_token=NULL,lease_until=0,cursor=NULL,maximum=NULL,cycle=cycle+1,last_completed_at=-1']);
      await release(fresh);
    });
  }, 30000);

  it('permanently rejects INSERT DELETE and TRUNCATE even for its owner and enforces native CHECK bounds', async () => {
    await isolated(async fresh => {
      const before = await snapshot(fresh);
      for (const statement of [
        `INSERT INTO ${table}(scope,cycle,lease_until,last_completed_at,updated_at) VALUES('admin',0,0,0,0)`,
        `INSERT INTO ${table}(scope,cycle,lease_until,last_completed_at,updated_at) VALUES('other',0,0,0,0)`,
        `DELETE FROM ${table} WHERE scope='admin'`, `TRUNCATE ${table}`,
      ]) await expect(fresh.exec(statement)).rejects.toMatchObject({ code: '42501' });
      expect(await snapshot(fresh)).toEqual(before);
      // Independently execute CHECKs in rolled-back owner-only drift transactions.
      // No production guard is weakened; the normal path above always keeps it enabled.
      for (const change of ['scope=\'other\'', 'cycle=-1', 'lease_until=-1', 'last_completed_at=-1', 'updated_at=-1',
        `cursor='${low}',maximum=NULL`, `cursor='${maximum}',maximum='${low}'`,
        `lease_token='${crypto.randomUUID()}',lease_until=0`, 'lease_until=1']) {
        await expect(fresh.db.transaction(async tx => {
          await tx.execute(sql`ALTER TABLE public.product_video_gc_state_v1 DISABLE TRIGGER pvgc_rows`);
          await tx.execute(sql.raw(`UPDATE ${table} SET ${change} WHERE scope='admin'`));
        })).rejects.toMatchObject({ cause: { code: '23514' } });
        expect(await snapshot(fresh)).toEqual(before); await assertProductVideoGcReady(fresh.db);
      }
    });
  }, 30000);

  it('works through an independent SELECT UPDATE-only LOGIN and rejects missing widened or grantable ACLs', async () => {
    await isolated(async fresh => {
      const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
      const [origin] = await fresh.db.execute(sql`SELECT current_database() AS database,current_schema() AS schema`);
      if (!ownsFinanceFixtureTarget(String(origin.database), String(origin.schema), base.href)) throw Error('Unowned GC runtime fixture');
      const role = 'gc_runtime_' + crypto.randomUUID().replaceAll('-', ''), password = crypto.randomUUID().replaceAll('-', '');
      await fresh.exec(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      let client: ReturnType<typeof postgres> | undefined;
      try {
        await fresh.exec(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        expect(await fresh.db.transaction(tx => installProductVideoGc(tx, role))).toEqual({ applied: true });
        const url = new URL(base); url.pathname = '/' + origin.database; url.username = role; url.password = password;
        client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5 });
        const [identity] = await client`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
          FROM pg_catalog.pg_roles WHERE rolname=current_user`;
        expect(identity).toEqual({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false });
        const runtime = drizzle(client) as unknown as DbClient;
        await runtime.transaction(tx => assertProductVideoGcReady(tx));
        await runtime.execute(sql`UPDATE public.product_video_gc_state_v1 SET lease_token=${crypto.randomUUID()}::uuid,
          lease_until=floor(extract(epoch FROM clock_timestamp()))::integer+120 WHERE scope='admin'`);
        await runtime.execute(sql`UPDATE public.product_video_gc_state_v1 SET lease_token=NULL,lease_until=0 WHERE scope='admin'`);
        for (const statement of [`INSERT INTO ${table}(scope,cycle,lease_until,last_completed_at,updated_at) VALUES('other',0,0,0,0)`,
          `DELETE FROM ${table}`, `TRUNCATE ${table}`, `SELECT ${guard}`,
          `UPDATE ${table} SET cycle=cycle+1 WHERE scope='admin'`])
          await expect(client.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
        await expect(runtime.transaction(tx => installProductVideoGc(tx))).rejects.toThrow('PG16');
        for (const privilege of ['SELECT', 'UPDATE']) {
          await fresh.exec(`REVOKE ${privilege} ON ${table} FROM "${role}"`);
          const before = await snapshot(fresh);
          await expect(runtime.transaction(tx => assertProductVideoGcReady(tx))).rejects.toThrow('尚未就绪');
          expect(await snapshot(fresh)).toEqual(before);
          await fresh.exec(`GRANT ${privilege} ON ${table} TO "${role}"`);
        }
        for (const privilege of ['INSERT', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          await fresh.exec(`GRANT ${privilege} ON ${table} TO "${role}"`);
          await expect(runtime.transaction(tx => assertProductVideoGcReady(tx))).rejects.toThrow('尚未就绪');
          await expect(fresh.db.transaction(tx => installProductVideoGc(tx, role))).rejects.toThrow('尚未就绪');
          await fresh.exec(`REVOKE ${privilege} ON ${table} FROM "${role}"`);
        }
        await fresh.exec(`GRANT UPDATE ON ${table} TO "${role}" WITH GRANT OPTION`);
        await expect(runtime.transaction(tx => assertProductVideoGcReady(tx))).rejects.toThrow('尚未就绪');
        await fresh.exec(`REVOKE GRANT OPTION FOR UPDATE ON ${table} FROM "${role}"`);
        expect(await fresh.db.transaction(tx => installProductVideoGc(tx, role))).toEqual({ applied: false });
        await runtime.transaction(tx => assertProductVideoGcReady(tx));
      } finally {
        await client?.end({ timeout: 5 });
        await fresh.exec(`REVOKE ALL ON ${table} FROM "${role}"; REVOKE ALL ON SCHEMA public FROM "${role}"; DROP ROLE "${role}"`);
      }
    }, false);
  }, 30000);
});

async function attachmentFixture<T>(run: (f: Fixture) => Promise<T>): Promise<T> {
  const f = await financePostgres([systemAttachment], { namespace: 'public' });
  try { return await run(f); } finally { await f.close(); }
}
const nameIndex = 'public.system_attachment_video_gc_name_idx';
const indexCatalog = (f: Fixture) => f.db.execute(sql`SELECT c.oid::text AS oid,c.relowner::text AS owner,
  c.reloptions,c.relkind,pg_get_indexdef(c.oid) AS definition FROM pg_class c WHERE c.oid=to_regclass('public.system_attachment_video_gc_name_idx')`);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent product video GC attachment name index on genuine PG16', () => {
  it('installs exactly one nonunique name index without rewriting duplicate names data or sequences and reruns identically', async () => {
    expect(readFileSync(resolve(import.meta.dirname, '../src/migrations/maintenance/0188_product_video_gc_attachment_index.sql'), 'utf8')
      .split('\n').slice(1).join('\n')).toBe(PRODUCT_VIDEO_GC_ATTACHMENT_INDEX_SQL);
    await attachmentFixture(async f => {
      await f.db.insert(systemAttachment).values([
        { name: 'attachments/admin/1/owned.mp4', type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: 8 },
        { name: 'attachments/admin/1/owned.mp4', type: 4, relationId: 7, moduleType: 1, fileType: 2, imageType: 8 },
      ]);
      const rows = await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId);
      const sequence = () => f.db.execute(sql`SELECT last_value,is_called FROM public.system_attachment_att_id_seq`);
      const beforeSequence = await sequence();
      await expect(assertProductVideoGcAttachmentIndexReady(f.db)).rejects.toThrow('尚未就绪');
      expect(await indexCatalog(f)).toEqual([]);
      expect(await f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx))).toEqual({ applied: true });
      await assertProductVideoGcAttachmentIndexReady(f.db);
      const catalog = await indexCatalog(f); expect(catalog).toHaveLength(1);
      expect(String(catalog[0].definition)).toBe('CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment USING btree (name)');
      expect(await f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx))).toEqual({ applied: false });
      expect(await indexCatalog(f)).toEqual(catalog);
      expect(await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId)).toEqual(rows);
      expect(await sequence()).toEqual(beforeSequence);
      expect(readFileSync(resolve(import.meta.dirname, '../src/services/MigrationService.ts'), 'utf8')).not.toContain('system_attachment_video_gc_name_idx');
    });
  }, 30000);

  it('rejects unsupported installation contexts and wrong table or operand columns without adding objects', async () => {
    await attachmentFixture(async f => {
      await expect(installProductVideoGcAttachmentIndex(f.db)).rejects.toThrow('transaction');
      await expect(f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx), { isolationLevel: 'repeatable read' })).rejects.toThrow('PG16');
      await expect(f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx), { accessMode: 'read only' })).rejects.toThrow('PG16');
      await expect(f.db.transaction(async tx => { await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await installProductVideoGcAttachmentIndex(tx); })).rejects.toThrow('PG16');
      await expect(f.db.transaction(async tx => { await tx.execute(sql`SET LOCAL search_path=pg_catalog`);
        await installProductVideoGcAttachmentIndex(tx); })).rejects.toThrow('PG16');
      const rollback = Error('rollback owned attachment operand drift');
      for (const change of [
        'ALTER TABLE public.system_attachment ALTER COLUMN name TYPE text',
        'ALTER TABLE public.system_attachment ALTER COLUMN name DROP NOT NULL',
        'ALTER TABLE public.system_attachment ALTER COLUMN name TYPE varchar(100) COLLATE "C"',
        'ALTER TABLE public.system_attachment ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE public.system_attachment RENAME TO unexpected_attachment',
      ]) {
        await expect(f.db.transaction(async tx => {
          await tx.execute(sql.raw(change));
          // Missing table/column is a real SQL refusal. Roll that statement
          // back to its savepoint before independently exercising installation.
          await expect(tx.transaction(nested => assertProductVideoGcAttachmentIndexReady(nested))).rejects.toThrow('尚未就绪');
          await expect(tx.transaction(nested => installProductVideoGcAttachmentIndex(nested))).rejects.toMatchObject({
            cause: { code: 'P0001', message: 'Product video GC attachment table or name column drift' },
          });
          expect((await tx.execute(sql`SELECT to_regclass('public.system_attachment_video_gc_name_idx') IS NULL AS absent`))[0]?.absent).toBe(true);
          throw rollback;
        })).rejects.toBe(rollback);
        expect(await indexCatalog(f)).toEqual([]);
      }
    });
  }, 30000);

  it('rejects every same-name index drift rather than adopting or repairing it', async () => {
    await attachmentFixture(async f => {
      await f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx));
      const baseline = await indexCatalog(f), rollback = Error('rollback owned name-index drift');
      for (const change of [
        `DROP INDEX ${nameIndex}; CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment(att_id)`,
        `DROP INDEX ${nameIndex}; CREATE UNIQUE INDEX system_attachment_video_gc_name_idx ON public.system_attachment(name)`,
        `DROP INDEX ${nameIndex}; CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment(name) WHERE name<>''`,
        `DROP INDEX ${nameIndex}; CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment(name) INCLUDE(att_id)`,
        `DROP INDEX ${nameIndex}; CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment(lower(name))`,
        `DROP INDEX ${nameIndex}; CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment(name DESC)`,
        `DROP INDEX ${nameIndex}; CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment(name COLLATE "C")`,
        `DROP INDEX ${nameIndex}; CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment(name text_pattern_ops)`,
        `DROP INDEX ${nameIndex}; CREATE INDEX system_attachment_video_gc_name_idx ON public.system_attachment USING hash(name)`,
        `ALTER INDEX ${nameIndex} SET(fillfactor=70)`,
        `UPDATE pg_catalog.pg_index SET indisvalid=false WHERE indexrelid='${nameIndex}'::regclass`,
        `UPDATE pg_catalog.pg_index SET indisready=false WHERE indexrelid='${nameIndex}'::regclass`,
        `UPDATE pg_catalog.pg_index SET indislive=false WHERE indexrelid='${nameIndex}'::regclass`,
        `DROP INDEX ${nameIndex}; CREATE TABLE ${nameIndex}(id integer)`,
      ]) {
        await expect(f.db.transaction(async tx => {
          await tx.execute(sql.raw(change));
          const capture = () => tx.execute(sql`SELECT c.oid::text,c.relkind,c.reloptions,x.indisvalid,x.indisready,x.indislive
            FROM pg_class c LEFT JOIN pg_index x ON x.indexrelid=c.oid WHERE c.oid=to_regclass('public.system_attachment_video_gc_name_idx')`);
          const drifted = await capture();
          await expect(assertProductVideoGcAttachmentIndexReady(tx), change).rejects.toThrow('尚未就绪');
          await expect(tx.transaction(nested => installProductVideoGcAttachmentIndex(nested)), change).rejects.toThrow(/index drift/);
          expect(await capture()).toEqual(drifted); throw rollback;
        })).rejects.toBe(rollback);
        expect(await indexCatalog(f)).toEqual(baseline);
      }
    });
  }, 30000);

  it('refuses more than100k existing rows before building and accepts exactly100k without changing them', async () => {
    await attachmentFixture(async f => {
      await f.db.execute(sql`INSERT INTO public.system_attachment(name) SELECT 'owned-'||n FROM generate_series(1,100001) n`);
      const census = () => f.db.execute(sql`SELECT count(*)::integer AS count,sum(att_id)::text AS ids,
        sum(length(name))::text AS names FROM public.system_attachment`);
      const before = await census();
      await expect(f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx))).rejects.toThrow('row budget');
      expect(await indexCatalog(f)).toEqual([]); expect(await census()).toEqual(before);
      await f.db.execute(sql`DELETE FROM public.system_attachment WHERE att_id=100001`);
      const bounded = await census(); expect(bounded[0]?.count).toBe(100000);
      expect(await f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx))).toEqual({ applied: true });
      expect(await census()).toEqual(bounded); await assertProductVideoGcAttachmentIndexReady(f.db);
    });
  }, 30000);

  it('pins the name equality lookup to an executed native plan after the formal index install', async () => {
    await attachmentFixture(async f => {
      await f.db.execute(sql`INSERT INTO public.system_attachment(name) SELECT 'attachments/owned/'||n||'.mp4' FROM generate_series(1,10000) n`);
      await f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx)); await f.exec('ANALYZE public.system_attachment');
      const result = await f.db.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT att_id FROM public.system_attachment
        WHERE name='attachments/owned/9999.mp4' LIMIT 1`);
      const plan = result[0]?.['QUERY PLAN']; expect(Array.isArray(plan)).toBe(true);
      type Plan = { 'Index Name'?: string; Plans?: Plan[] };
      const indexes = (p: Plan): string[] => [...(p['Index Name'] ? [p['Index Name']!] : []), ...(p.Plans??[]).flatMap(indexes)];
      expect(indexes((plan as Array<{Plan: Plan}>)[0].Plan)).toContain('system_attachment_video_gc_name_idx');
      expect((await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.system_attachment`))[0]?.count).toBe(10000);
    });
  }, 30000);

  it('preserves stricter local deadlines and refuses a real competing attachment writer before index creation', async () => {
    await attachmentFixture(async f => {
      const before = await f.db.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`);
      await f.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='250ms'`);
        await installProductVideoGcAttachmentIndex(tx);
        expect((await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`))[0])
          .toEqual({ statement: '2s', lock: '250ms' });
      });
      expect(await f.db.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`)).toEqual(before);
      await f.exec(`DROP INDEX ${nameIndex}`);
      await withFinancePeers(f.db, async ([writer, maintenance]) => {
        await writer.exec('BEGIN; LOCK TABLE ONLY public.system_attachment IN ROW EXCLUSIVE MODE');
        try {
          await expect(maintenance.db.transaction(tx => installProductVideoGcAttachmentIndex(tx))).rejects.toMatchObject({ cause: { code: '55P03' } });
          expect(await indexCatalog(f)).toEqual([]);
        } finally { await writer.exec('ROLLBACK'); }
      });
      expect(await f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx))).toEqual({ applied: true });
    });
  }, 30000);

  it('lets an independent SELECT-only no-DDL LOGIN prove readiness and rejects missing lookup permission', async () => {
    await attachmentFixture(async f => {
      await f.db.transaction(tx => installProductVideoGcAttachmentIndex(tx));
      const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
      const [origin] = await f.db.execute(sql`SELECT current_database() AS database,current_schema() AS schema`);
      if (!ownsFinanceFixtureTarget(String(origin.database),String(origin.schema),base.href))throw Error('Unowned attachment-index runtime fixture');
      const role='gc_index_reader_'+crypto.randomUUID().replaceAll('-',''),password=crypto.randomUUID().replaceAll('-','');
      await f.exec(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      let client:ReturnType<typeof postgres>|undefined;
      try {
        await f.exec(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        const url=new URL(base);url.pathname='/'+origin.database;url.username=role;url.password=password;
        client=postgres(url.href,{max:1,prepare:false,connect_timeout:5});const runtime=drizzle(client) as unknown as DbClient;
        const [identity]=await client`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
        expect(identity).toEqual({login:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false});
        const before=await indexCatalog(f);
        await expect(runtime.transaction(tx=>assertProductVideoGcAttachmentIndexReady(tx),{accessMode:'read only'})).rejects.toThrow('尚未就绪');
        await f.exec(`GRANT SELECT ON public.system_attachment TO "${role}"`);
        await runtime.transaction(tx=>assertProductVideoGcAttachmentIndexReady(tx),{accessMode:'read only'});
        await expect(client`UPDATE public.system_attachment SET name=name WHERE false`).rejects.toMatchObject({code:'42501'});
        await expect(runtime.transaction(tx=>installProductVideoGcAttachmentIndex(tx))).rejects.toThrow('PG16');
        expect(await indexCatalog(f)).toEqual(before);
      } finally {await client?.end({timeout:5});await f.exec(`REVOKE ALL ON public.system_attachment FROM "${role}"; REVOKE ALL ON SCHEMA public FROM "${role}"; DROP ROLE "${role}"`);}
    });
  }, 30000);
});
