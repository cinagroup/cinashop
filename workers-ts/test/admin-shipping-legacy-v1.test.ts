import { describe, expect, it } from 'vitest';
import { createAdminShippingFixture, shippingAdminApp } from './helpers/adminShippingFixture';
import { createContainerFromDb } from '../src/lib/di';
import { detailAdminShippingTemplate, readAdminShippingSnapshot } from '../src/services/admin/AdminShippingTemplateSnapshot';

const groupedForm = {
  id: 0, name: '旧 V1 包邮模板', type: 3, status: 1, sort: 2, appoint: 1, no_delivery: 1,
  region_info: [
    { city_ids: [[0]], first: '1.50', first_price: '6.25', continue: '2', continue_price: '3' },
    { city_ids: [[101, 102]], first: '1.50', first_price: '8', continue: '2', continue_price: '4' },
  ],
  appoint_info: [{ city_ids: [[101, 102]], number: '2', price: '99' }],
  no_delivery_info: [{ city_ids: [[101, 103]] }],
};

async function send(f: Awaited<ReturnType<typeof createAdminShippingFixture>>, body: unknown) {
  const response = await shippingAdminApp(f.db).request('/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), 'X-Shipping-Creation-Scope': 'v1:0:0:7' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ status: number; msg: string; data: { id: number } | null }>;
}

describe('PHP V1 shipping rows with default province metadata', { timeout: 30000 }, () => {
  async function setup() {
    const f = await createAdminShippingFixture();
    try {
      await f.exec("INSERT INTO system_city(city_id,parent_id,name) VALUES (101,0,'省'),(102,101,'市A'),(103,101,'市B')");
      const result = await send(f, groupedForm);
      expect(result.status, result.msg).toBe(200);
      const id = result.data!.id;
      // All three PHP V1 writers recorded JSON paths/endpoints and left province_id at SQL default 0.
      await f.exec(`UPDATE shipping_templates_region SET province_id=0 WHERE template_id=${id} AND region_id=102`);
      await f.exec(`UPDATE shipping_templates_free SET province_id=0 WHERE temp_id=${id}`);
      await f.exec(`UPDATE shipping_templates_no_delivery SET province_id=0 WHERE temp_id=${id}`);
      return { f, id };
    } catch (error) { await f.close(); throw error; }
  }

  it('projects the valid path on read without changing raw rows, then canonicalizes only on an explicit revisioned save', async () => {
    const { f, id } = await setup();
    try {
      const before = await f.snapshot();
      const rawRevision = (await readAdminShippingSnapshot(f.db, id)).revision;
      expect(before.regions.find(row => row.templateId === id && row.regionId === 102)).toMatchObject({ provinceId: 0, value: '[101,102]' });
      expect(before.free.find(row => row.tempId === id)).toMatchObject({ provinceId: 0, cityId: 102, value: '[101,102]' });
      expect(before.noDelivery.find(row => row.tempId === id)).toMatchObject({ provinceId: 0, cityId: 103, value: '[101,103]' });

      const detail = await detailAdminShippingTemplate(createContainerFromDb(f.db), id);
      expect(detail.revision).toBe(rawRevision);
      expect(detail.region_info.find(row => (row.city_ids as number[][]).some(path => path.at(-1) === 102))).toMatchObject({ province_id: 101, city_ids: [[101, 102]] });
      expect(detail.appoint_info[0]).toMatchObject({ province_id: 101, city_ids: [[101, 102]] });
      expect(detail.no_delivery_info[0]).toMatchObject({ province_id: 101, city_ids: [[101, 103]] });
      expect(await f.snapshot()).toEqual(before);
      expect((await readAdminShippingSnapshot(f.db, id)).revision).toBe(rawRevision);

      const saved = await send(f, { ...groupedForm, id, expectedRevision: detail.revision });
      expect(saved.status, saved.msg).toBe(200);
      const after = await f.snapshot();
      expect(after.regions.find(row => row.templateId === id && row.regionId === 102)).toMatchObject({ provinceId: 101, value: '[101,102]' });
      expect(after.free.find(row => row.tempId === id)).toMatchObject({ provinceId: 101, cityId: 102, value: '[101,102]' });
      expect(after.noDelivery.find(row => row.tempId === id)).toMatchObject({ provinceId: 101, cityId: 103, value: '[101,103]' });
      expect((await readAdminShippingSnapshot(f.db, id)).revision).not.toBe(rawRevision);
    } finally { await f.close(); }
  });

  it('still rejects wrong nonzero province, wrong endpoint, damaged JSON and paths absent from city authority', async () => {
    const { f, id } = await setup();
    try {
      const cases = [
        { set: "province_id=999", message: '地区ID不一致' },
        { set: "province_id=0,city_id=103", message: '地区ID不一致' },
        { set: "province_id=0,city_id=102,value='[101,102'", message: '路径缺失或损坏' },
        { set: "province_id=0,city_id=999,value='[101,999]'", message: '所选地区不存在或已失效' },
        { set: "province_id=0,city_id=102,value='[103,102]'", message: '所选地区层级关系无效' },
      ];
      for (const { set, message } of cases) {
        await f.exec(`UPDATE shipping_templates_free SET province_id=0,city_id=102,value='[101,102]' WHERE temp_id=${id}`);
        await f.exec(`UPDATE shipping_templates_free SET ${set} WHERE temp_id=${id}`);
        const before = await f.snapshot();
        await expect(detailAdminShippingTemplate(createContainerFromDb(f.db), id)).rejects.toThrow(message);
        expect(await f.snapshot()).toEqual(before);
      }
    } finally { await f.close(); }
  });
});
