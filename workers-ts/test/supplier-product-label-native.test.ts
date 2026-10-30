import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import { storeProduct, storeProductLabel, storeProductRelation, systemRole, systemAdmin, systemLog } from '@/models/schema';
import { SupplierProductLabelService } from '@/services/supplier/SupplierProductLabelService';
import { assertSupplierProductLabelBindings, replaceSupplierProductLabelBindings } from '@/services/supplier/SupplierProductLabelBindings';
import { supplierLabelActor, supplierLabelBody, supplierProductLabelFixture } from './helpers/supplierProductLabels';
import type { SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof supplierProductLabelFixture>>;
type Login = SequenceRunnerPeer & { role: string };
function code(error: unknown): string {
  for (let i = 0; i < 6 && error && typeof error === 'object'; i++) { if ('code' in error) return String(error.code); error = 'cause' in error ? error.cause : null; } return '';
}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier label independent PG16 LOGIN and real product binding protocol', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native Supplier label fixture forbids external I/O')); f = await supplierProductLabelFixture();
    if (f.format !== 'pg16' || !f.withPeer || !f.withBusiness) throw Error('Independent owned PG16 peers are required');
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const service = (peer: SequenceRunnerPeer) => new SupplierProductLabelService(createContainerFromDb(peer.db));
  async function login<T>(write: boolean, run: (peer: Login) => Promise<T>) {
    // Narrow regression LOGIN only; the new runtime suite separately proves
    // the whole commissioned App profile. No direct label DML or aux read grant.
    return f.withBusiness(write, async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe native Supplier label role');
      const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid }); expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return run(peer);
    });
  }
  it('completes create/edit/delete with only category and menu lock-column privileges', async () => {
    await login(true, async peer => {
      const [privileges] = await peer.exec("SELECT has_column_privilege(current_user,'category','id','UPDATE') AS category_lock,has_column_privilege(current_user,'category','name','UPDATE') AS category_write,has_column_privilege(current_user,'system_menus','api_url','UPDATE') AS menu_write");
      expect(privileges).toEqual({ category_lock: true, category_write: false, menu_write: false });
      const created = await service(peer).save(20, 0, supplierLabelBody(), supplierLabelActor());
      await service(peer).save(20, created.id, supplierLabelBody({ label_name: '原生名称编辑' }), supplierLabelActor());
      await service(peer).delete(20, created.id, undefined, supplierLabelActor());
      expect((await f.db.select().from(systemLog).orderBy(systemLog.id)).map(row => row.method)).toEqual(['POST', 'POST', 'DELETE']);
    });
  });
  it('supports SELECT-only catalog/form reads and refuses writes without lock capability with zero effects', async () => {
    await login(false, async peer => {
      expect((await service(peer).catalog(20, new URLSearchParams(), supplierLabelActor())).count).toBe(5);
      expect((await service(peer).form(20, new URLSearchParams(), supplierLabelActor())).rules[0].options.map(row => row.value)).toEqual([10, 11]);
      const before = await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id);
      const error = await service(peer).save(20, 0, supplierLabelBody(), supplierLabelActor()).then(() => null, error => error);
      expect(code(error)).toBe('42501'); expect(await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id)).toEqual(before); expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });
  it('serializes two real same-owner creations and commits one exact label and audit', async () => {
    await login(true, peer => f.withPeer!(async writer => {
      const results = await Promise.allSettled([service(peer).save(20, 0, supplierLabelBody(), supplierLabelActor()), service(writer).save(20, 0, supplierLabelBody(), supplierLabelActor())]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.labelName, '供应商新增标签'))).toHaveLength(1); expect(await f.db.select().from(systemLog)).toHaveLength(1);
    }));
  });
  it('lets the actual product binding commit first and then refuses deletion of its CSV and type3 references', async () => {
    await login(true, peer => f.withPeer!(async deleter => {
      await withTx(createContainerFromDb(peer.db), async tx => {
        await assertSupplierProductLabelBindings(tx, 20, [201]);
        await expect(service(deleter).delete(20, 201, undefined, supplierLabelActor())).rejects.toMatchObject({ code: 409 });
        await replaceSupplierProductLabelBindings(tx, 20, 80, [201]);
      });
      await expect(service(deleter).delete(20, 201, undefined, supplierLabelActor())).rejects.toThrow('引用');
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 80)))[0]).toMatchObject({ storeLabelId: '201', price: '19.99' });
      expect(await f.db.select().from(storeProductRelation)).toMatchObject([{ productId: 80, type: 3, relationId: 201, relationPid: 0, status: 1 }]);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    }));
  });
  it('pins deletion to commit and the actual label binding refuses both the busy row and its later absence', async () => {
    await f.exec("CREATE FUNCTION hold_supplier_label_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731738,0); RETURN NEW; END $$; CREATE TRIGGER hold_supplier_label_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION hold_supplier_label_audit()");
    await login(true, peer => f.withPeer!(async blocker => f.withPeer!(async writer => {
      await blocker.exec('SELECT pg_advisory_lock(731738,0)'); const operation = outcome(service(peer).delete(20, 201, undefined, supplierLabelActor()));
      try {
        await waitForFinanceBlock(f.db, peer.pid, blocker.pid);
        await expect(withTx(createContainerFromDb(writer.db), tx => assertSupplierProductLabelBindings(tx, 20, [201]))).rejects.toSatisfy((error: unknown) => code(error) === '55P03');
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731738,0)'); expect((await operation).ok).toBe(true); }
      await expect(withTx(createContainerFromDb(writer.db), tx => replaceSupplierProductLabelBindings(tx, 20, 80, [201]))).rejects.toThrow('不存在');
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 80)))[0].storeLabelId).toBeNull(); expect(await f.db.select().from(storeProductRelation)).toEqual([]);
    })));
  });
  it('holds the real current role through commit and rejects the next request after authority withdrawal', async () => {
    await f.exec("CREATE FUNCTION hold_supplier_label_authority() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731738,1); RETURN NEW; END $$; CREATE TRIGGER hold_supplier_label_authority BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION hold_supplier_label_authority()");
    await login(true, peer => f.withPeer!(async blocker => f.withPeer!(async revoker => {
      await blocker.exec('SELECT pg_advisory_lock(731738,1)'); const operation = outcome(service(peer).save(20, 0, supplierLabelBody(), supplierLabelActor()));
      try { await waitForFinanceBlock(f.db, peer.pid, blocker.pid); await expect(revoker.exec('SELECT id FROM system_role WHERE id=21 FOR UPDATE NOWAIT')).rejects.toMatchObject({ code: '55P03' }); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731738,1)'); expect((await operation).ok).toBe(true); }
      await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21));
      await expect(service(peer).save(20, 0, supplierLabelBody({ label_name: '撤权后拒绝' }), supplierLabelActor())).rejects.toMatchObject({ code: 400011 });
      expect(await f.db.select().from(systemLog)).toHaveLength(1);
    })));
  });
  it('rechecks password claims after a request waited outside its Supplier catalog scope', async () => {
    await login(true, peer => f.withPeer!(async blocker => {
      await blocker.exec('SELECT pg_advisory_lock(731737,20)'); const operation = outcome(service(peer).save(20, 0, supplierLabelBody(), supplierLabelActor()));
      try { await waitForFinanceBlock(f.db, peer.pid, blocker.pid); await f.db.update(systemAdmin).set({ pwd: 'rotated' }).where(eq(systemAdmin.id, 21)); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731737,20)'); }
      const result = await operation; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toMatchObject({ code: 410001 }); expect(await f.db.select().from(systemLog)).toEqual([]);
    }));
  });
  it('does not block another Supplier behind a held catalog scope and keeps its new label in its own realm', async () => {
    await login(true, peer => f.withPeer!(async blocker => {
      await blocker.exec('SELECT pg_advisory_lock(731737,20)');
      try { const created = await service(peer).save(30, 0, supplierLabelBody({ label_name: '其他供应商独立创建' }), supplierLabelActor(31));
        expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id, created.id)))[0]).toMatchObject({ type: 2, relationId: 30, labelCate: 10 }); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731737,20)'); }
    }));
  });
  it('rolls back deletion when an actual audit trigger introduces a dangling reference after the first check', async () => {
    await f.exec("CREATE FUNCTION audit_supplier_label_reference() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN INSERT INTO store_product_relation(product_id,type,relation_id) VALUES(80,3,201); RETURN NEW; END $$; REVOKE ALL ON FUNCTION audit_supplier_label_reference() FROM PUBLIC; CREATE TRIGGER audit_supplier_label_reference BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION audit_supplier_label_reference()");
    await login(true, async peer => {
      await expect(service(peer).delete(20, 201, undefined, supplierLabelActor())).rejects.toThrow('引用');
      expect(await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id, 201))).toHaveLength(1);
      expect(await f.db.select().from(storeProductRelation)).toEqual([]); expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });
});
