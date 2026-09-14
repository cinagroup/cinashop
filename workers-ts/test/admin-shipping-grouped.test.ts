import { describe, expect, it } from 'vitest';
import { createAdminShippingFixture, shippingAdminApp } from './helpers/adminShippingFixture';
import { createContainerFromDb } from '../src/lib/di';
import { detailAdminShippingTemplate, readAdminShippingSnapshot } from '../src/services/admin/AdminShippingTemplateSnapshot';
import { withFinancePeers, waitForFinanceBlock, outcome } from './helpers/financePeers';
import { saveAdminShippingTemplate } from '../src/services/admin/AdminShippingTemplateService';

const form = { id: 0, name: '分组模板', type: 3, status: 1, sort: 2, appoint: 1, no_delivery: 1,
  region_info: [{ city_ids: [[0]], first: '1.50', first_price: '6.25', continue: '2', continue_price: '3' }],
  appoint_info: [{ city_ids: [[101, 102]], number: '2', price: '99' }],
  no_delivery_info: [{ city_ids: [[101, 103]] }] };
async function send(f: Awaited<ReturnType<typeof createAdminShippingFixture>>, body: unknown) {
  const response = await shippingAdminApp(f.db).request('/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), 'X-Shipping-Creation-Scope': 'v1:0:0:7' }, body: JSON.stringify(body) });
  return response.json() as Promise<{ status: number; msg: string; data: { id: number } | null }>;
}
// Each case creates and tears down its own real database; retain the existing
// 5s statement / 2s lock limits inside business transactions.
describe('admin complete shipping rule contract', { timeout: 30000 }, () => {
  async function setup() {
    const f = await createAdminShippingFixture();
    try {
      await f.exec("INSERT INTO system_city(city_id,parent_id,name) VALUES (101,0,'省'),(102,101,'市A'),(103,101,'市B')");
      const result = await send(f, form);
      expect(result.status).toBe(200);
      return { f, id: result.data!.id };
    } catch (e) { await f.close(); throw e; }
  }
  it('reads all groups and replaces them with a matching baseline while preserving ownership and creation time', async () => {
    const { f, id } = await setup();
    try {
      await f.exec(`UPDATE shipping_templates SET owner_type=2,relation_id=20,add_time=123 WHERE id=${id}`);
      const detail = await detailAdminShippingTemplate(createContainerFromDb(f.db), id);
      expect(detail.formData).toMatchObject({ id, type: 3, appoint: 1, no_delivery: 1 });
      expect(detail.appoint_info[0]).toMatchObject({ city_ids: [[101,102]], number: '2.00' });
      const result = await send(f, { ...form, id, expectedRevision: detail.revision, name: '新名', type: 2 });
      expect(result.status, result.msg).toBe(200);
      const after = await f.snapshot();
      expect(after.templates.find(t => t.id === id)).toMatchObject({ type: 2, ownerType: 2, relationId: 20, addTime: 123 });
      expect(after.regions.filter(t => t.templateId === id).every(t => t.billingGroup === 2)).toBe(true);
      expect(after.free.filter(t => t.tempId === id).every(t => t.billingGroup === 2)).toBe(true);
      expect((await readAdminShippingSnapshot(f.db,id)).revision).not.toBe(detail.revision);
    } finally { await f.close(); }
  });
  it.each(['parent','region','free','noDelivery'] as const)('rejects a changed %s baseline without modifying any table', async kind => {
    const { f, id } = await setup();
    try {
      const { revision } = await readAdminShippingSnapshot(f.db,id);
      const edits = { parent: `UPDATE shipping_templates SET name='late' WHERE id=${id}`, region: `UPDATE shipping_templates_region SET first_price=9 WHERE template_id=${id}`,
        free: `UPDATE shipping_templates_free SET price=999 WHERE temp_id=${id}`, noDelivery: `DELETE FROM shipping_templates_no_delivery WHERE temp_id=${id}` };
      await f.exec(edits[kind]); const before = await f.snapshot();
      expect(await send(f,{...form,id,expectedRevision:revision})).toMatchObject({status:400,msg:expect.stringContaining('其他操作修改')});
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.close(); }
  });
  it('rejects a fresh-revision flat form that would erase structured paths and group IDs', async () => {
    const { f, id } = await setup();
    try {
      const before = await f.snapshot(), { revision } = await readAdminShippingSnapshot(f.db,id);
      expect(await send(f,{id,expectedRevision:revision,regions:[]})).toMatchObject({status:400,msg:expect.stringContaining('旧区域表单')});
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.close(); }
  });
  it('clears disabled specialized rule sets only on an explicit complete save', async () => {
    const { f, id } = await setup();
    try {
      const { revision } = await readAdminShippingSnapshot(f.db,id);
      expect((await send(f,{...form,id,expectedRevision:revision,appoint:0,no_delivery:0,appoint_info:[],no_delivery_info:[]})).status).toBe(200);
      const after = await f.snapshot();
      expect(after.free.filter(r=>r.tempId===id)).toEqual([]); expect(after.noDelivery.filter(r=>r.tempId===id)).toEqual([]);
      expect(after.regions.filter(r=>r.templateId===id)).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('rolls back parent and all three child sets when the last insertion fails', async () => {
    const { f, id } = await setup();
    try {
      await f.exec("CREATE FUNCTION qa_group_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated final child failure'; END $$; CREATE TRIGGER qa_group_failure BEFORE INSERT ON shipping_templates_no_delivery FOR EACH ROW EXECUTE FUNCTION qa_group_failure()");
      const before = await f.snapshot(), { revision } = await readAdminShippingSnapshot(f.db,id);
      expect((await send(f,{...form,id,expectedRevision:revision,name:'must rollback'})).status).toBe(400);
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.close(); }
  });
  it('rejects malformed groups, invalid geography, flags and unknown fields without writes', async () => {
    const { f, id } = await setup();
    try {
      const before = await f.snapshot(), { revision } = await readAdminShippingSnapshot(f.db,id);
      for (const patch of [{region_info:[]},{region_info:[{...form.region_info[0],first:'0'}]},
        {region_info:[{...form.region_info[0],city_ids:[[false]]}]}, {region_info:[{...form.region_info[0],city_ids:[[0],[101,999]]}]},
        {appoint_info:[{...form.appoint_info[0],city_ids:[[102,101]]}]}, {appoint_info:[]}, {no_delivery_info:[]},
        {region_info:[{...form.region_info[0],city_ids:[[0],[0]]}]}, {appoint:true}, {status:false}, {ownerType:2}, {regions:[]},
        {id:null}, {status:null}, {appoint:null}, {sort:null}]) {
        expect((await send(f,{...form,id,expectedRevision:revision,...patch})).status).toBe(400);
        expect(await f.snapshot()).toEqual(before);
      }
    } finally { await f.close(); }
  });
  it('rejects heterogeneous or corrupt stored groups rather than picking their last value', async () => {
    const { f, id } = await setup();
    try {
      await f.exec(`INSERT INTO shipping_templates_region(template_id,province_id,region_id,value,uniqid,first_price) SELECT template_id,101,102,'[101,102]',uniqid,99 FROM shipping_templates_region WHERE template_id=${id}`);
      await expect(detailAdminShippingTemplate(createContainerFromDb(f.db),id)).rejects.toThrow('同组');
      await f.exec(`UPDATE shipping_templates_region SET value='[102]' WHERE template_id=${id}`);
      await expect(detailAdminShippingTemplate(createContainerFromDb(f.db),id)).rejects.toThrow('地区ID不一致');
    } finally { await f.close(); }
  });
  it('refuses a bounded overflow instead of returning an editable truncated set', async () => {
    const { f, id } = await setup();
    try {
      await f.exec(`INSERT INTO shipping_templates_no_delivery(temp_id) SELECT ${id} FROM generate_series(1,1000)`);
      await expect(readAdminShippingSnapshot(f.db,id)).rejects.toThrow('超过1000');
    } finally { await f.close(); }
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('checks the baseline again after a real parent lock wait', async () => {
    const { f, id } = await setup();
    try {
      const { revision } = await readAdminShippingSnapshot(f.db,id);
      await withFinancePeers(f.db,async([holder,writer])=>{
        await holder.exec(`BEGIN; UPDATE shipping_templates_free SET price=777 WHERE temp_id=${id}; SELECT id FROM shipping_templates WHERE id=${id} FOR NO KEY UPDATE`);
        const pending = outcome(saveAdminShippingTemplate(createContainerFromDb(writer.db),{...form,id,expectedRevision:revision}));
        try { await waitForFinanceBlock(f.db,writer.pid,holder.pid); } finally { await holder.exec('COMMIT'); }
        expect(await pending).toMatchObject({ok:false,error:{message:expect.stringContaining('其他操作修改')}});
      });
      expect((await f.snapshot()).free.find(r=>r.tempId===id)?.price).toBe('777.00');
    } finally { await f.close(); }
  },30000);
  it('saves all three rule sets instead of silently ignoring grouped PHP fields', async () => {
    const f = await createAdminShippingFixture();
    try {
      await f.exec("INSERT INTO system_city(city_id,parent_id,name) VALUES (101,0,'省'),(102,101,'市A'),(103,101,'市B')");
      const result = await send(f, form);
      expect(result.status, result.msg).toBe(200);
      const after = await f.snapshot(), id = result.data!.id;
      expect(after.templates.find(t => t.id === id)).toMatchObject({ type: 3, appoint: 1, noDelivery: 1 });
      expect(after.regions.filter(r => r.templateId === id)).toMatchObject([{ value: '[0]', firstPrice: '6.25', billingGroup: 3 }]);
      expect(after.free.filter(r => r.tempId === id)).toMatchObject([{ value: '[101,102]', number: '2.00', price: '99.00', billingGroup: 3 }]);
      expect(after.noDelivery.filter(r => r.tempId === id)).toMatchObject([{ value: '[101,103]' }]);
    } finally { await f.close(); }
  });
  it('rejects an old edit without a baseline instead of overwriting newer state', async () => {
    const f = await createAdminShippingFixture();
    try {
      const before = await f.snapshot();
      const result = await send(f, { id: 10, name: '陈旧表单' });
      expect(result.status).toBe(400);
      expect(result.msg).toContain('重新打开');
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.close(); }
  });
});
