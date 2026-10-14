import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { legacyCategory, storeProduct, storeProductRelation, storeProductSpecs, systemLog, systemMenus, systemRole } from '@/models/schema';
import { AdminProductSpecsService } from '@/services/admin/AdminProductSpecsService';
import { ProductMetadataService } from '@/services/product/ProductMetadataService';
import { ProductAssociationService } from '@/services/product/ProductAssociationService';
import { specsActor, specsBody, specsSchema, seedProductSpecs } from './helpers/adminProductSpecs';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
const owner = { type: 0, relationId: 0 } as const;
const emptyQuery = () => new URLSearchParams();
const productActor = { id: 101, name: 'native specs fixture', ip: '127.0.0.1' };
const parameterSnapshot = [{ name: '性能', value: '商品独立填写值', sort: 7, status: 1 }];
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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('product parameter templates on independent PG16 LOGINs and actual product writers', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(specsSchema))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native parameter fixture forbids external I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Independent PG16 LOGIN peers required');
    await f.exec(ddl);
    await seedProductSpecs(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('category','id'),1000,false); SELECT setval(pg_get_serial_sequence('store_product_specs','id'),1000,false)");
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  const service = (peer: SequenceRunnerPeer) => new AdminProductSpecsService(createContainerFromDb(peer.db));
  const metadata = (db: DbClient) => new ProductMetadataService(createContainerFromDb(db));
  const productService = (db: DbClient) => new ProductAssociationService(createContainerFromDb(db));
  async function login<T>(write: boolean, run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe owned LOGIN');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
      if (write) await f.exec(`GRANT INSERT,UPDATE,DELETE ON public.category,public.store_product_specs TO "${peer.role}";
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
    return {
      templates: await f.db.select().from(legacyCategory).orderBy(legacyCategory.id),
      parameters: await f.db.select().from(storeProductSpecs).orderBy(storeProductSpecs.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      relations: await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
    };
  }
  async function productSnapshot(id: number) {
    return { product: (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0],
      relations: await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.productId, id)).orderBy(storeProductRelation.id) };
  }
  async function assertNoOwnedTemplate(id: number) {
    expect(await f.db.select().from(legacyCategory).where(eq(legacyCategory.id, id))).toEqual([]);
    expect(await f.db.select().from(storeProductSpecs).where(and(eq(storeProductSpecs.tempId, id),
      eq(storeProductSpecs.type, 0), eq(storeProductSpecs.relationId, 0)))).toEqual([]);
  }
  async function seedProduct(id = 80) {
    await f.db.insert(storeProduct).values({ id, storeName: '原生参数商品', price: '19.50', stock: 8, specs: '' });
  }

  it('reads owned templates with SELECT-only LOGIN and rejects an unfenced write without any business effects', async () => {
    await login(false, async peer => {
      expect((await service(peer).list(emptyQuery(), specsActor(102))).count).toBe(3);
      expect((await service(peer).all(emptyQuery(), specsActor(105))).map(row => row.id).sort()).toEqual([10, 11, 12]);
      const detail = await service(peer).detail(10, emptyQuery(), specsActor(102), false);
      expect(detail.id).toBe(10);
      expect(detail.specs.map(row => row.id).sort()).toEqual([100, 101]);
      const [acl] = await peer.exec("SELECT has_table_privilege(current_user,'public.category','SELECT') AS reads,has_table_privilege(current_user,'public.category','UPDATE') AS writes,has_table_privilege(current_user,'public.system_admin','UPDATE') AS authority_writes");
      expect(acl).toEqual({ reads: true, writes: false, authority_writes: false });
      const before = await snapshot();
      const result = await outcome(service(peer).save(0, specsBody(), specsActor()));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(hasCode(result.error, '42501')).toBe(true);
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('completes create, rebuild and delete with minimum catalog DML and menu-id row locks', async () => {
    await login(true, async peer => {
      const [acl] = await peer.exec("SELECT has_column_privilege(current_user,'public.system_menus','id','UPDATE') AS menu_lock,has_column_privilege(current_user,'public.system_menus','api_url','UPDATE') AS menu_rewrite,has_table_privilege(current_user,'public.store_product','UPDATE') AS product_write,has_table_privilege(current_user,'public.system_log','UPDATE') AS rewrite_audit");
      expect(acl).toEqual({ menu_lock: true, menu_rewrite: false, product_write: false, rewrite_audit: false });
      await expect(peer.exec("UPDATE public.system_menus SET api_url='forged'" )).rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec('UPDATE public.store_product SET specs_id=10')).rejects.toMatchObject({ code: '42501' });
      const before = await snapshot();
      const created = await service(peer).save(0, specsBody({ name: '原生完整生命周期' }), specsActor(104));
      const originalChildren = await f.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, created.id));
      const displayed = await service(peer).detail(created.id, emptyQuery(), specsActor(104));
      await service(peer).save(created.id, { ...displayed, name: '原生编辑', specs: [
        { ...displayed.specs[0], name: '宽度', value: '10cm', sort: 5, status: 1 },
        { name: '说明', value: '隐藏说明', sort: 0, status: 0 },
      ] }, specsActor(104));
      const children = await f.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, created.id)).orderBy(storeProductSpecs.id);
      expect(children.map(row => row.name)).toEqual(['宽度', '说明']);
      expect(children.every(row => row.type === 0 && row.relationId === 0 && !originalChildren.some(old => old.id === row.id))).toBe(true);
      await service(peer).remove(created.id, emptyQuery(), specsActor(104));
      await assertNoOwnedTemplate(created.id);
      const after = await snapshot();
      expect(after.templates).toEqual(before.templates);
      expect(after.parameters).toEqual(before.parameters);
      expect(after.products).toEqual(before.products);
      expect(after.relations).toEqual(before.relations);
      expect(after.logs.map(row => row.method)).toEqual(['POST', 'POST', 'DELETE']);
      expect(after.logs.every(row => row.adminId === 104)).toBe(true);
    });
  }, 60000);

  it('filters mismatched parameter rows and refuses native rebuild without changing any owner data', async () => {
    await f.db.insert(storeProductSpecs).values([
      { id: 120, tempId: 10, type: 2, relationId: 20, name: '供应商污染', value: '秘密' },
      { id: 121, tempId: 10, type: 0, relationId: 99, name: '异常平台污染', value: '秘密' },
    ]);
    await login(true, async peer => {
      const detail = await service(peer).detail(10, emptyQuery(), specsActor(), false);
      expect(detail.specs.map(row => row.id).sort()).toEqual([100, 101]);
      expect((await service(peer).all(emptyQuery(), specsActor())).find(row => row.id === 10)?.specs.map(row => row.id)).toEqual([100]);
      const before = await snapshot();
      await expect(service(peer).save(10, specsBody({ name: '不能重建混合owner' }), specsActor())).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      for (const id of [20, 21, 30, 40]) {
        await expect(service(peer).detail(id, emptyQuery(), specsActor(), false)).rejects.toThrow('不存在');
        await expect(service(peer).remove(id, emptyQuery(), specsActor())).rejects.toThrow('不存在');
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('filters the actual product editor options by parent ownership and every active child scope with a SELECT-only LOGIN', async () => {
    await f.db.insert(storeProductSpecs).values([
      { id: 120, tempId: 10, type: 2, relationId: 20, name: '供应商污染', value: '秘密' },
      { id: 121, tempId: 10, type: 0, relationId: 99, name: '异常平台污染', value: '秘密' },
    ]);
    const before = await snapshot();
    await login(false, async reader => {
      const options = await productService(reader.db).editorOptions();
      expect(options.parameter_templates.map(row => row.id).sort()).toEqual([10, 11]);
      expect(options.parameter_templates.find(row => row.id === 10)?.specs).toEqual([
        { id: 100, temp_id: 10, name: '壳材', value: '塑料', sort: 9, status: 1 },
      ]);
      expect(options.parameter_templates.find(row => row.id === 11)?.specs).toEqual([
        { id: 102, temp_id: 11, name: '性能', value: '稳固', sort: 1, status: 1 },
      ]);
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('serializes a completed metadata rebuild before Admin deletion on the exact 731613 fence without orphan parameters', async () => {
    // Two Admin mutations intentionally fail fast at the authority table
    // barrier. This exercises the shared metadata fence with an earlier real
    // metadata writer and a later fully authorized/audited Admin mutation.
    await login(true, deleting => f.withPeer!(async writer => {
      const ready = signal(), release = signal();
      const held = outcome(writer.db.transaction(async tx => {
        await metadata(tx as unknown as DbClient).saveSpecTemplate(owner, 11, specsBody({ name: '原生先重建' }));
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const removal = outcome(service(deleting).remove(11, emptyQuery(), specsActor()));
      try {
        await waitForFinanceBlock(f.db, deleting.pid, writer.pid);
        const [lock] = await f.exec(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${deleting.pid} AND locktype='advisory' AND classid=731613::oid AND objid=0::oid AND NOT granted) AS waiting`) as unknown as Array<{ waiting: boolean }>;
        expect(lock.waiting).toBe(true);
      } finally { release.resolve(); }
      expect((await held).ok).toBe(true);
      expect((await removal).ok).toBe(true);
      await assertNoOwnedTemplate(11);
      expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['DELETE']);
    }));
  }, 60000);

  it('orders Admin save after metadata deletion on 731613 and rejects the disappeared ID instead of recreating children', async () => {
    await login(true, writer => f.withPeer!(async deleting => {
      const ready = signal(), release = signal();
      const held = outcome(deleting.db.transaction(async tx => {
        await metadata(tx as unknown as DbClient).deleteSpecTemplate(owner, 11);
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const saving = outcome(service(writer).save(11, specsBody({ name: '迟到重建' }), specsActor()));
      try {
        await waitForFinanceBlock(f.db, writer.pid, deleting.pid);
        const [lock] = await f.exec(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${writer.pid} AND locktype='advisory' AND classid=731613::oid AND objid=0::oid AND NOT granted) AS waiting`) as unknown as Array<{ waiting: boolean }>;
        expect(lock.waiting).toBe(true);
      } finally { release.resolve(); }
      expect((await held).ok).toBe(true);
      const result = await saving;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('不存在');
      await assertNoOwnedTemplate(11);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    }));
  }, 60000);

  it('waits for the actual product writer SHARE lock then refuses template deletion while retaining its independent snapshot and type-6 relation', async () => {
    await seedProduct();
    await login(true, deleting => f.withPeer!(async writer => {
      const ready = signal(), release = signal();
      let committedProduct: typeof storeProduct.$inferSelect | undefined;
      const held = outcome(writer.db.transaction(async tx => {
        const result = await productService(tx as unknown as DbClient).save(80, { specs_id: 11, specs: parameterSnapshot }, productActor);
        expect(result.associations_verified).toBe(true);
        [committedProduct] = await tx.select().from(storeProduct).where(eq(storeProduct.id, 80));
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const removal = outcome(service(deleting).remove(11, emptyQuery(), specsActor()));
      try {
        await waitForFinanceBlock(f.db, deleting.pid, writer.pid);
        const [lock] = await f.exec(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${deleting.pid} AND locktype='advisory' AND classid=731613::oid AND objid=0::oid AND granted) AS lifecycle_held`) as unknown as Array<{ lifecycle_held: boolean }>;
        expect(lock.lifecycle_held).toBe(true);
      } finally { release.resolve(); }
      expect((await held).ok).toBe(true);
      const result = await removal;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('使用');
      const current = await productSnapshot(80);
      expect(current.product).toEqual(committedProduct);
      expect(current.product).toMatchObject({ specsId: 11, specs: JSON.stringify(parameterSnapshot), price: '19.50', stock: 8 });
      expect(current.relations).toHaveLength(1);
      expect(current.relations[0]).toMatchObject({ productId: 80, relationId: 11, type: 6 });
      expect((await f.db.select().from(legacyCategory).where(eq(legacyCategory.id, 11)))).toHaveLength(1);
      expect((await f.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, 11))).map(row => row.id)).toEqual([102]);
      expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['POST']);
    }));
  }, 60000);

  it('holds a late actual product binding until the template and atomic delete audit commit then retains the prior snapshot and relation', async () => {
    await seedProduct();
    // Establish the pre-existing binding through the production services too,
    // so the late refusal must preserve a real earlier snapshot and relation.
    let previousTemplate = 0;
    await login(true, async setup => {
      previousTemplate = (await service(setup).save(0, specsBody({ name: '商品原有参数模板' }), specsActor())).id;
    });
    await productService(f.db).save(80, { specs_id: previousTemplate,
      specs: [{ name: '材质', value: '商品原有自选值', sort: 4, status: 1 }] }, productActor);
    const before = await productSnapshot(80);
    const logsBefore = await f.db.select().from(systemLog);
    await f.exec("CREATE FUNCTION hold_specs_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731746,0); RETURN NEW; END $$; CREATE TRIGGER hold_specs_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION hold_specs_audit_fixture()");
    await login(true, deleting => f.withPeer!(async blocker => f.withPeer!(async writer => {
      expect(new Set([deleting.pid, blocker.pid, writer.pid]).size).toBe(3);
      await blocker.exec('SELECT pg_advisory_lock(731746,0)');
      const removal = outcome(service(deleting).remove(11, emptyQuery(), specsActor()));
      let binding: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, deleting.pid, blocker.pid);
        binding = outcome(productService(writer.db).save(80, { specs_id: 11, specs: parameterSnapshot }, productActor));
        await waitForFinanceBlock(f.db, writer.pid, deleting.pid);
        expect(await productSnapshot(80)).toEqual(before);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731746,0)'); }
      expect((await removal).ok).toBe(true);
      const result = await binding!;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('参数模板不存在');
      await assertNoOwnedTemplate(11);
      expect(await productSnapshot(80)).toEqual(before);
      expect(before.product).toMatchObject({ specsId: previousTemplate,
        specs: JSON.stringify([{ name: '材质', value: '商品原有自选值', sort: 4, status: 1 }]) });
      expect(before.relations[0]).toMatchObject({ productId: 80, type: 6, relationId: previousTemplate });
      const logs = await f.db.select().from(systemLog).orderBy(systemLog.id);
      expect(logs).toHaveLength(logsBefore.length + 1);
      expect(logs.at(-1)).toMatchObject({ adminId: 101, method: 'DELETE' });
    })));
  }, 60000);

  it('rolls back parent, rebuilt children and deletion when a native audit trigger rejects the receipt', async () => {
    await f.exec("CREATE FUNCTION reject_specs_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'parameter audit refused'; END $$; CREATE TRIGGER reject_specs_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_specs_audit_fixture()");
    const before = await snapshot();
    await login(true, async peer => {
      for (const write of [
        () => service(peer).save(0, specsBody({ name: '审计拒绝创建' }), specsActor()),
        () => service(peer).save(11, specsBody({ name: '审计拒绝重建' }), specsActor()),
        () => service(peer).remove(11, emptyQuery(), specsActor()),
      ]) {
        const result = await outcome(write());
        expect(result.ok).toBe(false);
        // Only the fixture's system_log trigger raises P0001. Permission or
        // validation failures before the audit cannot satisfy this assertion.
        if (!result.ok) expect(hasCode(result.error, 'P0001')).toBe(true);
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('orders current-role revocation after the fenced write and refuses every later mutation', async () => {
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      await blocker.exec('SELECT pg_advisory_lock(731613,0)');
      const saving = outcome(service(writer).save(0, specsBody({ name: '撤权前原生提交' }), specsActor()));
      let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731613,0)'); }
      expect((await saving).ok).toBe(true);
      expect((await revocation!).ok).toBe(true);
      const before = await snapshot();
      await expect(service(writer).save(0, specsBody({ name: '撤权后不得创建' }), specsActor())).rejects.toThrow('权限');
      await expect(service(writer).remove(11, emptyQuery(), specsActor())).rejects.toThrow('权限');
      expect(await snapshot()).toEqual(before);
      expect(before.logs).toHaveLength(1);
    })));
  }, 60000);

  it('holds the exact numeric API menu row through a business wait and orders its revocation after the current receipt', async () => {
    await f.db.update(systemRole).set({ rules: '1501' }).where(eq(systemRole.id, 4));
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      await blocker.exec('SELECT pg_advisory_lock(731613,0)');
      const saving = outcome(service(writer).save(0, specsBody({ name: '菜单撤权前原生提交' }), specsActor(104)));
      let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 1501)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731613,0)'); }
      expect((await saving).ok).toBe(true);
      expect((await revocation!).ok).toBe(true);
      const before = await snapshot();
      await expect(service(writer).save(0, specsBody({ name: '菜单撤权后不得创建' }), specsActor(104))).rejects.toThrow('权限');
      expect(await snapshot()).toEqual(before);
      expect(before.logs).toHaveLength(1);
      expect(before.logs[0].adminId).toBe(104);
    })));
  }, 60000);

  it('rolls back the full rebuild and audit if the authenticated session expires during a proven native lock wait', async () => {
    const before = await snapshot();
    await login(true, writer => f.withPeer!(async blocker => {
      await blocker.exec('SELECT pg_advisory_lock(731613,0)');
      const actor = { ...specsActor(), expiresAt: Math.ceil((Date.now() + 250) / 1000) };
      const saving = outcome(service(writer).save(11, specsBody({ name: '过期重建' }), actor));
      try {
        await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        await waitForFinanceClock(f.db, actor.expiresAt * 1000);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731613,0)'); }
      const result = await saving;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('过期');
      expect(await snapshot()).toEqual(before);
    }));
  }, 60000);
});
