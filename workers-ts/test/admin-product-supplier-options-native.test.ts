import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemRole, systemSupplier } from '@/models/schema';
import { AdminProductCatalogReadService } from '@/services/admin/AdminProductCatalogReadService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceClock } from './helpers/financePeers';
import { seedSupplierOptions, supplierOptionsActor, supplierOptionsExpected, supplierOptionsSchema,
  supplierOptionsSnapshot, pauseSupplierOptionsRead } from './helpers/adminProductSupplierOptions';

type Login = SequenceRunnerPeer & { role: string };
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin supplier selector PG16 actual read-only LOGIN and snapshot', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  beforeAll(async () => { const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(supplierOptionsSchema))).join('\n'); });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native supplier selector forbids provider I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Actual PostgreSQL16 LOGIN required');
    await f.exec(ddl); await seedSupplierOptions(f.db);
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const read = (db: DbClient, actor = supplierOptionsActor()) =>
    new AdminProductCatalogReadService(createContainerFromDb(db)).supplierOptions(new URLSearchParams(), actor);
  const login = <T>(run: (peer: Login) => Promise<T>) => f.withRuntimeRole!(async peer => {
    if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe runtime LOGIN');
    await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
    const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
    expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
    expect(Math.floor(Number(identity.version) / 10000)).toBe(16); return run(peer);
  });

  it('reads under a real SELECT-only LOGIN with no supplier/audit DML or sequence privilege and preserves every fixture row', async () => {
    await login(async peer => {
      const [acl] = await peer.exec("SELECT has_table_privilege(current_user,'public.system_supplier','SELECT') AS supplier_select,has_table_privilege(current_user,'public.system_supplier','UPDATE') AS supplier_update,has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,has_sequence_privilege(current_user,pg_get_serial_sequence('public.system_supplier','id'),'USAGE') AS sequence_usage");
      expect(acl).toEqual({ supplier_select: true, supplier_update: false, audit_insert: false, sequence_usage: false });
      for (const statement of ['UPDATE system_supplier SET sort=sort WHERE false', 'INSERT INTO system_log(admin_id) VALUES(101)',
        "SELECT nextval(pg_get_serial_sequence('system_supplier','id'))"])
        await expect(peer.exec(statement)).rejects.toMatchObject({ code: '42501' });
      const before = await supplierOptionsSnapshot(f.db);
      expect(await read(peer.db)).toEqual(supplierOptionsExpected);
      expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
      await f.exec(`REVOKE SELECT ON system_supplier FROM "${peer.role}"`);
      await expect(read(peer.db)).rejects.toMatchObject({ httpStatus: 503 });
      expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
    });
  }, 60000);

  it('uses one real repeatable-read authorization/options snapshot while the following read sees committed revocation and supplier edits', async () => {
    await login(async peer => {
      const ready = signal(), release = signal();
      const pending = outcome(read(pauseSupplierOptionsRead(peer.db, 'system_admin', async () => { ready.resolve(); await release.promise; })));
      try {
        await Promise.race([ready.promise, pending.then(value => { if (!value.ok) throw value.error; throw Error('Read did not reach authority SQL boundary'); })]);
        const [activity] = await f.exec(`SELECT state,backend_xmin FROM pg_stat_activity WHERE pid=${peer.pid}`) as unknown as Array<{ state: string; backend_xmin: string | null }>;
        expect(activity.state).toBe('idle in transaction'); expect(activity.backend_xmin).not.toBeNull();
        await f.db.update(systemRole).set({ rules: 'reply.view' }).where(eq(systemRole.id, 1));
        await f.db.update(systemSupplier).set({ supplierName: '并发更新名称', isDel: 1 }).where(eq(systemSupplier.id, 20));
        await f.db.insert(systemSupplier).values({ id: 50, adminId: 950, supplierName: '并发新候选' });
      } finally { release.resolve(); }
      const result = await pending; expect(result.ok).toBe(true); if (!result.ok) throw result.error;
      expect(result.value).toEqual(supplierOptionsExpected);
      const changed = await supplierOptionsSnapshot(f.db);
      await expect(read(peer.db)).rejects.toThrow('权限');
      expect(await read(peer.db, supplierOptionsActor(103))).toEqual([{ id: 50, supplier_name: '并发新候选' }, supplierOptionsExpected[0]]);
      expect(await supplierOptionsSnapshot(f.db)).toEqual(changed);
    });
  }, 60000);

  it('checks real PostgreSQL wall-clock expiry after the supplier query and returns no expired result', async () => {
    await login(async peer => {
      const before = await supplierOptionsSnapshot(f.db), expiresAt = Math.floor(Date.now() / 1000) + 2;
      const db = pauseSupplierOptionsRead(peer.db, 'system_supplier', () => waitForFinanceClock(f.db, expiresAt * 1000));
      await expect(read(db, { ...supplierOptionsActor(), expiresAt })).rejects.toThrow('过期');
      expect(await read(peer.db)).toEqual(supplierOptionsExpected);
      expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
    });
  }, 60000);
});
