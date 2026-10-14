import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProductRule, storeProduct, storeProductAttr, storeProductAttrValue,
  storeProductAttrResult, storeProductStockRecord, systemLog, systemRole, systemMenus } from '@/models/schema';
import { AdminProductRuleService } from '@/services/admin/AdminProductRuleService';
import { ProductMetadataService } from '@/services/product/ProductMetadataService';
import { ProductAssociationService } from '@/services/product/ProductAssociationService';
import { ruleActor, ruleBody, ruleSchema, seedRules } from './helpers/adminProductRules';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
const owner = { type: 0, relationId: 0 } as const;
const query = () => new URLSearchParams();
const productActor = { id: 101, name: 'native SKU rule fixture', ip: '127.0.0.1' };
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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin SKU rule catalogs on independent PG16 LOGINs and real copied-SKU consumers', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(ruleSchema))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native SKU rule fixture forbids external I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Independent PG16 LOGIN peers required');
    await f.exec(ddl); await seedRules(f.db);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_rule','id'),1000,false)");
    await f.exec('ALTER TABLE store_product_description ADD UNIQUE(product_id,type)');
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  const service = (peer: SequenceRunnerPeer) => new AdminProductRuleService(createContainerFromDb(peer.db));
  const core = (db: DbClient) => new ProductMetadataService(createContainerFromDb(db));
  const product = (db: DbClient) => new ProductAssociationService(createContainerFromDb(db));
  const remove = (peer: SequenceRunnerPeer, id = 10, actor = ruleActor()) => service(peer).remove(id, query(), undefined, actor);
  async function login<T>(write: boolean, run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe owned LOGIN');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}"`);
      if (write) await f.exec(`GRANT INSERT,UPDATE,DELETE ON public.store_product_rule TO "${peer.role}";
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
    return { rules: await f.db.select().from(storeProductRule).orderBy(storeProductRule.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      dimensions: await f.db.select().from(storeProductAttr).orderBy(storeProductAttr.id),
      values: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
      results: await f.db.select().from(storeProductAttrResult).orderBy(storeProductAttrResult.id),
      stockRecords: await f.db.select().from(storeProductStockRecord).orderBy(storeProductStockRecord.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }
  async function productSnapshot(id: number) {
    return { row: (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0],
      dimensions: await f.db.select().from(storeProductAttr).where(eq(storeProductAttr.productId, id)).orderBy(storeProductAttr.id),
      values: await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, id)).orderBy(storeProductAttrValue.id),
      results: await f.db.select().from(storeProductAttrResult).where(eq(storeProductAttrResult.productId, id)).orderBy(storeProductAttrResult.id),
      stockRecords: await f.db.select().from(storeProductStockRecord).where(eq(storeProductStockRecord.productId, id)).orderBy(storeProductStockRecord.id) };
  }
  async function rule(id = 10) {
    return (await f.db.select().from(storeProductRule).where(eq(storeProductRule.id, id)))[0];
  }
  async function assertFenceWait(waiter: number, blocker: number) {
    await waitForFinanceBlock(f.db, waiter, blocker);
    const [row] = await f.exec(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${waiter} AND locktype='advisory' AND classid=731612::oid AND objid=0::oid AND NOT granted) AS waiting`) as unknown as Array<{ waiting: boolean }>;
    expect(row.waiting).toBe(true);
  }
  async function installHeldAudit() {
    await f.exec("CREATE FUNCTION hold_rule_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='product_rule_catalog' THEN PERFORM pg_advisory_xact_lock(731749,0); END IF; RETURN NEW; END $$; CREATE TRIGGER hold_rule_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW WHEN (NEW.type='product_rule_catalog' AND NEW.path=('product/product/rule/' || (NEW.action::jsonb->>'id'))) EXECUTE FUNCTION hold_rule_audit_fixture()");
  }
  async function assertProbe(name: 'native_rule_audit_probe' | 'native_rule_dml_probe', index: number) {
    const [probe] = await f.exec(`SELECT last_value,is_called FROM ${name}`) as unknown as Array<{ last_value: string | number; is_called: boolean }>;
    expect(probe.is_called).toBe(true); expect(Number(probe.last_value)).toBe(1000 + index);
  }
  const mutationBodies = () => [
    ruleBody({ rule_name: '原生审计新增' }), ruleBody({ rule_name: '原生审计编辑' }),
  ];
  function mutations(writer: SequenceRunnerPeer) {
    const bodies = mutationBodies();
    return [() => service(writer).save(0, bodies[0], ruleActor()),
      () => service(writer).save(10, bodies[1], ruleActor()), () => remove(writer)];
  }

  it('reads exact page-99 and API-menu catalogs with SELECT-only LOGIN and rejects wildcard580 or a SQL writer', async () => {
    await login(false, async reader => {
      for (const id of [105, 106]) {
        const actor = ruleActor(id);
        expect((await service(reader).list(query(), actor)).count).toBe(2);
        expect((await service(reader).templates(query(), actor)).map(row => row.id)).toEqual([11, 10]);
        expect((await service(reader).detail(10, query(), actor)).info).toMatchObject({ id: 10, type: 0, relation_id: 0 });
      }
      const before = await snapshot();
      for (const id of [20, 21, 22, 30]) await expect(service(reader).detail(id, query(), ruleActor(106))).rejects.toThrow('不存在');
      await expect(service(reader).list(query(), ruleActor(107))).rejects.toThrow('权限');
      await expect(reader.exec("UPDATE store_product_rule SET rule_name='未授权SQL' WHERE id=10")).rejects.toMatchObject({ code: '42501' });
      const result = await outcome(service(reader).save(0, ruleBody(), ruleActor()));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(hasCode(result.error, '42501')).toBe(true);
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('completes exact numeric-writer lifecycle with rule-only DML, INSERT-only audit and menu-id locking privilege', async () => {
    await login(true, async writer => {
      const [acl] = await writer.exec("SELECT has_column_privilege(current_user,'public.system_menus','id','UPDATE') AS menu_lock,has_column_privilege(current_user,'public.system_menus','api_url','UPDATE') AS menu_rewrite,has_table_privilege(current_user,'public.store_product','UPDATE') AS product_write,has_table_privilege(current_user,'public.system_log','UPDATE') AS rewrite_audit");
      expect(acl).toEqual({ menu_lock: true, menu_rewrite: false, product_write: false, rewrite_audit: false });
      await expect(writer.exec("UPDATE public.system_menus SET api_url='forged' WHERE id=195")).rejects.toMatchObject({ code: '42501' });
      await expect(writer.exec("UPDATE public.store_product SET store_name='forged'")).rejects.toMatchObject({ code: '42501' });
      const before = await snapshot();
      const created = await service(writer).save(0, ruleBody({ rule_name: '原生完整规格' }), ruleActor(104));
      await service(writer).save(created.id, ruleBody({ rule_name: '原生改名规格' }), ruleActor(104));
      expect(await rule(created.id)).toMatchObject({ ruleName: '原生改名规格', type: 0, relationId: 0 });
      await remove(writer, created.id, ruleActor(104));
      const after = await snapshot();
      expect(after.rules).toEqual(before.rules); expect(after.products).toEqual(before.products);
      expect(after.dimensions).toEqual(before.dimensions); expect(after.values).toEqual(before.values);
      expect(after.results).toEqual(before.results); expect(after.stockRecords).toEqual(before.stockRecords);
      expect(after.logs.map(row => row.method)).toEqual(['POST', 'POST', 'DELETE']);
      expect(after.logs.map(row => JSON.parse(row.action).operation)).toEqual(['create', 'update', 'delete']);
      expect(after.logs.every(row => row.adminId === 104 && row.type === 'product_rule_catalog')).toBe(true);
      expect(after.logs.every(row => row.path === `product/product/rule/${created.id}`
        && row.page === '商品规格模板管理' && JSON.parse(row.action).id === created.id)).toBe(true);
    });
  }, 60000);

  it('orders a real core save before Admin deletion on731612 and deletes its committed template', async () => {
    // Core participates in the business fence directly. Two Admin writes can
    // instead meet the authority table NOWAIT barrier before reaching731612.
    await login(true, deleting => f.withPeer!(async saving => {
      const ready = signal(), release = signal();
      const held = outcome(saving.db.transaction(async tx => {
        await core(tx as unknown as DbClient).saveRule(owner, 10, ruleBody({ rule_name: '先提交规格编辑' }));
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const deletion = outcome(remove(deleting));
      try { await assertFenceWait(deleting.pid, saving.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await deletion).ok).toBe(true);
      expect(await rule()).toBeUndefined();
      expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['DELETE']);
    }));
  }, 60000);

  it('orders a late Admin edit after real core deletion and refuses the disappeared ID without resurrection or audit', async () => {
    await login(true, saving => f.withPeer!(async deleting => {
      const ready = signal(), release = signal();
      const held = outcome(deleting.db.transaction(async tx => {
        await core(tx as unknown as DbClient).deleteRule(owner, 10); ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const edit = outcome(service(saving).save(10, ruleBody({ rule_name: '迟到不得复建' }), ruleActor()));
      try { await assertFenceWait(saving.pid, deleting.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true);
      const result = await edit; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('不存在');
      expect(await rule()).toBeUndefined(); expect(await f.db.select().from(systemLog)).toEqual([]);
    }));
  }, 60000);

  it('holds real core deletion behind Admin save and its audit on the same731612 fence', async () => {
    await installHeldAudit();
    await login(true, saving => f.withPeer!(async blocker => f.withPeer!(async deleting => {
      await blocker.exec('SELECT pg_advisory_lock(731749,0)');
      const edit = outcome(service(saving).save(10, ruleBody({ rule_name: '管理员先提交规格' }), ruleActor()));
      let deletion: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, saving.pid, blocker.pid);
        deletion = outcome(core(deleting.db).deleteRule(owner, 10));
        await assertFenceWait(deleting.pid, saving.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731749,0)'); }
      expect((await edit).ok).toBe(true); expect((await deletion!).ok).toBe(true);
      expect(await rule()).toBeUndefined();
      const logs = await f.db.select().from(systemLog); expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0].action)).toEqual({ operation: 'update', id: 10 });
    })));
  }, 60000);

  it('holds a late real core edit behind Admin deletion and refuses the ID after its audited commit', async () => {
    await installHeldAudit();
    await login(true, deleting => f.withPeer!(async blocker => f.withPeer!(async saving => {
      await blocker.exec('SELECT pg_advisory_lock(731749,0)');
      const deletion = outcome(remove(deleting));
      let edit: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, deleting.pid, blocker.pid);
        edit = outcome(core(saving.db).saveRule(owner, 10, ruleBody({ rule_name: '迟到核心规格编辑' })));
        await assertFenceWait(saving.pid, deleting.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731749,0)'); }
      expect((await deletion).ok).toBe(true);
      const result = await edit!; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('不存在');
      expect(await rule()).toBeUndefined();
      const logs = await f.db.select().from(systemLog); expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0].action)).toEqual({ operation: 'delete', id: 10 });
    })));
  }, 60000);

  it('reaches the native P0001 audit trigger for create, edit and delete then rolls back every business effect', async () => {
    await f.exec("CREATE FUNCTION reject_rule_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SKU rule audit refused'; END $$; CREATE TRIGGER reject_rule_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW WHEN (NEW.type='product_rule_catalog' AND NEW.path=('product/product/rule/' || (NEW.action::jsonb->>'id'))) EXECUTE FUNCTION reject_rule_audit_fixture()");
    const before = await snapshot();
    await login(true, async writer => {
      for (const mutate of mutations(writer)) {
        const result = await outcome(mutate()); expect(result.ok).toBe(false);
        if (!result.ok) expect(hasCode(result.error, 'P0001')).toBe(true);
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('proves the skipped audit trigger was reached by all mutations and refuses zero-row receipts atomically', async () => {
    await f.exec("CREATE SEQUENCE native_rule_audit_probe START 1000; CREATE FUNCTION skip_rule_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('native_rule_audit_probe'); RETURN NULL; END $$; CREATE TRIGGER skip_rule_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW WHEN (NEW.type='product_rule_catalog' AND NEW.path=('product/product/rule/' || (NEW.action::jsonb->>'id'))) EXECUTE FUNCTION skip_rule_audit_fixture()");
    const before = await snapshot();
    await login(true, async writer => {
      const writes = mutations(writer);
      for (let index = 0; index < writes.length; index++) {
        await expect(writes[index]()).rejects.toThrow('审计');
        // Deliberately nontransactional instrumentation proves this trigger
        // actually ran, even though the mutation and audit are rolled back.
        await assertProbe('native_rule_audit_probe', index);
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('proves skipped catalog INSERT, UPDATE and DELETE never report success or commit an audit', async () => {
    await f.exec("CREATE SEQUENCE native_rule_dml_probe START 1000; CREATE FUNCTION skip_rule_dml_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('native_rule_dml_probe'); RETURN NULL; END $$; CREATE TRIGGER skip_rule_dml_fixture BEFORE INSERT OR UPDATE OR DELETE ON store_product_rule FOR EACH ROW EXECUTE FUNCTION skip_rule_dml_fixture()");
    const before = await snapshot();
    await login(true, async writer => {
      const writes = mutations(writer);
      for (let index = 0; index < writes.length; index++) {
        await expect(writes[index]()).rejects.toThrow('回执');
        await assertProbe('native_rule_dml_probe', index);
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('rejects post-insert audit-row tampering on every mutation under a writer without audit UPDATE privilege', async () => {
    await f.exec("CREATE SEQUENCE native_rule_audit_probe START 1000; CREATE FUNCTION tamper_rule_audit_fixture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('native_rule_audit_probe'); UPDATE system_log SET page='tampered SKU rule audit' WHERE id=NEW.id; RETURN NEW; END $$; CREATE TRIGGER tamper_rule_audit_fixture AFTER INSERT ON system_log FOR EACH ROW WHEN (NEW.type='product_rule_catalog' AND NEW.path=('product/product/rule/' || (NEW.action::jsonb->>'id'))) EXECUTE FUNCTION tamper_rule_audit_fixture()");
    const before = await snapshot();
    await login(true, async writer => {
      const [acl] = await writer.exec("SELECT has_table_privilege(current_user,'public.system_log','UPDATE') AS audit_update");
      expect(acl.audit_update).toBe(false);
      const writes = mutations(writer);
      for (let index = 0; index < writes.length; index++) {
        await expect(writes[index]()).rejects.toThrow('审计');
        await assertProbe('native_rule_audit_probe', index);
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('proves all platform audit identity rewrites roll back create/update/delete before and after INSERT with an INSERT-only audit LOGIN', async () => {
    await f.exec('CREATE SEQUENCE native_rule_audit_probe START 1000');
    const before = await snapshot();
    const columns = [['store_id', '73'], ['merchant_id', '91'], ['admin_name', "'forged-name'"],
      ['ip', "'203.0.113.73'"]] as const;
    let reached = 0;
    await login(true, async writer => {
      const [acl] = await writer.exec("SELECT has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,has_table_privilege(current_user,'public.system_log','UPDATE') AS audit_update");
      expect(acl).toMatchObject({ audit_insert: true, audit_update: false });
      await expect(writer.exec('UPDATE public.system_log SET store_id=73 WHERE false')).rejects.toMatchObject({ code: '42501' });
      for (const phase of ['BEFORE', 'AFTER'] as const) {
        for (const [column, value] of columns) {
          const effect = phase === 'BEFORE' ? `NEW.${column}=${value};` : `UPDATE public.system_log SET ${column}=${value} WHERE id=NEW.id;`;
          // Fixture-owned SECURITY DEFINER permits the AFTER trigger's tamper
          // while the real application LOGIN retains no audit UPDATE grant.
          await f.exec(`CREATE OR REPLACE FUNCTION rewrite_native_rule_audit_identity() RETURNS trigger LANGUAGE plpgsql
            SECURITY DEFINER SET search_path=public,pg_catalog AS $$ BEGIN PERFORM nextval('public.native_rule_audit_probe'); ${effect} RETURN NEW; END $$;
            CREATE TRIGGER rewrite_native_rule_audit_identity ${phase} INSERT ON public.system_log FOR EACH ROW
            WHEN (NEW.type='product_rule_catalog') EXECUTE FUNCTION rewrite_native_rule_audit_identity()`);
          try {
            const writes = [() => service(writer).save(0, ruleBody({ rule_name: `原生身份新增${reached}` }), ruleActor()),
              () => service(writer).save(10, ruleBody({ rule_name: `原生身份编辑${reached}` }), ruleActor()), () => remove(writer)];
            for (const mutate of writes) {
              await expect(mutate()).rejects.toThrow(phase === 'BEFORE' ? '审计回执不完整' : '审计回读不一致');
              // Native sequences are nontransactional: exact advancement
              // independently proves every negative actually hit the trigger.
              await assertProbe('native_rule_audit_probe', reached++);
              expect(await snapshot()).toEqual(before);
            }
          } finally { await f.exec('DROP TRIGGER IF EXISTS rewrite_native_rule_audit_identity ON public.system_log'); }
        }
      }
    });
    expect(reached).toBe(24);
  }, 60000);

  it('rolls back audit-side catalog rewrites on create/edit and forbidden template rebuilding on delete', async () => {
    await f.exec("CREATE SEQUENCE native_rule_audit_probe START 1000; CREATE FUNCTION tamper_rule_catalog_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE rule_id integer; operation text; BEGIN PERFORM nextval('native_rule_audit_probe'); rule_id=(NEW.action::jsonb->>'id')::integer; operation=NEW.action::jsonb->>'operation'; IF operation='delete' THEN INSERT INTO store_product_rule(id,type,relation_id,rule_name,rule_value) VALUES(rule_id,0,0,'审计重建规格','[]'); ELSE UPDATE store_product_rule SET rule_name='审计后非法改写' WHERE id=rule_id; END IF; RETURN NEW; END $$; CREATE TRIGGER tamper_rule_catalog_fixture AFTER INSERT ON system_log FOR EACH ROW WHEN (NEW.type='product_rule_catalog' AND NEW.path=('product/product/rule/' || (NEW.action::jsonb->>'id'))) EXECUTE FUNCTION tamper_rule_catalog_fixture()");
    const before = await snapshot();
    await login(true, async writer => {
      const writes = mutations(writer);
      for (let index = 0; index < writes.length; index++) {
        await expect(writes[index]()).rejects.toThrow('审计后');
        await assertProbe('native_rule_audit_probe', index);
        expect(await snapshot()).toEqual(before);
      }
    });
  }, 60000);

  it('orders current-role revocation after the waiting authenticated write and refuses all later mutations', async () => {
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      await blocker.exec('SELECT pg_advisory_lock(731612,0)');
      const creation = outcome(service(writer).save(0, ruleBody({ rule_name: '撤权前真实提交' }), ruleActor()));
      let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await assertFenceWait(writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731612,0)'); }
      expect((await creation).ok).toBe(true); expect((await revocation!).ok).toBe(true);
      expect((await f.db.select().from(systemRole).where(eq(systemRole.id, 1)))[0].rules).toBe('product.view');
      const before = await snapshot();
      for (const mutate of mutations(writer)) await expect(mutate()).rejects.toThrow('权限');
      expect(await snapshot()).toEqual(before); expect(before.logs).toHaveLength(1);
    })));
  }, 60000);

  it('locks exact numeric API195 authority through731612 waiting and commits before that menu revoke', async () => {
    await f.db.update(systemRole).set({ rules: '195' }).where(eq(systemRole.id, 4));
    await login(true, writer => f.withPeer!(async blocker => f.withPeer!(async revoking => {
      await blocker.exec('SELECT pg_advisory_lock(731612,0)');
      const creation = outcome(service(writer).save(0, ruleBody({ rule_name: '菜单撤权前提交' }), ruleActor(104)));
      let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await assertFenceWait(writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 195)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731612,0)'); }
      expect((await creation).ok).toBe(true); expect((await revocation!).ok).toBe(true);
      expect((await f.db.select().from(systemMenus).where(eq(systemMenus.id, 195)))[0].access).toBe(0);
      const before = await snapshot();
      await expect(service(writer).save(0, ruleBody({ rule_name: '菜单撤权后禁止' }), ruleActor(104))).rejects.toThrow('权限');
      await expect(service(writer).save(10, ruleBody({ rule_name: '菜单撤权后编辑' }), ruleActor(104))).rejects.toThrow('权限');
      expect(await snapshot()).toEqual(before); expect(before.logs).toHaveLength(1);
    })));
  }, 60000);

  it('rolls back edit and audit when the original authenticated session expires during a proven731612 wait', async () => {
    const before = await snapshot();
    await login(true, writer => f.withPeer!(async blocker => {
      await blocker.exec('SELECT pg_advisory_lock(731612,0)');
      const actor = { ...ruleActor(), expiresAt: Math.ceil((Date.now() + 250) / 1000) };
      const edit = outcome(service(writer).save(10, ruleBody({ rule_name: '过期规格编辑' }), actor));
      try { await assertFenceWait(writer.pid, blocker.pid); await waitForFinanceClock(f.db, actor.expiresAt * 1000); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731612,0)'); }
      const result = await edit; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('过期');
      expect(await snapshot()).toEqual(before);
    }));
  }, 60000);

  it('preserves real SKU dimensions, prices, stock and unique identities after template edit/delete and saves an already-copied template afterward', async () => {
    const options = await product(f.db).editorOptions();
    const template = options.sku_rule_templates.find(row => row.id === 10);
    expect(template).toBeDefined();
    const dimensions = structuredClone(template!.dimensions);
    expect(dimensions).toHaveLength(2);
    const attrs = dimensions[0].detail.flatMap((first, a) => dimensions[1].detail.map((second, b) => ({
      suk: `${first},${second}`, detail: { [dimensions[0].value]: first, [dimensions[1].value]: second },
      price: 19.5 + a + b, cost: 8, ot_price: 30, vip_price: 17, stock: 4 + a + b,
    })));
    const body = { store_name: '真实复制规格商品', unit_name: '件', product_type: 0,
      spec_type: 1, items: dimensions, attrs, sku_rule_id: 10 };
    const saved = await product(f.db).save(0, body, productActor);
    expect(saved.sku_verified).toBe(true);
    const before = await productSnapshot(saved.id);
    expect(before.dimensions).toHaveLength(2); expect(before.values).toHaveLength(4); expect(before.results).toHaveLength(1);
    expect(new Set(before.values.map(row => row.unique)).size).toBe(4);
    expect(before.values.every(row => row.unique.length === 8 && row.stock > 0 && Number(row.price) > 0)).toBe(true);
    await login(true, async writer => {
      await service(writer).save(10, ruleBody({ rule_name: '规格模板已改维度',
        spec: [{ value: '材质', detail: ['钢'] }] }), ruleActor());
      expect(await productSnapshot(saved.id)).toEqual(before);
      await remove(writer); expect(await rule()).toBeUndefined();
      expect(await productSnapshot(saved.id)).toEqual(before);
    });
    // These are the editor's already-copied items/attrs. Actual save succeeds
    // after deletion; no product rule FK or binding lock is part of this contract.
    const copied = await product(f.db).save(0, { ...body, store_name: '模板删除后复制商品' }, productActor);
    expect(copied.sku_verified).toBe(true);
    const afterCopy = await productSnapshot(copied.id);
    expect(afterCopy.dimensions.map(row => ({ name: row.attrName, values: row.attrValues })))
      .toEqual(before.dimensions.map(row => ({ name: row.attrName, values: row.attrValues })));
    expect(afterCopy.values.map(row => ({ suk: row.suk, price: row.price, stock: row.stock })))
      .toEqual(before.values.map(row => ({ suk: row.suk, price: row.price, stock: row.stock })));
    expect(await productSnapshot(saved.id)).toEqual(before);
    expect(await rule()).toBeUndefined();
    expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row => row.type))
      .toEqual(['product', 'product_rule_catalog', 'product_rule_catalog', 'product']);
  }, 60000);
});
