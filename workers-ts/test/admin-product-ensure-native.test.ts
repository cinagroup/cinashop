import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProductEnsure, storeProduct, storeProductRelation, systemLog, systemRole, systemMenus } from '@/models/schema';
import { AdminProductEnsureService } from '@/services/admin/AdminProductEnsureService';
import { ProductExperienceService } from '@/services/product/ProductExperienceService';
import { ProductAssociationService } from '@/services/product/ProductAssociationService';
import { ensureActor, ensureBody, ensureSchema, seedEnsures } from './helpers/adminProductEnsures';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
const owner = { type: 0, relationId: 0 } as const;
const query = () => new URLSearchParams();
const productActor = { id: 101, name: 'native guarantee fixture', ip: '127.0.0.1' };
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function hasCode(error: unknown, expected: string): boolean {
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    if ('code' in error && String(error.code) === expected) return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin guarantees on independent PG16 LOGINs and actual product-reference writers', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(ensureSchema))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native guarantee fixture forbids external I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Independent PG16 LOGIN peers required');
    await f.exec(ddl); await seedEnsures(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_ensure','id'),1000,false)");
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  const service = (peer: SequenceRunnerPeer) => new AdminProductEnsureService(createContainerFromDb(peer.db));
  const core = (db: DbClient) => new ProductExperienceService(createContainerFromDb(db));
  const product = (db: DbClient) => new ProductAssociationService(createContainerFromDb(db));
  async function login<T>(write: boolean, run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe owned LOGIN');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
      if (write) await f.exec(`GRANT INSERT,UPDATE,DELETE ON public.store_product_ensure TO "${peer.role}";
        GRANT INSERT ON public.system_log TO "${peer.role}";
        GRANT UPDATE ON public.system_admin,public.system_role TO "${peer.role}";
        GRANT UPDATE(id) ON public.system_menus TO "${peer.role}";
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${peer.role}"`);
      const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return run(peer);
    });
  }
  async function snapshot() {
    return { guarantees: await f.db.select().from(storeProductEnsure).orderBy(storeProductEnsure.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      relations: await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }
  async function productSnapshot(id = 80) {
    return { row: (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0],
      relations: await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.productId, id)).orderBy(storeProductRelation.id) };
  }
  async function seedProduct(id = 80) {
    await f.db.insert(storeProduct).values({ id, storeName: '原生保障商品', price: '19.50', stock: 8,
      ensureId: '', specs: '' });
  }
  async function guarantee(id = 10) {
    return (await f.db.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, id)))[0];
  }
  async function assertFenceWait(waiter: number, blocker: number) {
    await waitForFinanceBlock(f.db, waiter, blocker);
    const [row] = await f.exec(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${waiter} AND locktype='advisory' AND classid=731614::oid AND objid=0::oid AND NOT granted) AS waiting`) as unknown as Array<{ waiting: boolean }>;
    expect(row.waiting).toBe(true);
  }
  async function installHeldAudit() {
    await f.exec("CREATE FUNCTION hold_ensure_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731748,0); RETURN NEW; END $$; CREATE TRIGGER hold_ensure_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION hold_ensure_audit_fixture()");
  }

  it('reads exact page-1382 catalogs and both forms with SELECT-only LOGIN but refuses an unfenced SQL writer', async () => {
    await login(false, async reader => {
      expect((await service(reader).list(query(), ensureActor(105))).count).toBe(3);
      expect(await service(reader).all(query(), ensureActor(105))).toEqual([
        { id: 10, name: '无忧退' }, { id: 12, name: '破损保障' },
      ]);
      expect(await service(reader).createForm(query(), ensureActor(105))).toMatchObject({ method: 'POST' });
      expect(await service(reader).editForm(11, query(), ensureActor(105))).toMatchObject({ method: 'PUT' });
      const before = await snapshot();
      for (const id of [20, 21, 22, 30]) await expect(service(reader).detail(id, query(), ensureActor(105))).rejects.toThrow('不存在');
      await expect(service(reader).list(query(), ensureActor(106))).rejects.toThrow('权限');
      const result = await outcome(service(reader).create(ensureBody(), ensureActor()));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(hasCode(result.error, '42501')).toBe(true);
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('completes numeric-authority lifecycle with guarantee-only DML, INSERT-only audit and menu-id locking privilege', async () => {
    await login(true, async writer => {
      const [acl] = await writer.exec("SELECT has_column_privilege(current_user,'public.system_menus','id','UPDATE') AS menu_lock,has_column_privilege(current_user,'public.system_menus','api_url','UPDATE') AS menu_rewrite,has_table_privilege(current_user,'public.store_product','UPDATE') AS product_write,has_table_privilege(current_user,'public.system_log','UPDATE') AS rewrite_audit");
      expect(acl).toEqual({ menu_lock: true, menu_rewrite: false, product_write: false, rewrite_audit: false });
      await expect(writer.exec("UPDATE public.system_menus SET api_url='forged' WHERE id=1601")).rejects.toMatchObject({ code: '42501' });
      await expect(writer.exec("UPDATE public.store_product SET ensure_id='10'")).rejects.toMatchObject({ code: '42501' });
      const before = await snapshot();
      const created = await service(writer).create(ensureBody({ name: '原生完整保障' }), ensureActor(104));
      await service(writer).update(created.id, ensureBody({ name: '原生改名保障', sort: 5 }), ensureActor(104));
      await service(writer).setStatus(created.id, 0, query(), ensureActor(104));
      expect(await guarantee(created.id)).toMatchObject({ name: '原生改名保障', status: 0, sort: 5, type: 0, relationId: 0 });
      await service(writer).remove(created.id, query(), ensureActor(104));
      const after = await snapshot();
      expect(after.guarantees).toEqual(before.guarantees);
      expect(after.products).toEqual(before.products); expect(after.relations).toEqual(before.relations);
      expect(after.logs.map(row => row.method)).toEqual(['POST', 'PUT', 'PUT', 'DELETE']);
      expect(after.logs.map(row => JSON.parse(row.action).operation)).toEqual(['create', 'update', 'status', 'delete']);
      expect(after.logs.every(row => row.adminId === 104)).toBe(true);
    });
  }, 60000);

  it('orders a real core save before Admin deletion on 731614 and removes the committed row completely', async () => {
    // The first participant is the real core metadata writer. Two Admin writes
    // instead meet the authority table NOWAIT barrier before the business fence.
    await login(true, deleting => f.withPeer!(async saving => {
      const ready = signal(), release = signal();
      const held = outcome(saving.db.transaction(async tx => {
        await core(tx as unknown as DbClient).saveEnsure(owner, 10, ensureBody({ name: '先提交保障编辑' }));
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const removal = outcome(service(deleting).remove(10, query(), ensureActor()));
      try { await assertFenceWait(deleting.pid, saving.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await removal).ok).toBe(true);
      expect(await guarantee()).toBeUndefined();
      expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['DELETE']);
    }));
  }, 60000);

  it('orders a late Admin update after real core deletion and refuses the disappeared ID without resurrection or audit', async () => {
    await login(true, saving => f.withPeer!(async deleting => {
      const ready = signal(), release = signal();
      const held = outcome(deleting.db.transaction(async tx => {
        await core(tx as unknown as DbClient).deleteEnsure(owner, 10); ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const update = outcome(service(saving).update(10, ensureBody({ name: '迟到不得复建' }), ensureActor()));
      try { await assertFenceWait(saving.pid, deleting.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true);
      const result = await update; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('不存在');
      expect(await guarantee()).toBeUndefined(); expect(await f.db.select().from(systemLog)).toEqual([]);
    }));
  }, 60000);

  it('orders Admin status behind a real core save on the same 731614 fence and preserves the committed metadata', async () => {
    await login(true, disabling => f.withPeer!(async saving => {
      const ready = signal(), release = signal();
      const held = outcome(saving.db.transaction(async tx => {
        await core(tx as unknown as DbClient).saveEnsure(owner, 10, ensureBody({ name: '先编辑后停用保障', sort: 8 }));
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const disable = outcome(service(disabling).setStatus(10, 0, query(), ensureActor()));
      try { await assertFenceWait(disabling.pid, saving.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await disable).ok).toBe(true);
      expect(await guarantee()).toMatchObject({ name: '先编辑后停用保障', sort: 8, status: 0 });
      const logs = await f.db.select().from(systemLog);
      expect(logs).toHaveLength(1); expect(JSON.parse(logs[0].action)).toEqual({ operation: 'status', id: 10, status: 0 });
    }));
  }, 60000);

  it('waits for the actual product writer SHARE lock then protects its committed CSV and type-5 guarantee relation', async () => {
    await seedProduct();
    await login(true, deleting => f.withPeer!(async saving => {
      const ready = signal(), release = signal();
      let savedRow: typeof storeProduct.$inferSelect | undefined;
      const held = outcome(saving.db.transaction(async tx => {
        expect((await product(tx as unknown as DbClient).save(80, { ensure_id: [10] }, productActor)).associations_verified).toBe(true);
        [savedRow] = await tx.select().from(storeProduct).where(eq(storeProduct.id, 80));
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const removal = outcome(service(deleting).remove(10, query(), ensureActor()));
      try { await waitForFinanceBlock(f.db, deleting.pid, saving.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true);
      const result = await removal; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('使用');
      const current = await productSnapshot(); expect(current.row).toEqual(savedRow);
      expect(current.row).toMatchObject({ ensureId: '10', price: '19.50', stock: 8 });
      expect(current.relations).toHaveLength(1);
      expect(current.relations[0]).toMatchObject({ productId: 80, relationId: 10, type: 5 });
      expect(await guarantee()).toMatchObject({ status: 1 });
      expect((await f.db.select().from(systemLog)).map(row => row.type)).toEqual(['product']);
    }));
  }, 60000);

  it('holds a late real product binding until deletion and its audit commit then preserves the prior guarantee reference', async () => {
    await seedProduct();
    await product(f.db).save(80, { ensure_id: [12] }, productActor);
    const before = await productSnapshot(); const logsBefore = await f.db.select().from(systemLog);
    await installHeldAudit();
    await login(true, deleting => f.withPeer!(async blocker => f.withPeer!(async saving => {
      await blocker.exec('SELECT pg_advisory_lock(731748,0)');
      const removal = outcome(service(deleting).remove(10, query(), ensureActor()));
      let binding: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, deleting.pid, blocker.pid);
        binding = outcome(product(saving.db).save(80, { ensure_id: [10] }, productActor));
        await waitForFinanceBlock(f.db, saving.pid, deleting.pid);
        expect(await productSnapshot()).toEqual(before);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731748,0)'); }
      expect((await removal).ok).toBe(true);
      const result = await binding!; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('保障服务不存在');
      expect(await guarantee()).toBeUndefined(); expect(await productSnapshot()).toEqual(before);
      expect(before.row.ensureId).toBe('12'); expect(before.relations[0]).toMatchObject({ relationId: 12, type: 5 });
      const logs = await f.db.select().from(systemLog).orderBy(systemLog.id);
      expect(logs).toHaveLength(logsBefore.length + 1); expect(logs.at(-1)).toMatchObject({ method: 'DELETE', type: 'product_ensure_catalog' });
    })));
  }, 60000);

  it('orders disable after an actual product binding and retains the committed reference while allowing later historical edits', async () => {
    await seedProduct();
    await login(true, disabling => f.withPeer!(async saving => {
      const ready = signal(), release = signal();
      let savedRow: typeof storeProduct.$inferSelect | undefined;
      const held = outcome(saving.db.transaction(async tx => {
        await product(tx as unknown as DbClient).save(80, { ensure_id: [10] }, productActor);
        [savedRow] = await tx.select().from(storeProduct).where(eq(storeProduct.id, 80));
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const disable = outcome(service(disabling).setStatus(10, 0, query(), ensureActor()));
      try { await waitForFinanceBlock(f.db, disabling.pid, saving.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await disable).ok).toBe(true);
      expect(await guarantee()).toMatchObject({ status: 0 });
      const before = await productSnapshot(); expect(before.row).toEqual(savedRow);
      expect(before.relations[0]).toMatchObject({ productId: 80, relationId: 10, type: 5 });
      await product(saving.db).save(80, { ensure_id: [10], store_name: '历史停用保障仍可编辑商品' }, productActor);
      const after = await productSnapshot(); expect(after.row.ensureId).toBe('10');
      expect(after.row.storeName).toBe('历史停用保障仍可编辑商品');
      expect(after.relations.map(row => ({ relationId: row.relationId, type: row.type }))).toEqual([{ relationId: 10, type: 5 }]);
      expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row => row.type)).toEqual(['product', 'product_ensure_catalog', 'product']);
    }));
  }, 60000);

  it('holds a late actual new product binding until disable commits then rejects the inactive guarantee without changing existing references', async () => {
    await seedProduct(); await product(f.db).save(80, { ensure_id: [12] }, productActor);
    const before = await productSnapshot(); const logsBefore = await f.db.select().from(systemLog);
    await installHeldAudit();
    await login(true, disabling => f.withPeer!(async blocker => f.withPeer!(async saving => {
      await blocker.exec('SELECT pg_advisory_lock(731748,0)');
      const disable = outcome(service(disabling).setStatus(10, 0, query(), ensureActor()));
      let binding: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, disabling.pid, blocker.pid);
        binding = outcome(product(saving.db).save(80, { ensure_id: [10] }, productActor));
        await waitForFinanceBlock(f.db, saving.pid, disabling.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731748,0)'); }
      expect((await disable).ok).toBe(true);
      const result = await binding!; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('保障服务已停用，不能新绑定');
      expect(await guarantee()).toMatchObject({ status: 0 }); expect(await productSnapshot()).toEqual(before);
      const logs = await f.db.select().from(systemLog).orderBy(systemLog.id);
      expect(logs).toHaveLength(logsBefore.length + 1); expect(JSON.parse(logs.at(-1)!.action)).toEqual({ operation: 'status', id: 10, status: 0 });
    })));
  }, 60000);

  it('reaches the native rejecting audit on create, update, status and delete and rolls back every business effect', async () => {
    await f.exec("CREATE FUNCTION reject_ensure_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'guarantee audit refused'; END $$; CREATE TRIGGER reject_ensure_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_ensure_audit_fixture()");
    const before = await snapshot();
    await login(true, async writer => {
      for (const write of [
        () => service(writer).create(ensureBody({ name: '审计拒绝新增' }), ensureActor()),
        () => service(writer).update(10, ensureBody({ name: '审计拒绝编辑' }), ensureActor()),
        () => service(writer).setStatus(10, 0, query(), ensureActor()),
        () => service(writer).remove(10, query(), ensureActor()),
      ]) {
        const result = await outcome(write()); expect(result.ok).toBe(false);
        if (!result.ok) expect(hasCode(result.error, 'P0001')).toBe(true);
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('proves the skipped audit trigger was reached for every mutation and refuses all zero-row receipts atomically', async () => {
    await f.exec("CREATE SEQUENCE native_ensure_audit_probe START 1000; CREATE FUNCTION skip_ensure_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('native_ensure_audit_probe'); RETURN NULL; END $$; CREATE TRIGGER skip_ensure_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_ensure_audit_fixture()");
    const before = await snapshot();
    await login(true, async writer => {
      const writes = [
        () => service(writer).create(ensureBody({ name: '跳过审计新增' }), ensureActor()),
        () => service(writer).update(10, ensureBody({ name: '跳过审计编辑' }), ensureActor()),
        () => service(writer).setStatus(10, 0, query(), ensureActor()),
        () => service(writer).remove(10, query(), ensureActor()),
      ];
      for (let index = 0; index < writes.length; index++) {
        await expect(writes[index]()).rejects.toThrow('审计');
        // Sequence calls are deliberately nontransactional test instrumentation:
        // they prove this exact system_log trigger ran even though DML rolled back.
        const [probe] = await f.exec('SELECT last_value,is_called FROM native_ensure_audit_probe') as unknown as Array<{ last_value: string | number; is_called: boolean }>;
        expect(probe.is_called).toBe(true); expect(Number(probe.last_value)).toBe(1000 + index);
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('orders current-role revocation after the waiting authenticated write then refuses all later writes', async () => {
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      await blocker.exec('SELECT pg_advisory_lock(731614,0)');
      const creation = outcome(service(writer).create(ensureBody({ name: '撤权前真实提交' }), ensureActor()));
      let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await assertFenceWait(writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731614,0)'); }
      expect((await creation).ok).toBe(true); expect((await revocation!).ok).toBe(true);
      expect((await f.db.select().from(systemRole).where(eq(systemRole.id, 1)))[0].rules).toBe('product.view');
      const before = await snapshot();
      await expect(service(writer).create(ensureBody({ name: '已撤权不可新增' }), ensureActor())).rejects.toThrow('权限');
      await expect(service(writer).setStatus(10, 0, query(), ensureActor())).rejects.toThrow('权限');
      await expect(service(writer).remove(10, query(), ensureActor())).rejects.toThrow('权限');
      expect(await snapshot()).toEqual(before); expect(before.logs).toHaveLength(1);
    })));
  }, 60000);

  it('locks the synthetic current API menu decision through the 731614 wait and commits before its exact menu revoke', async () => {
    await f.db.update(systemRole).set({ rules: '1601' }).where(eq(systemRole.id, 4));
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      await blocker.exec('SELECT pg_advisory_lock(731614,0)');
      const creation = outcome(service(writer).create(ensureBody({ name: '菜单撤权前提交' }), ensureActor(104)));
      let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await assertFenceWait(writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 1601)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731614,0)'); }
      expect((await creation).ok).toBe(true); expect((await revocation!).ok).toBe(true);
      expect((await f.db.select().from(systemMenus).where(eq(systemMenus.id, 1601)))[0].access).toBe(0);
      const before = await snapshot();
      await expect(service(writer).create(ensureBody({ name: '菜单撤权后禁止' }), ensureActor(104))).rejects.toThrow('权限');
      expect(await snapshot()).toEqual(before); expect(before.logs).toHaveLength(1);
    })));
  }, 60000);

  it('rolls back update and audit when the original authenticated session expires during a proven business-fence wait', async () => {
    const before = await snapshot();
    await login(true, writer => f.withPeer!(async blocker => {
      await blocker.exec('SELECT pg_advisory_lock(731614,0)');
      const actor = { ...ensureActor(), expiresAt: Math.ceil((Date.now() + 250) / 1000) };
      const update = outcome(service(writer).update(10, ensureBody({ name: '过期保障编辑' }), actor));
      try { await assertFenceWait(writer.pid, blocker.pid); await waitForFinanceClock(f.db, actor.expiresAt * 1000); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731614,0)'); }
      const result = await update; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('过期');
      expect(await snapshot()).toEqual(before);
    }));
  }, 60000);
});
