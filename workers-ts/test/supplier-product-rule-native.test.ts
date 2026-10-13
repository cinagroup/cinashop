import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { storeProductRule, storeProduct, storeProductAttrValue, systemRole, systemMenus, systemAdmin, systemLog } from '@/models/schema';
import { SupplierProductRuleService } from '@/services/supplier/SupplierProductRuleService';
import { supplierRuleActor, supplierRuleBody, supplierRuleSchema, seedSupplierRules } from './helpers/supplierProductRules';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
function code(error: unknown): string { for (let i = 0; i < 8 && error && typeof error === 'object'; i++) { if ('code' in error) return String(error.code); error = 'cause' in error ? error.cause : null; } return ''; }
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier rule owned PG16 LOGIN, shared scope and atomic row/audit proof', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => { const kit = await import('drizzle-kit/api'); ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(supplierRuleSchema))).join('\n'); });
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native Supplier rule forbids external I/O')); f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withPeer || !f.withRuntimeRole) throw Error('Owned real PG16 LOGIN peers required');
    await f.exec(ddl); await seedSupplierRules(f.db); await f.exec("SELECT setval(pg_get_serial_sequence('store_product_rule','id'),400,false)"); }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const service = (peer: SequenceRunnerPeer) => new SupplierProductRuleService(createContainerFromDb(peer.db));
  const rules = () => f.db.select().from(storeProductRule).orderBy(storeProductRule.id);
  const logs = () => f.db.select().from(systemLog).orderBy(systemLog.id);
  async function login<T>(write: boolean, run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async peer => { if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe fixture role');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
      if (write) await f.exec(`GRANT INSERT,UPDATE,DELETE ON store_product_rule TO "${peer.role}"; GRANT INSERT ON system_log TO "${peer.role}";
        GRANT UPDATE(id) ON system_admin,system_supplier,system_role,system_menus TO "${peer.role}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${peer.role}"`);
      const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid }); expect(Math.floor(Number(identity.version) / 10000)).toBe(16); return run(peer); });
  }
  async function heldAudit(key: number) { await f.exec(`CREATE FUNCTION hold_rule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731613,${key}); RETURN NEW; END $$; CREATE TRIGGER hold_rule_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION hold_rule_audit()`); }
  it('completes create/edit/delete with LOGIN business DML and only account/role/menu lock-column privileges', async () => {
    await login(true, async peer => {
      const [p] = await peer.exec("SELECT has_column_privilege(current_user,'system_menus','id','UPDATE') AS menu_lock,has_column_privilege(current_user,'system_menus','api_url','UPDATE') AS menu_write,has_table_privilege(current_user,'store_product','UPDATE') AS product_write");
      expect(p).toEqual({ menu_lock: true, menu_write: false, product_write: false });
      const result = await service(peer).save(20, 0, supplierRuleBody(), supplierRuleActor(24));
      await service(peer).save(20, result.id, supplierRuleBody({ rule_name: '真实LOGIN编辑' }), supplierRuleActor());
      await service(peer).delete(20, result.id, undefined, supplierRuleActor()); expect((await logs()).map(row => row.method)).toEqual(['POST', 'POST', 'DELETE']);
    });
  });
  it('supports SELECT-only read transactions and refuses writes with zero template and audit changes', async () => {
    await login(false, async peer => { expect((await service(peer).list(20, new URLSearchParams(), supplierRuleActor(22))).count).toBe(2);
      expect((await service(peer).templates(20, new URLSearchParams(), supplierRuleActor(22)))).toHaveLength(2);
      const before = await rules(), error = await service(peer).save(20, 0, supplierRuleBody(), supplierRuleActor()).then(() => null, error => error);
      expect(code(error)).toBe('42501'); expect(await rules()).toEqual(before); expect(await logs()).toEqual([]); });
  });
  it('serializes same-owner duplicate creation and commits exactly one full rule and audit', async () => {
    await login(true, peer => f.withPeer!(async other => { const results = await Promise.allSettled([service(peer).save(20, 0, supplierRuleBody(), supplierRuleActor()), service(other).save(20, 0, supplierRuleBody(), supplierRuleActor())]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect((await rules()).filter(row => row.ruleName === '供应商新增模板')).toHaveLength(1); expect(await logs()).toHaveLength(1); }));
  });
  it.each(['delete-first', 'edit-first'])('uses actual shared owner lock for %s and never reports an edit of a deleted or stale row successful', async order => {
    await heldAudit(0); const initial = await new SupplierProductRuleService(createContainerFromDb(f.db)).detail(20, 201, new URLSearchParams(), supplierRuleActor());
    await login(true, peer => f.withPeer!(async blocker => f.withPeer!(async second => {
      await blocker.exec('SELECT pg_advisory_lock(731613,0)');
      const first = outcome(order === 'delete-first' ? service(peer).delete(20, 201, undefined, supplierRuleActor()) : service(peer).save(20, 201, supplierRuleBody(), supplierRuleActor()));
      let next: ReturnType<typeof outcome>;
      try { await waitForFinanceBlock(f.db, peer.pid, blocker.pid);
        next = outcome(order === 'delete-first' ? service(second).save(20, 201, supplierRuleBody(), supplierRuleActor())
          : service(second).delete(20, 201, { expected_revision: initial.info.revision }, supplierRuleActor()));
        await waitForFinanceBlock(f.db, second.pid, peer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731613,0)'); }
      expect((await first).ok).toBe(true); const result = await next!; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: order === 'delete-first' ? 404 : 409 }); expect(await logs()).toHaveLength(1);
    })));
  });
  it('uses row NOWAIT for a separately held target row and leaves all facts unchanged', async () => {
    await login(true, peer => f.withPeer!(async holder => { const before = await rules(); await holder.exec('BEGIN');
      try { await holder.exec('SELECT id FROM store_product_rule WHERE id=201 FOR UPDATE');
        await expect(service(peer).save(20, 201, supplierRuleBody(), supplierRuleActor())).rejects.toMatchObject({ code: 409 });
        await expect(service(peer).delete(20, 201, undefined, supplierRuleActor())).rejects.toMatchObject({ code: 409 });
      } finally { await holder.exec('ROLLBACK'); } expect(await rules()).toEqual(before); expect(await logs()).toEqual([]); }));
  });
  it('does not block another Supplier behind an owner lock and never modifies platform or foreign rules', async () => {
    await login(true, peer => f.withPeer!(async holder => { await holder.exec('SELECT pg_advisory_lock(731612,20)');
      try { const result = await service(peer).save(30, 0, supplierRuleBody(), supplierRuleActor(31)); expect((await rules()).find(row => row.id === result.id)).toMatchObject({ type: 2, relationId: 30 }); }
      finally { await holder.exec('SELECT pg_advisory_unlock(731612,20)'); } expect((await rules()).find(row => row.id === 201)?.ruleName).toBe('当前服装模板'); }));
  });
  it('rechecks rotated password and actual expiry after a request waited for the owner scope', async () => {
    await login(true, peer => f.withPeer!(async holder => {
      await holder.exec('SELECT pg_advisory_lock(731612,20)'); const pending = outcome(service(peer).save(20, 0, supplierRuleBody(), supplierRuleActor()));
      try { await waitForFinanceBlock(f.db, peer.pid, holder.pid); await f.db.update(systemAdmin).set({ pwd: 'rotated' }).where(eq(systemAdmin.id, 21)); }
      finally { await holder.exec('SELECT pg_advisory_unlock(731612,20)'); }
      const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toMatchObject({ code: 410001 }); expect(await logs()).toEqual([]);
    }));
    await expect(new SupplierProductRuleService(createContainerFromDb(f.db)).list(20, new URLSearchParams(), { ...supplierRuleActor(22), expiresAt: 1 })).rejects.toMatchObject({ code: 410001 });
  });
  it('holds current staff role and exact numeric menu through audit commit and refuses the request following withdrawal', async () => {
    await heldAudit(1); await login(true, peer => f.withPeer!(async holder => f.withPeer!(async revoker => {
      await holder.exec('SELECT pg_advisory_lock(731613,1)'); const pending = outcome(service(peer).save(20, 0, supplierRuleBody(), supplierRuleActor(24)));
      try { await waitForFinanceBlock(f.db, peer.pid, holder.pid);
        for (const table of ['system_admin', 'system_supplier', 'system_role', 'system_menus']) await expect(revoker.exec(`SELECT id FROM ${table} WHERE id=${table === 'system_menus' ? 901 : table === 'system_supplier' ? 20 : 24} FOR UPDATE NOWAIT`)).rejects.toMatchObject({ code: '55P03' });
      } finally { await holder.exec('SELECT pg_advisory_unlock(731613,1)'); expect((await pending).ok).toBe(true); }
      await f.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 901));
      await expect(service(peer).save(20, 0, supplierRuleBody({ rule_name: '撤菜单后' }), supplierRuleActor(24))).rejects.toMatchObject({ code: 400011 });
      await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21));
      await expect(service(peer).save(20, 0, supplierRuleBody({ rule_name: '撤角色后' }), supplierRuleActor())).rejects.toMatchObject({ code: 400011 }); expect(await logs()).toHaveLength(1);
    })));
  });
  it('refuses a JWT that actually expires while a live LOGIN request is waiting for its owner scope', async () => {
    await login(true, peer => f.withPeer!(async holder => {
      await holder.exec('SELECT pg_advisory_lock(731612,20)');
      // Start near a real second boundary so expiry happens before the 2s lock timeout.
      await new Promise(resolve => setTimeout(resolve, 1010 - Date.now() % 1000));
      const actor = { ...supplierRuleActor(), expiresAt: Math.floor(Date.now() / 1000) + 1 };
      const pending = outcome(service(peer).save(20, 0, supplierRuleBody(), actor));
      try { await waitForFinanceBlock(f.db, peer.pid, holder.pid);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, actor.expiresAt * 1000 + 20 - Date.now()))); }
      finally { await holder.exec('SELECT pg_advisory_unlock(731612,20)'); }
      const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toMatchObject({ code: 410001 }); expect(await logs()).toEqual([]);
    }));
  });
  it.each(['UPDATE', 'DELETE'])('proves native BEFORE %s suppression rolls back without false success or audit', async operation => {
    const before = await rules(); await f.exec(`CREATE FUNCTION suppress_rule_native() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_rule_native BEFORE ${operation} ON store_product_rule FOR EACH ROW EXECUTE FUNCTION suppress_rule_native()`);
    await login(true, async peer => { await expect(operation === 'UPDATE' ? service(peer).save(20, 201, supplierRuleBody(), supplierRuleActor()) : service(peer).delete(20, 201, undefined, supplierRuleActor())).rejects.toMatchObject({ code: 409 });
      expect(await rules()).toEqual(before); expect(await logs()).toEqual([]); });
  });
  it('proves native full-row rewrite and suppressed or corrupt audit receipts all roll back business facts', async () => {
    const before = await rules(); await f.exec("CREATE FUNCTION rewrite_rule_native() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.rule_value='[]'; RETURN NEW; END $$; CREATE TRIGGER rewrite_rule_native BEFORE UPDATE ON store_product_rule FOR EACH ROW EXECUTE FUNCTION rewrite_rule_native()");
    await login(true, async peer => { await expect(service(peer).save(20, 201, supplierRuleBody(), supplierRuleActor())).rejects.toMatchObject({ code: 409 }); expect(await rules()).toEqual(before); expect(await logs()).toEqual([]); });
    await f.exec('DROP TRIGGER rewrite_rule_native ON store_product_rule; DROP FUNCTION rewrite_rule_native()');
    for (const body of ['RETURN NULL;', "NEW.merchant_id=30; RETURN NEW;"]) {
      await f.exec(`CREATE FUNCTION rewrite_rule_audit_native() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$; CREATE TRIGGER rewrite_rule_audit_native BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION rewrite_rule_audit_native()`);
      await login(true, async peer => { await expect(service(peer).save(20, 0, supplierRuleBody(), supplierRuleActor())).rejects.toThrow('审计'); expect(await rules()).toEqual(before); expect(await logs()).toEqual([]); });
      await f.exec('DROP TRIGGER rewrite_rule_audit_native ON system_log; DROP FUNCTION rewrite_rule_audit_native()');
    }
  });
  it('proves native post-audit cross-row mutation is rejected and copied product and SKU facts survive delete', async () => {
    const before = await rules(); await f.exec("CREATE FUNCTION audit_rule_other_native() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_rule SET rule_name='audit-modified' WHERE id=202; RETURN NEW; END $$; CREATE TRIGGER audit_rule_other_native BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION audit_rule_other_native()");
    // Trigger DML runs with a real rule-writing LOGIN, rather than a fixture function elevated to SECURITY DEFINER.
    await login(true, async peer => { await expect(service(peer).save(20, 201, supplierRuleBody(), supplierRuleActor())).rejects.toMatchObject({ code: 409 }); expect(await rules()).toEqual(before); expect(await logs()).toEqual([]); });
    await f.exec('DROP TRIGGER audit_rule_other_native ON system_log; DROP FUNCTION audit_rule_other_native()');
    const product = await f.db.select().from(storeProduct), skus = await f.db.select().from(storeProductAttrValue);
    await login(true, async peer => service(peer).delete(20, 202, undefined, supplierRuleActor()));
    expect(await f.db.select().from(storeProduct)).toEqual(product); expect(await f.db.select().from(storeProductAttrValue)).toEqual(skus);
  });
});
