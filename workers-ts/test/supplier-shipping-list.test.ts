import { describe, expect, it } from 'vitest';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { shippingTemplates } from '../src/models/schema';
import { SupplierShippingTemplateService } from '../src/services/supplier/SupplierShippingTemplateService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const read = (db: DbClient, query: Record<string, string> = {}, supplierId = 20) =>
  new SupplierShippingTemplateService(createContainerFromDb(db)).list(supplierId, query);

describe('supplier shipping list contract', () => {
  it('preserves paging, full count, tie ordering and empty-page count', async () => {
    const f = await financePostgres([shippingTemplates]);
    try {
      await f.exec("INSERT INTO shipping_templates(id,name,owner_type,relation_id,sort) SELECT n,'模板-'||n,2,20,0 FROM generate_series(1,105) n");
      const first = await read(f.db);
      expect(first.count).toBe(105);
      expect(first.data.map(row => row.id)).toEqual(Array.from({ length: 15 }, (_, i) => 105 - i));
      const second = await read(f.db, { page: '2', limit: '100' });
      expect(second.count).toBe(105);
      expect(second.data.map(row => row.id)).toEqual([5, 4, 3, 2, 1]);
      expect(await read(f.db, { page: '1000000', limit: '100' })).toEqual({ data: [], count: 105 });
      expect(await read(f.db, {}, 40)).toEqual({ data: [], count: 0 });
    } finally { await f.close(); }
  });

  it('preserves owner/deletion scope, disabled templates, PHP labels and Shanghai timestamps', async () => {
    const f = await financePostgres([shippingTemplates]);
    try {
      await f.exec(`INSERT INTO shipping_templates(id,name,owner_type,relation_id,type,appoint,sort,status,is_del,add_time) VALUES
        (1,'件',2,20,1,0,9,1,0,0),(2,'重',2,20,2,1,9,0,0,123),
        (3,'体',2,20,3,0,-2,1,0,0),(4,'未知',2,20,9,2,-3,1,0,0),
        (5,'平台',0,20,1,0,100,1,0,0),(6,'别家',2,40,1,0,100,1,0,0),
        (7,'删除',2,20,1,0,100,1,1,0)`);
      expect(await read(f.db)).toEqual({ count: 4, data: [
        { id: 2, name: '重', type: '按重量', appoint: '开启', sort: 9, add_time: '1970-01-01 08:02:03' },
        { id: 1, name: '件', type: '按件数', appoint: '关闭', sort: 9, add_time: '1970-01-01 08:00:00' },
        { id: 3, name: '体', type: '按体积', appoint: '关闭', sort: -2, add_time: '1970-01-01 08:00:00' },
        { id: 4, name: '未知', type: '', appoint: '关闭', sort: -3, add_time: '1970-01-01 08:00:00' },
      ] });
    } finally { await f.close(); }
  });

  it('preserves case-insensitive trimmed LIKE filters and binds SQL-looking input as data', async () => {
    const f = await financePostgres([shippingTemplates]);
    try {
      await f.db.insert(shippingTemplates).values([
        { id: 1, name: 'AbC甲', ownerType: 2, relationId: 20 },
        { id: 2, name: "' OR 1=1 --", ownerType: 2, relationId: 20 },
        { id: 3, name: 'abc乙', ownerType: 2, relationId: 40 },
      ]);
      expect((await read(f.db, { name: '  abc  ' })).data.map(row => row.id)).toEqual([1]);
      expect((await read(f.db, { name: 'Ab_甲' })).count).toBe(1);
      expect((await read(f.db, { name: '%' })).count).toBe(2);
      expect((await read(f.db, { name: "' OR 1=1 --" })).data.map(row => row.id)).toEqual([2]);
      expect(await read(f.db, { name: '不存在' })).toEqual({ data: [], count: 0 });
    } finally { await f.close(); }
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('supplier shipping real PostgreSQL list snapshot', () => {
  it.each([
    ['insert', "INSERT INTO qa_real_templates(id,name,owner_type,relation_id) VALUES(11,'原模板新增',2,20)", 2],
    ['retire', 'UPDATE qa_real_templates SET is_del=1 WHERE id=10', 0],
    ['reassign', 'UPDATE qa_real_templates SET relation_id=40 WHERE id=10', 0],
    ['rename outside filter', "UPDATE qa_real_templates SET name='新名称' WHERE id=10", 0],
  ] as const)('does not combine old rows with a later count after concurrent %s', async (_label, mutation, nextCount) => {
    const f = await financePostgres([shippingTemplates]);
    try {
      await f.db.insert(shippingTemplates).values({ id: 10, name: '原模板', ownerType: 2, relationId: 20 });
      const before = await read(f.db, { name: '原模板' });
      // Only this disposable database uses the blocking view. The real service and
      // independent PostgreSQL backends still execute the queries without mocks.
      await f.exec(`ALTER TABLE shipping_templates RENAME TO qa_real_templates;
        CREATE FUNCTION qa_hold_supplier_name(value text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
          BEGIN PERFORM pg_advisory_xact_lock(731644,1); RETURN value; END $$;
        CREATE VIEW shipping_templates AS SELECT id,qa_hold_supplier_name(name) AS name,
          owner_type,relation_id,type,appoint,no_delivery,sort,status,is_del,add_time FROM qa_real_templates`);
      await withFinancePeers(f.db, async ([holder, reader, writer]) => {
        await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731644,1)');
        const pending = outcome(read(reader.db, { name: '原模板' }));
        try {
          await waitForFinanceBlock(f.db, reader.pid, holder.pid);
          await writer.exec(mutation);
        } finally { await holder.exec('ROLLBACK'); }
        const result = await pending;
        if (!result.ok) throw result.error;
        expect(result.value).toEqual(before);
      });
      expect((await read(f.db, { name: '原模板' })).count).toBe(nextCount);
    } finally { await f.close(); }
  }, 30000);
});
