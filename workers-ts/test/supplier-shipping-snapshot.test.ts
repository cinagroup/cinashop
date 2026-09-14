import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { detailAdminShippingTemplate, readAdminShippingSnapshot } from '../src/services/admin/AdminShippingTemplateSnapshot';
import { SupplierShippingTemplateService } from '../src/services/supplier/SupplierShippingTemplateService';
import { createAdminShippingFixture, postShipping } from './helpers/adminShippingFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const input = () => ({ name: '供应商完整更新', type: 1, appoint: 0, no_delivery: 0, sort: 2,
  region_info: [{ city_ids: [[0]], first: '1', first_price: '7', continue: '1', continue_price: '2' }],
  appoint_info: [], no_delivery_info: [] });
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('supplier shipping snapshot and optimistic edit on PG16', () => {
  let f: Awaited<ReturnType<typeof createAdminShippingFixture>>;
  let service: SupplierShippingTemplateService;
  beforeEach(async () => {
    f = await createAdminShippingFixture();
    await f.exec(`UPDATE shipping_templates SET owner_type=2,relation_id=20 WHERE id=10;
      UPDATE shipping_templates_region SET value='[0]';
      UPDATE shipping_templates_free SET province_id=101,value='[101]';
      UPDATE shipping_templates_no_delivery SET province_id=102,value='[102]';`);
    service = new SupplierShippingTemplateService(createContainerFromDb(f.db));
  }, 30000);
  afterEach(async () => { await f?.close(); });
  it('returns the same four-table revision as Admin, and fresh edits advance it', async () => {
    const detail = await service.detail(20, 10);
    const admin = await detailAdminShippingTemplate(createContainerFromDb(f.db), 10);
    expect(detail).toMatchObject({ revision: admin.revision, formData: { name: '原模板' } });
    await service.save(20, 10, { ...input(), expectedRevision: admin.revision });
    const fresh = await service.detail(20, 10);
    expect(fresh).toMatchObject({ revision: expect.stringMatching(/^shipping-v1:[a-f0-9]{64}$/), formData: { name: input().name } });
    expect(fresh).not.toMatchObject({ revision: admin.revision });
  });
  for (const revision of [undefined, '', 'old', 'shipping-v1:' + 'z'.repeat(64)]) it(`rejects missing or malformed baseline ${String(revision)}`, async () => {
    const before = await f.snapshot();
    await expect(service.save(20, 10, { ...input(), expectedRevision: revision })).rejects.toThrow('编辑版本');
    expect(await f.snapshot()).toEqual(before);
  });
  it('keeps creation available without a baseline', async () => {
    const id = await service.save(20, 0, input(), { actorId: 27, requestKey: crypto.randomUUID() });
    expect(id).toBeGreaterThan(0);
    expect(await service.detail(20, id)).toMatchObject({ revision: expect.stringMatching(/^shipping-v1:/), formData: { name: input().name } });
  });
  for (const table of ['shipping_templates', 'shipping_templates_region', 'shipping_templates_free', 'shipping_templates_no_delivery']) it(`rejects stale ${table} facts without replacing any rows`, async () => {
    const { revision } = await readAdminShippingSnapshot(f.db, 10);
    const mutation = table === 'shipping_templates' ? "UPDATE shipping_templates SET sort=8 WHERE id=10"
      : table === 'shipping_templates_region' ? "UPDATE shipping_templates_region SET first_price='8.00'"
      : table === 'shipping_templates_free' ? "UPDATE shipping_templates_free SET price='80.00'"
      : "UPDATE shipping_templates_no_delivery SET uniqid='changed'";
    await f.exec(mutation); const before = await f.snapshot();
    await expect(service.save(20, 10, { ...input(), expectedRevision: revision })).rejects.toThrow('其他操作修改');
    expect(await f.snapshot()).toEqual(before);
  });
  for (const supplierId of [30, 0, -1, 2147483648]) it(`does not expose another owner or accept invalid identity ${supplierId}`, async () => {
    await expect(service.detail(supplierId, 10)).rejects.toThrow();
  });
  it('rejects malformed stored paths and inconsistent grouped fees, without silently choosing the last row', async () => {
    await f.exec("UPDATE shipping_templates_free SET value='[999]'");
    await expect(service.detail(20, 10)).rejects.toThrow('地区');
    await f.exec("UPDATE shipping_templates_free SET value='[101]'; UPDATE shipping_templates_region SET uniqid='same'; INSERT INTO shipping_templates_region(template_id,province_id,region_id,value,uniqid,first_price) VALUES(10,101,101,'[101]','same','9.00')");
    await expect(service.detail(20, 10)).rejects.toThrow('同组');
  });
  it('fails closed when a rule table exceeds the complete-read cap', async () => {
    await f.exec("INSERT INTO shipping_templates_no_delivery(temp_id,province_id,city_id,value) SELECT 10,n,n,'['||n||']' FROM generate_series(1000,2000) n");
    await expect(service.detail(20, 10)).rejects.toThrow('1000');
  });
  it('rechecks the baseline after waiting for the supplier advisory lock', async () => {
    const { revision } = await readAdminShippingSnapshot(f.db, 10);
    await withFinancePeers(f.db, async ([holder, writer]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731604,20)');
      const pending = outcome(new SupplierShippingTemplateService(createContainerFromDb(writer.db)).save(20, 10, { ...input(), expectedRevision: revision }));
      await waitForFinanceBlock(f.db, writer.pid, holder.pid);
      expect((await postShipping(f.db, { id: 10, name: '后台较新版本' })).status).toBe(200);
      const newer = await f.snapshot(); await holder.exec('COMMIT');
      expect(await pending).toMatchObject({ ok: false });
      expect(await f.snapshot()).toEqual(newer);
    });
  }, 15000);
  it('bounds lock waits, preserves stricter session settings and rolls back unchanged', async () => {
    const { revision } = await readAdminShippingSnapshot(f.db, 10); const before = await f.snapshot();
    await withFinancePeers(f.db, async ([holder, writer]) => {
      await writer.exec("SET statement_timeout='3500ms'; SET lock_timeout='120ms'; SET idle_in_transaction_session_timeout='2500ms'");
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731604,20)');
      await expect(new SupplierShippingTemplateService(createContainerFromDb(writer.db)).save(20, 10, { ...input(), expectedRevision: revision })).rejects.toThrow('正在更新');
      await holder.exec('ROLLBACK');
      expect(await writer.exec("SELECT current_setting('lock_timeout') AS value")).toEqual([{ value: '120ms' }]);
    });
    expect(await f.snapshot()).toEqual(before);
  }, 15000);
  it('reads one MVCC snapshot while all four tables change on an independent connection', async () => {
    const before = await service.detail(20, 10);
    await f.exec("ALTER TABLE shipping_templates RENAME TO qa_real_templates; CREATE FUNCTION qa_hold_template(value text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_advisory_xact_lock(731649,1); RETURN value; END $$; CREATE VIEW shipping_templates AS SELECT id,qa_hold_template(name) AS name,owner_type,relation_id,type,appoint,no_delivery,sort,status,is_del,add_time FROM qa_real_templates");
    await withFinancePeers(f.db, async ([holder, reader, writer]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731649,1)');
      const pending = outcome(new SupplierShippingTemplateService(createContainerFromDb(reader.db)).detail(20, 10));
      try {
        await waitForFinanceBlock(f.db, reader.pid, holder.pid);
        await writer.exec("BEGIN; UPDATE qa_real_templates SET name='独立提交新模板' WHERE id=10; UPDATE shipping_templates_region SET first_price='8.00'; UPDATE shipping_templates_free SET price='88.00'; UPDATE shipping_templates_no_delivery SET uniqid='new'; COMMIT");
      } finally { await holder.exec('ROLLBACK'); }
      expect(await pending).toEqual({ ok: true, value: before });
    });
    const after = await service.detail(20, 10);
    expect(after.formData.name).toBe('独立提交新模板');
    expect(after.templateList[0].first_price).toBe('8.00');
    expect(after.appointList[0].price).toBe('88.00');
    expect(after.revision).not.toBe(before.revision);
  }, 15000);
  it('rejects an edit when the owner changed while waiting for its parent lock', async () => {
    const { revision } = await readAdminShippingSnapshot(f.db, 10);
    await withFinancePeers(f.db, async ([holder, writer]) => {
      await holder.exec('BEGIN; UPDATE shipping_templates SET relation_id=30 WHERE id=10');
      const pending = outcome(new SupplierShippingTemplateService(createContainerFromDb(writer.db)).save(20, 10, { ...input(), expectedRevision: revision }));
      await waitForFinanceBlock(f.db, writer.pid, holder.pid); await holder.exec('COMMIT');
      const changed = await f.snapshot();
      expect(await pending).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining('不属于当前供应商') }) });
      expect(await f.snapshot()).toEqual(changed);
    });
  }, 15000);
  it('refuses repeatable-read writers rather than validating an old snapshot after a lock wait', async () => {
    const { revision } = await readAdminShippingSnapshot(f.db, 10), before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer]) => {
      await writer.exec("SET default_transaction_isolation='repeatable read'");
      await expect(new SupplierShippingTemplateService(createContainerFromDb(writer.db)).save(20,10,{...input(),expectedRevision:revision})).rejects.toThrow('READ COMMITTED');
    });
    expect(await f.snapshot()).toEqual(before);
  });
  it('allows only one of two simultaneous supplier forms to replace the four-table snapshot', async () => {
    const { revision } = await readAdminShippingSnapshot(f.db, 10);
    await f.exec("CREATE FUNCTION qa_hold_supplier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731649,2); RETURN NEW; END $$; CREATE TRIGGER qa_hold_supplier BEFORE INSERT ON shipping_templates_region FOR EACH ROW EXECUTE FUNCTION qa_hold_supplier()");
    await withFinancePeers(f.db, async ([holder, first, second]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731649,2)');
      const a = outcome(new SupplierShippingTemplateService(createContainerFromDb(first.db)).save(20,10,{...input(),expectedRevision:revision}));
      await waitForFinanceBlock(f.db, first.pid, holder.pid);
      const b = outcome(new SupplierShippingTemplateService(createContainerFromDb(second.db)).save(20,10,{...input(),name:'不应覆盖的第二份表单',expectedRevision:revision}));
      await waitForFinanceBlock(f.db, second.pid, first.pid); await holder.exec('COMMIT');
      expect(await a).toEqual({ok:true,value:10});
      expect(await b).toMatchObject({ok:false,error:expect.objectContaining({message:expect.stringContaining('其他操作修改')})});
    });
    expect((await f.snapshot()).templates[0].name).toBe(input().name);
  },15000);
});
