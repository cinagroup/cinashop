import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbClient } from '@/lib/di';
import { systemAdmin, systemRole } from '@/models/schema';
import { ADMIN_PROFILE_SQL, ADMIN_PROFILE_IMMUTABLE_BODY, inspectAdminProfile, assertAdminProfileReady } from '@/migrations/adminProfile';
import { installAdminProfileUpgradeInTransaction, runAdminProfileUpgrade } from '@/migrations/runAdminProfileUpgrade';
import { financeMemoryPostgres } from './helpers/financePostgres';

/** Actual PG catalog/ACL/trigger SQL in the owned memory fixture. This does not
 * claim independently authenticated PG16 runtime/owner commissioning; those
 * privileged production gates remain explicit and are never auto-installed. */
describe('Admin profile independent immutable addon readiness and fail-closed maintenance gates', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => {
    f = await financeMemoryPostgres([systemAdmin, systemRole], { namespace: 'public' });
    await f.exec(ADMIN_PROFILE_SQL);
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  async function snapshot() {
    return {
      operation: Array.from(await f.db.execute(sql`SELECT * FROM public.admin_profile_operation ORDER BY operation_id`), row => ({ ...row })),
      avatar: Array.from(await f.db.execute(sql`SELECT * FROM public.admin_profile_avatar ORDER BY avatar_id`), row => ({ ...row })),
      sequences: Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`), row => ({ ...row })),
    };
  }
  async function refuses() { expect(await inspectAdminProfile(f.db)).toBe(false); await expect(assertAdminProfileReady(f.db)).rejects.toMatchObject({ code: 503 }); }

  it('recognizes the actual two-table/function catalog and owner fixture without modifying rows or sequences', async () => {
    expect(f.isMemory).toBe(true); const before = await snapshot();
    expect(await inspectAdminProfile(f.db)).toBe(true); await expect(assertAdminProfileReady(f.db)).resolves.toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });
  it('rejects a partial catalog and does not recreate or repair a missing table', async () => {
    await f.exec('ALTER TABLE public.admin_profile_avatar RENAME TO profile_avatar_missing_fixture');
    try { await refuses(); const [row] = await f.db.execute(sql`SELECT to_regclass('public.admin_profile_avatar') IS NULL AS absent`); expect(row.absent).toBe(true); }
    finally { await f.exec('ALTER TABLE public.profile_avatar_missing_fixture RENAME TO admin_profile_avatar'); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('rejects an added column instead of accepting a merely compatible SELECT projection', async () => {
    await f.exec('ALTER TABLE public.admin_profile_operation ADD COLUMN unreviewed text');
    try { await refuses(); } finally { await f.exec('ALTER TABLE public.admin_profile_operation DROP COLUMN unreviewed'); }
    // A dropped-column tombstone changes the exact catalog too. This fixture is
    // not repaired; later counterexamples use their own clean owned fixture.
    expect(await inspectAdminProfile(f.db)).toBe(false);
  });
});

describe('Admin profile exact catalog independent counterexamples', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, maintenance: string;
  const runtime = 'profile_admin_fixture', app = 'profile_app_fixture';
  beforeAll(async () => {
    f = await financeMemoryPostgres([systemAdmin, systemRole], { namespace: 'public' }); await f.exec(ADMIN_PROFILE_SQL);
    const [identity] = await f.db.execute(sql`SELECT current_user AS identity`); maintenance = String(identity.identity);
    await f.exec(`CREATE ROLE ${runtime} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${app} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  const restoreBody = () => f.exec(`CREATE OR REPLACE FUNCTION public.admin_profile_immutable_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $profile$${ADMIN_PROFILE_IMMUTABLE_BODY}$profile$`);
  async function refuses() { expect(await inspectAdminProfile(f.db)).toBe(false); await expect(assertAdminProfileReady(f.db)).rejects.toMatchObject({ code: 503 }); }
  async function facts() { return Array.from(await f.db.execute(sql`SELECT operation_id,actor_id,operation,request_hash,state,created_at FROM public.admin_profile_operation ORDER BY operation_id`), row => ({ ...row })); }

  it('rejects a weakened value constraint despite the original constraint name', async () => {
    await f.exec('ALTER TABLE public.admin_profile_avatar DROP CONSTRAINT admin_profile_avatar_size_check; ALTER TABLE public.admin_profile_avatar ADD CONSTRAINT admin_profile_avatar_size_check CHECK(size BETWEEN 1 AND 9999999)');
    try { await refuses(); } finally { await f.exec('ALTER TABLE public.admin_profile_avatar DROP CONSTRAINT admin_profile_avatar_size_check; ALTER TABLE public.admin_profile_avatar ADD CONSTRAINT admin_profile_avatar_size_check CHECK(size BETWEEN 1 AND 2097152)'); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('rejects missing unique object-key enforcement', async () => {
    await f.exec('ALTER TABLE public.admin_profile_avatar DROP CONSTRAINT admin_profile_avatar_object_key_key');
    try { await refuses(); } finally { await f.exec('ALTER TABLE public.admin_profile_avatar ADD CONSTRAINT admin_profile_avatar_object_key_key UNIQUE(object_key)'); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('rejects disabled immutable triggers and never enables them from a runtime assertion', async () => {
    await f.exec('ALTER TABLE public.admin_profile_avatar DISABLE TRIGGER apa_immutable');
    try { await refuses(); const [row] = await f.db.execute(sql`SELECT tgenabled FROM pg_trigger WHERE tgname='apa_immutable'`); expect(row.tgenabled).toBe('D'); }
    finally { await f.exec('ALTER TABLE public.admin_profile_avatar ENABLE TRIGGER apa_immutable'); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('rejects changed trigger code even with identical signature and search_path', async () => {
    await f.exec("CREATE OR REPLACE FUNCTION public.admin_profile_immutable_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NEW; END $$");
    try { await refuses(); } finally { await restoreBody(); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('rejects an extra trigger regardless of its matching reviewed function', async () => {
    await f.exec('CREATE TRIGGER profile_extra BEFORE INSERT ON public.admin_profile_operation FOR EACH ROW EXECUTE FUNCTION public.admin_profile_immutable_v1()');
    try { await refuses(); } finally { await f.exec('DROP TRIGGER profile_extra ON public.admin_profile_operation'); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('rejects PUBLIC data grants and function EXECUTE without revoking them implicitly', async () => {
    await f.exec('GRANT SELECT ON public.admin_profile_operation TO PUBLIC');
    try { await refuses(); } finally { await f.exec('REVOKE SELECT ON public.admin_profile_operation FROM PUBLIC'); }
    await f.exec('GRANT EXECUTE ON FUNCTION public.admin_profile_immutable_v1() TO PUBLIC');
    try { await refuses(); } finally { await f.exec('REVOKE EXECUTE ON FUNCTION public.admin_profile_immutable_v1() FROM PUBLIC'); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('accepts only exact SELECT/INSERT Admin grants with zero App privileges, then refuses an UPDATE expansion', async () => {
    await f.exec(`GRANT SELECT,INSERT ON public.admin_profile_operation,public.admin_profile_avatar TO ${runtime}`);
    try {
      expect(await inspectAdminProfile(f.db, { maintenance, admin: runtime })).toBe(true);
      const [row] = await f.db.execute(sql`SELECT has_table_privilege(${app},'public.admin_profile_operation','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_table_privilege(${app},'public.admin_profile_avatar','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`); expect(row.allowed).toBe(false);
      await f.exec(`GRANT UPDATE ON public.admin_profile_operation TO ${runtime}`);
      await refuses(); expect(await inspectAdminProfile(f.db, { maintenance, admin: runtime })).toBe(false);
    } finally { await f.exec(`REVOKE ALL ON public.admin_profile_operation,public.admin_profile_avatar FROM ${runtime}`); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('rejects column-only grants and delegation even when the table privilege list looks narrow', async () => {
    await f.exec(`GRANT SELECT(actor_id) ON public.admin_profile_operation TO ${app}`);
    try { await refuses(); } finally { await f.exec(`REVOKE SELECT(actor_id) ON public.admin_profile_operation FROM ${app}`); }
    await f.exec(`GRANT SELECT ON public.admin_profile_operation TO ${runtime} WITH GRANT OPTION`);
    try { await refuses(); } finally { await f.exec(`REVOKE ALL ON public.admin_profile_operation FROM ${runtime}`); }
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('enforces immutable receipts for UPDATE, DELETE and TRUNCATE using actual installed trigger bodies', async () => {
    const id = 'ee000000-0000-4000-8000-000000000001';
    await f.exec(`INSERT INTO public.admin_profile_operation VALUES('${id}',11,'phone','${'a'.repeat(64)}','committed',1)`);
    const before = await facts();
    for (const mutation of ["UPDATE public.admin_profile_operation SET actor_id=12", 'DELETE FROM public.admin_profile_operation', 'TRUNCATE public.admin_profile_operation']) {
      await expect(f.exec(mutation)).rejects.toThrow('immutable'); expect(await facts()).toEqual(before);
    }
  });
  it('rejects a caller-selected database before any maintenance DDL, ACL or business mutation', async () => {
    const before = await facts(), target = { database: 'not_this_owned_fixture', maintenance, admin: runtime, app };
    await expect(runAdminProfileUpgrade(f.db, target)).rejects.toThrow('PG16 owner/database'); expect(await facts()).toEqual(before);
    expect(await inspectAdminProfile(f.db)).toBe(true);
  });
  it('requires an existing transaction for the installer and a real root connection for its outer wrapper', async () => {
    const target = { database: 'fixture', maintenance, admin: runtime, app };
    await expect(installAdminProfileUpgradeInTransaction(f.db, target)).rejects.toThrow('existing maintenance transaction');
    const query = { execute: f.db.execute.bind(f.db) };
    await expect(runAdminProfileUpgrade(query as unknown as DbClient, target)).rejects.toThrow('root maintenance connection');
  });
  it('rejects duplicate/unsafe runtime identities before issuing DDL', async () => {
    const before = await facts();
    await expect(f.db.transaction(tx => installAdminProfileUpgradeInTransaction(tx as unknown as DbClient,
      { database: 'fixture', maintenance, admin: runtime, app: runtime }))).rejects.toThrow('Distinct');
    await expect(f.db.transaction(tx => installAdminProfileUpgradeInTransaction(tx as unknown as DbClient,
      { database: 'fixture', maintenance, admin: 'bad;role', app }))).rejects.toThrow();
    expect(await facts()).toEqual(before); expect(await inspectAdminProfile(f.db)).toBe(true);
  });
});
