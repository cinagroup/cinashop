import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbClient } from '@/lib/di';
import { PRODUCT_VIDEO_UPLOAD_SQL, PRODUCT_VIDEO_UPLOAD_CONSTRAINTS_SHA256,
  inspectProductVideoUpload, assertProductVideoUploadReady, installProductVideoUpload } from '@/migrations/adminProductVideoUpload';
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';

type Fixture = Awaited<ReturnType<typeof financePostgres>>;
const table = 'public.admin_product_video_upload_v1';
const guard = 'public.admin_product_video_upload_guard_v1()';
const createdAt = 1_700_000_000;
const part = (sha = 'a'.repeat(64), size = 12) => ({ sha256: sha, size });
function values(patch: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  return { upload_id: id, actor_id: 1, request_hash: 'a'.repeat(64),
    intent: { version: 1, mode: 'manifest', filename: 'owned.mp4', total_size: 12,
      chunk_size: 12, total_chunks: 1, sha256: ['a'.repeat(64)], pid: 0 },
    object_key: `attachments/admin/1/2026/10/${id}.mp4`, state: 'active', parts: {}, confirmed: [],
    attachment_id: null, created_at: createdAt, updated_at: createdAt, expires_at: createdAt + 43200, ...patch };
}
async function insert(db: Pick<DbClient, 'execute'>, patch: Record<string, unknown> = {}) {
  const row = values(patch);
  await db.execute(sql`INSERT INTO public.admin_product_video_upload_v1
    (upload_id,actor_id,request_hash,intent,object_key,state,parts,confirmed,attachment_id,created_at,updated_at,expires_at)
    VALUES (${row.upload_id}::uuid,${row.actor_id},${row.request_hash},${row.intent === null ? null : JSON.stringify(row.intent)}::jsonb,
      ${row.object_key},${row.state},${JSON.stringify(row.parts)}::jsonb,${JSON.stringify(row.confirmed)}::jsonb,
      ${row.attachment_id},${row.created_at},${row.updated_at},${row.expires_at})`);
  return String(row.upload_id);
}
async function isolated<T>(callback: (fixture: Fixture) => Promise<T>): Promise<T> {
  const fixture = await financePostgres([], { namespace: 'public' });
  try { return await callback(fixture); } finally { await fixture.close(); }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent product video upload catalog on genuine PG16', () => {
  let f: Fixture;
  beforeAll(async () => { f = await financePostgres([], { namespace: 'public' }); }, 30000);
  afterAll(async () => { await f?.close(); });

  it('pins the actual PG16 constraints, twelve columns and independent SQL mirror', async () => {
    expect(readFileSync(resolve(import.meta.dirname, '../src/migrations/maintenance/0185_admin_product_video_upload.sql'), 'utf8')
      .split('\n').slice(1).join('\n')).toBe(PRODUCT_VIDEO_UPLOAD_SQL);
    await f.db.transaction(async tx => {
      await tx.execute(sql.raw(PRODUCT_VIDEO_UPLOAD_SQL));
      const catalog = await inspectProductVideoUpload(tx);
      console.log('PRODUCT_VIDEO_UPLOAD_NATIVE_CATALOG', JSON.stringify(catalog));
      expect(catalog?.constraints_hash).toBe(PRODUCT_VIDEO_UPLOAD_CONSTRAINTS_SHA256);
      expect(catalog?.columns).toHaveLength(12);
      await assertProductVideoUploadReady(tx);
    });
    expect(await f.db.transaction(tx => installProductVideoUpload(tx))).toEqual({ applied: false });
    expect((await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.admin_product_video_upload_v1`))[0]?.count).toBe(0);
    expect(readFileSync(resolve(import.meta.dirname, '../src/services/MigrationService.ts'), 'utf8')).not.toContain('admin_product_video_upload_v1');
  });

  it('installs once in explicit owner maintenance, preserves existing data and grants, and rejects unsupported entry contexts', async () => {
    await isolated(async fresh => {
      await fresh.exec("CREATE TABLE public.existing_video_catalog_probe (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO public.existing_video_catalog_probe VALUES(1,'untouched')");
      const before = await fresh.db.execute(sql`SELECT c.relacl::text AS acl,(SELECT jsonb_agg(p) FROM public.existing_video_catalog_probe p) AS rows
        FROM pg_class c WHERE c.oid='public.existing_video_catalog_probe'::regclass`);
      await expect(installProductVideoUpload(fresh.db)).rejects.toThrow('transaction');
      await expect(fresh.db.transaction(tx => installProductVideoUpload(tx, 'unsafe-role'))).rejects.toThrow('identity');
      await expect(fresh.db.transaction(tx => installProductVideoUpload(tx), { isolationLevel: 'repeatable read' })).rejects.toThrow('PG16');
      await expect(fresh.db.transaction(tx => installProductVideoUpload(tx), { accessMode: 'read only' })).rejects.toThrow('PG16');
      expect((await fresh.db.execute(sql`SELECT to_regclass('public.admin_product_video_upload_v1') IS NULL AS absent`))[0]?.absent).toBe(true);
      expect(await fresh.db.transaction(tx => installProductVideoUpload(tx))).toEqual({ applied: true });
      expect(await fresh.db.transaction(tx => installProductVideoUpload(tx))).toEqual({ applied: false });
      expect(await fresh.db.execute(sql`SELECT c.relacl::text AS acl,(SELECT jsonb_agg(p) FROM public.existing_video_catalog_probe p) AS rows
        FROM pg_class c WHERE c.oid='public.existing_video_catalog_probe'::regclass`)).toEqual(before);
      expect((await fresh.db.execute(sql`SELECT count(*)::integer AS count FROM public.admin_product_video_upload_v1`))[0]?.count).toBe(0);
    });
  }, 30000);

  it('refuses either partial catalog without repairing or replacing its objects', async () => {
    for (const definition of [
      `CREATE TABLE ${table} (upload_id uuid)`,
      `CREATE FUNCTION ${guard} RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
    ]) await isolated(async fresh => {
      await fresh.exec(definition);
      const census = () => fresh.db.execute(sql`SELECT to_regclass('public.admin_product_video_upload_v1')::oid AS relation,
        to_regprocedure('public.admin_product_video_upload_guard_v1()')::oid AS function`);
      const before = await census();
      await expect(fresh.db.transaction(tx => installProductVideoUpload(tx))).rejects.toThrow('Partial');
      expect(await census()).toEqual(before);
      await expect(fresh.db.transaction(tx => assertProductVideoUploadReady(tx))).rejects.toThrow('尚未就绪');
    });
  }, 30000);

  it('fails closed on actual column, CHECK, index, trigger, function, table and ACL drift without repairing it', async () => {
    const baseline = await inspectProductVideoUpload(f.db), rollback = Error('rollback owned catalog drift');
    for (const change of [
      `ALTER TABLE ${table} ADD COLUMN unexpected integer`,
      `ALTER TABLE ${table} ALTER COLUMN actor_id SET DEFAULT 1`,
      `ALTER TABLE ${table} ALTER COLUMN parts DROP NOT NULL`,
      `ALTER TABLE ${table} DROP CONSTRAINT apvu_confirmed_ck`,
      `ALTER TABLE ${table} RENAME CONSTRAINT apvu_parts_ck TO unreviewed_parts`,
      `ALTER TABLE ${table} ALTER COLUMN object_key TYPE varchar(180) COLLATE "C"`,
      `CREATE INDEX unreviewed_video_index ON ${table}(actor_id)`,
      'ALTER INDEX public.apvu_object_uq SET (fillfactor=70)',
      `ALTER TABLE ${table} DISABLE TRIGGER apvu_rows`,
      `CREATE TRIGGER unreviewed_video_trigger BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${guard}`,
      `CREATE OR REPLACE FUNCTION ${guard} RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN RETURN NEW; END'`,
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${table} REPLICA IDENTITY FULL`,
      `GRANT SELECT ON ${table} TO PUBLIC`,
      `GRANT SELECT(actor_id) ON ${table} TO PUBLIC`,
    ]) {
      await expect(f.db.transaction(async tx => {
        await tx.execute(sql.raw(change));
        const drifted = await inspectProductVideoUpload(tx);
        await expect(assertProductVideoUploadReady(tx), change).rejects.toThrow('尚未就绪');
        await expect(installProductVideoUpload(tx), change).rejects.toThrow('尚未就绪');
        expect(await inspectProductVideoUpload(tx)).toEqual(drifted);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await inspectProductVideoUpload(f.db)).toEqual(baseline);
    }
  }, 30000);

  it('allows only monotone active facts and permanently freezes committed and cancelled rows', async () => {
    const id = await insert(f.db);
    await f.db.execute(sql`UPDATE public.admin_product_video_upload_v1 SET parts=${JSON.stringify({ 1: part() })}::jsonb,
      confirmed='[1]'::jsonb,updated_at=${createdAt + 1} WHERE upload_id=${id}::uuid`);
    const snapshot = async () => (await f.db.execute(sql`SELECT * FROM public.admin_product_video_upload_v1 WHERE upload_id=${id}::uuid`))[0];
    const before = await snapshot();
    for (const change of ["parts='{}'::jsonb", `parts='{"1":{"sha256":"changed","size":12}}'::jsonb`,
      "confirmed='[]'::jsonb", 'actor_id=2', "request_hash=repeat('b',64)", "intent='{}'::jsonb", 'object_key=NULL',
      `upload_id='${crypto.randomUUID()}'::uuid`,
      `created_at=${createdAt - 1}`, `expires_at=${createdAt + 43201}`, `updated_at=${createdAt}`, "state='unknown'"])
      await expect(f.exec(`UPDATE ${table} SET ${change} WHERE upload_id='${id}'`)).rejects.toMatchObject({ code: '42501' });
    expect(await snapshot()).toEqual(before);
    await expect(f.exec(`DELETE FROM ${table} WHERE upload_id='${id}'`)).rejects.toMatchObject({ code: '42501' });
    await expect(f.exec(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: '42501' });
    await f.db.execute(sql`UPDATE public.admin_product_video_upload_v1 SET parts=${JSON.stringify({ 1: part(), 2: part('b'.repeat(64), 5) })}::jsonb,
      confirmed='[1,2]'::jsonb,state='committed',attachment_id=301,updated_at=${createdAt + 2} WHERE upload_id=${id}::uuid`);
    for (const statement of [`UPDATE ${table} SET updated_at=updated_at WHERE upload_id='${id}'`,
      `UPDATE ${table} SET state='active',attachment_id=NULL WHERE upload_id='${id}'`, `DELETE FROM ${table} WHERE upload_id='${id}'`])
      await expect(f.exec(statement)).rejects.toMatchObject({ code: '42501' });
    const cancellation = await insert(f.db);
    await f.db.execute(sql`UPDATE public.admin_product_video_upload_v1 SET state='cancelled',updated_at=${createdAt + 1} WHERE upload_id=${cancellation}::uuid`);
    const tombstone = await insert(f.db, { state: 'cancelled', intent: null, object_key: null, request_hash: '' });
    for (const cancelled of [cancellation, tombstone]) {
      await expect(f.exec(`UPDATE ${table} SET state='active' WHERE upload_id='${cancelled}'`)).rejects.toMatchObject({ code: '42501' });
      await expect(f.exec(`DELETE FROM ${table} WHERE upload_id='${cancelled}'`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(f.exec(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces object and array bounds, exact tombstones, identity lifetimes and valid state facts in PG16', async () => {
    for (const patch of [
      { actor_id: 0 }, { upload_id: '00000000-0000-1000-8000-000000000001' }, { created_at: 0 },
      { expires_at: createdAt + 43201 }, { updated_at: createdAt - 1 },
      { parts: [] }, { parts: null }, { parts: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i + 1, part()])) },
      { parts: { 1: { oversized: 'x'.repeat(16384) } } }, { confirmed: {} }, { confirmed: null }, { confirmed: Array(101).fill(1) },
      { state: 'active', attachment_id: 301 }, { state: 'committed' }, { state: 'committed', attachment_id: 0 },
      { request_hash: 'not-sha256' }, { intent: null }, { object_key: 'attachments/supplier/1/not-platform.mp4' },
      { state: 'cancelled', intent: null, object_key: null, request_hash: '', parts: { 1: part() } },
      { state: 'cancelled', intent: null, object_key: null, request_hash: '', confirmed: [1] },
    ]) await expect(insert(f.db, patch), JSON.stringify(patch).slice(0, 160)).rejects.toThrow();
    await insert(f.db, { parts: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i + 1, part()])), confirmed: Array.from({ length: 100 }, (_, i) => i + 1) });
    const duplicate = values(); await insert(f.db, duplicate);
    await expect(insert(f.db, { object_key: duplicate.object_key })).rejects.toMatchObject({ cause: { code: '23505', constraint_name: 'apvu_object_uq' } });
  });

  it('works through an independent restricted LOGIN with only SELECT INSERT UPDATE and refuses missing or widened grants', async () => {
    await isolated(async f => {
      const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
      const [origin] = await f.db.execute(sql`SELECT current_database() AS database,current_schema() AS schema`);
      if (!ownsFinanceFixtureTarget(String(origin.database), String(origin.schema), base.href)) throw Error('Unowned video catalog runtime fixture');
      const role = 'video_runtime_' + crypto.randomUUID().replaceAll('-', ''), password = crypto.randomUUID().replaceAll('-', '');
      await f.exec(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      let client: ReturnType<typeof postgres> | undefined;
      try {
        await f.exec(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        expect(await f.db.transaction(tx => installProductVideoUpload(tx, role))).toEqual({ applied: true });
        const url = new URL(base); url.pathname = '/' + origin.database; url.username = role; url.password = password;
        client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5 });
        const [identity] = await client`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
          FROM pg_catalog.pg_roles WHERE rolname=current_user`;
        expect(identity).toEqual({ login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false });
        const runtime = drizzle(client) as unknown as DbClient;
        await runtime.transaction(tx => assertProductVideoUploadReady(tx));
        const id = await insert(runtime);
        await runtime.execute(sql`UPDATE public.admin_product_video_upload_v1 SET parts=${JSON.stringify({ 1: part() })}::jsonb,
          confirmed='[1]'::jsonb WHERE upload_id=${id}::uuid`);
        for (const statement of [`DELETE FROM ${table}`, `TRUNCATE ${table}`, `SELECT ${guard}`,
          `UPDATE ${table} SET actor_id=2 WHERE upload_id='${id}'`])
          await expect(client.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
        await expect(runtime.transaction(tx => installProductVideoUpload(tx))).rejects.toThrow('PG16');
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
          await f.exec(`REVOKE ${privilege} ON ${table} FROM "${role}"`);
          const before = await f.db.execute(sql`SELECT * FROM public.admin_product_video_upload_v1 ORDER BY upload_id`);
          await expect(runtime.transaction(tx => assertProductVideoUploadReady(tx))).rejects.toThrow('尚未就绪');
          expect(await f.db.execute(sql`SELECT * FROM public.admin_product_video_upload_v1 ORDER BY upload_id`)).toEqual(before);
          await f.exec(`GRANT ${privilege} ON ${table} TO "${role}"`);
        }
        await f.exec(`GRANT DELETE ON ${table} TO "${role}"`);
        await expect(runtime.transaction(tx => assertProductVideoUploadReady(tx))).rejects.toThrow('尚未就绪');
        await expect(f.db.transaction(tx => installProductVideoUpload(tx, role))).rejects.toThrow('尚未就绪');
        await f.exec(`REVOKE DELETE ON ${table} FROM "${role}"`);
        expect(await f.db.transaction(tx => installProductVideoUpload(tx, role))).toEqual({ applied: false });
        await runtime.transaction(tx => assertProductVideoUploadReady(tx));
      } finally {
        await client?.end({ timeout: 5 });
        await f.exec(`REVOKE ALL ON ${table} FROM "${role}"; REVOKE ALL ON SCHEMA public FROM "${role}"; DROP ROLE "${role}"`);
      }
    });
  }, 30000);
});
